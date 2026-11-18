// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { ISystemContract } from "./reactive/interfaces/ISystemContract.sol";
import { IReactive } from "./reactive/interfaces/IReactive.sol";
import { AbstractReactive } from "./reactive/base/AbstractReactive.sol";

/**
 * @title SentinelReactive
 * @notice Autonomous cross-chain risk sentinel deployed on Reactive Network Omni (~1s CometBFT finality).
 *         Subscribes to origin-chain ERC-20 Transfer / Approval logs (filtered by vault address in topic1)
 *         and OraclePriceDeviation events, maintains sliding-window cumulative outflow velocity state,
 *         and dispatches authenticated `requestCallbackV_1_0` emergency freezes to ProtectedTreasury.
 */
contract SentinelReactive is AbstractReactive, Ownable {
    uint256 public constant REASON_SINGLE_TX_OUTFLOW = 1;
    uint256 public constant REASON_VELOCITY_BREACH = 2;
    uint256 public constant REASON_SUSPICIOUS_APPROVAL = 3;
    uint256 public constant REASON_ORACLE_DEVIATION = 4;

    uint64 public constant MIN_CALLBACK_GAS_LIMIT = 150_000;
    uint64 public constant DEFAULT_CALLBACK_GAS_LIMIT = 500_000;

    /// @dev keccak256("Transfer(address,address,uint256)")
    uint256 public constant ERC20_TRANSFER_TOPIC0 =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    /// @dev keccak256("Approval(address,address,uint256)")
    uint256 public constant ERC20_APPROVAL_TOPIC0 =
        0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925;

    /// @dev keccak256("OraclePriceDeviation(address,uint256,uint256,uint256,uint256)")
    uint256 public constant ORACLE_DEVIATION_TOPIC0 =
        uint256(keccak256("OraclePriceDeviation(address,uint256,uint256,uint256,uint256)"));

    struct VaultPolicy {
        bool active;
        uint256 originChainId;
        uint256 destinationChainId;
        address vault;
        uint256 singleTxThreshold;
        uint256 windowOutflowThreshold;
        uint256 windowSeconds;
        uint256 maxApprovalThreshold;
        uint256 maxOracleDeviationBps;
        uint64 cooldownSeconds;
        uint64 callbackGasLimit;
    }

    struct VelocityState {
        uint256 windowStart;
        uint256 windowOutflow;
        uint256 lastTripTimestamp;
        uint256 totalTrips;
        uint256 totalEventsProcessed;
    }

    mapping(bytes32 vaultKey => VaultPolicy) public policies;
    mapping(bytes32 vaultKey => VelocityState) public velocityStates;
    mapping(bytes32 vaultKey => mapping(address spender => bool)) public whitelistedSpenders;
    mapping(uint256 originChainId => mapping(address asset => bytes32[])) private _assetToVaultKeys;
    mapping(bytes32 vaultKey => mapping(address asset => bool)) private _vaultWatchesAsset;

    bytes32[] public registeredVaultKeys;

    event VaultPolicyRegistered(
        bytes32 indexed vaultKey,
        uint256 indexed originChainId,
        uint256 indexed destinationChainId,
        address vault
    );
    event VaultPolicyUpdated(bytes32 indexed vaultKey, bool active);
    event TokenSubscriptionAdded(bytes32 indexed vaultKey, uint256 indexed originChainId, address indexed token);
    event OracleSubscriptionAdded(
        bytes32 indexed vaultKey,
        uint256 indexed originChainId,
        address emitter,
        address indexed asset
    );
    event SpenderWhitelistUpdated(bytes32 indexed vaultKey, address indexed spender, bool allowed);
    event TelemetryProcessed(
        bytes32 indexed vaultKey,
        uint256 indexed topic0,
        uint256 amountOrMetric,
        uint256 windowOutflow
    );
    event CircuitBreakerTriggered(
        bytes32 indexed vaultKey,
        uint256 indexed destinationChainId,
        address indexed vault,
        uint256 reasonCode,
        uint256 observedValue,
        bytes32 originTxHash
    );
    event CooldownSuppressed(bytes32 indexed vaultKey, uint256 reasonCode, uint256 nextAllowedAt);

    error ZeroAddress();
    error InvalidChainId();
    error InvalidGasLimit(uint64 provided, uint64 minimum);
    error VaultNotRegistered(bytes32 vaultKey);
    error InvalidWindow();

    constructor(address initialOwner_) payable Ownable(initialOwner_) {}

    function getVaultKey(uint256 originChainId_, address vault_) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(originChainId_, vault_));
    }

    function getRegisteredVaultCount() external view returns (uint256) {
        return registeredVaultKeys.length;
    }

    /**
     * @notice Registers a vault policy and optionally subscribes immediately to a primary token
     *         (Transfer + Approval) and oracle emitter.
     */
    function registerVaultAndSubscribe(
        VaultPolicy calldata policy_,
        address primaryToken_,
        address oracleEmitter_
    ) external onlyOwner {
        if (policy_.vault == address(0)) revert ZeroAddress();
        if (policy_.originChainId == 0 || policy_.destinationChainId == 0) revert InvalidChainId();
        if (policy_.windowSeconds == 0) revert InvalidWindow();

        uint64 gasLimit = policy_.callbackGasLimit == 0
            ? DEFAULT_CALLBACK_GAS_LIMIT
            : policy_.callbackGasLimit;
        if (gasLimit < MIN_CALLBACK_GAS_LIMIT) {
            revert InvalidGasLimit(gasLimit, MIN_CALLBACK_GAS_LIMIT);
        }

        bytes32 vaultKey = getVaultKey(policy_.originChainId, policy_.vault);
        bool isNew = policies[vaultKey].vault == address(0);

        policies[vaultKey] = VaultPolicy({
            active: policy_.active,
            originChainId: policy_.originChainId,
            destinationChainId: policy_.destinationChainId,
            vault: policy_.vault,
            singleTxThreshold: policy_.singleTxThreshold,
            windowOutflowThreshold: policy_.windowOutflowThreshold,
            windowSeconds: policy_.windowSeconds,
            maxApprovalThreshold: policy_.maxApprovalThreshold,
            maxOracleDeviationBps: policy_.maxOracleDeviationBps,
            cooldownSeconds: policy_.cooldownSeconds,
            callbackGasLimit: gasLimit
        });

        if (isNew) {
            registeredVaultKeys.push(vaultKey);
        }

        emit VaultPolicyRegistered(
            vaultKey,
            policy_.originChainId,
            policy_.destinationChainId,
            policy_.vault
        );

        if (primaryToken_ != address(0)) {
            _subscribeToken(vaultKey, policy_.originChainId, policy_.vault, primaryToken_);
            if (oracleEmitter_ != address(0)) {
                _subscribeOracle(vaultKey, policy_.originChainId, oracleEmitter_, primaryToken_);
            }
        }
    }

    /**
     * @notice Subscribes to ERC-20 Transfer and Approval logs originating from `vault` for an additional token.
     */
    function subscribeTokenForVault(
        uint256 originChainId_,
        address vault_,
        address token_
    ) external onlyOwner {
        if (token_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        bytes32 vaultKey = getVaultKey(originChainId_, vault_);
        if (policies[vaultKey].vault == address(0)) revert VaultNotRegistered(vaultKey);
        _subscribeToken(vaultKey, originChainId_, vault_, token_);
    }

    /**
     * @notice Subscribes to OraclePriceDeviation events for `asset_` from `oracleEmitter_`.
     */
    function subscribeOracleForVault(
        uint256 originChainId_,
        address vault_,
        address oracleEmitter_,
        address asset_
    ) external onlyOwner {
        if (oracleEmitter_ == address(0) || asset_ == address(0) || vault_ == address(0)) {
            revert ZeroAddress();
        }
        bytes32 vaultKey = getVaultKey(originChainId_, vault_);
        if (policies[vaultKey].vault == address(0)) revert VaultNotRegistered(vaultKey);
        _subscribeOracle(vaultKey, originChainId_, oracleEmitter_, asset_);
    }

    function updatePolicy(
        uint256 originChainId_,
        address vault_,
        bool active_,
        uint256 singleTxThreshold_,
        uint256 windowOutflowThreshold_,
        uint256 windowSeconds_,
        uint256 maxApprovalThreshold_,
        uint256 maxOracleDeviationBps_,
        uint64 cooldownSeconds_
    ) external onlyOwner {
        bytes32 vaultKey = getVaultKey(originChainId_, vault_);
        VaultPolicy storage pol = policies[vaultKey];
        if (pol.vault == address(0)) revert VaultNotRegistered(vaultKey);
        if (windowSeconds_ == 0) revert InvalidWindow();

        pol.active = active_;
        pol.singleTxThreshold = singleTxThreshold_;
        pol.windowOutflowThreshold = windowOutflowThreshold_;
        pol.windowSeconds = windowSeconds_;
        pol.maxApprovalThreshold = maxApprovalThreshold_;
        pol.maxOracleDeviationBps = maxOracleDeviationBps_;
        pol.cooldownSeconds = cooldownSeconds_;

        emit VaultPolicyUpdated(vaultKey, active_);
    }

    function setSpenderWhitelist(
        uint256 originChainId_,
        address vault_,
        address spender_,
        bool allowed_
    ) external onlyOwner {
        if (spender_ == address(0)) revert ZeroAddress();
        bytes32 vaultKey = getVaultKey(originChainId_, vault_);
        if (policies[vaultKey].vault == address(0)) revert VaultNotRegistered(vaultKey);
        whitelistedSpenders[vaultKey][spender_] = allowed_;
        emit SpenderWhitelistUpdated(vaultKey, spender_, allowed_);
    }

    function unsubscribeTokenForVault(
        uint256 originChainId_,
        address vault_,
        address token_
    ) external onlyOwner {
        uint256 vaultTopic = uint256(uint160(vault_));
        SYSTEM.unsubscribe(
            originChainId_,
            token_,
            ERC20_TRANSFER_TOPIC0,
            vaultTopic,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
        SYSTEM.unsubscribe(
            originChainId_,
            token_,
            ERC20_APPROVAL_TOPIC0,
            vaultTopic,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
    }

    /**
     * @inheritdoc IReactive
     * @dev Called exclusively by Reactive Network SYSTEM (`0x8888...8888`).
     *      Never reverts on unmatched or paused logs so the contract avoids ReactiveContractReverted penalties.
     */
    function react(LogRecord calldata log_) external override onlySystem {
        if (log_.opCode != 3) {
            return;
        }

        if (log_.topic0 == ERC20_TRANSFER_TOPIC0) {
            _handleTransferLog(log_);
        } else if (log_.topic0 == ERC20_APPROVAL_TOPIC0) {
            _handleApprovalLog(log_);
        } else if (log_.topic0 == ORACLE_DEVIATION_TOPIC0) {
            _handleOracleLog(log_);
        }
    }

    function _handleTransferLog(LogRecord calldata log_) internal {
        address from = address(uint160(log_.topic1));
        bytes32 vaultKey = getVaultKey(log_.chainId, from);
        VaultPolicy storage pol = policies[vaultKey];
        if (!pol.active || log_.data.length < 32) {
            return;
        }

        uint256 amount = abi.decode(log_.data, (uint256));
        if (amount == 0) {
            return;
        }

        VelocityState storage st = velocityStates[vaultKey];
        if (st.windowStart == 0 || block.timestamp > st.windowStart + pol.windowSeconds) {
            st.windowStart = block.timestamp;
            st.windowOutflow = amount;
        } else {
            st.windowOutflow += amount;
        }
        st.totalEventsProcessed += 1;

        emit TelemetryProcessed(vaultKey, ERC20_TRANSFER_TOPIC0, amount, st.windowOutflow);

        if (pol.singleTxThreshold > 0 && amount >= pol.singleTxThreshold) {
            _tryTripVault(vaultKey, pol, st, REASON_SINGLE_TX_OUTFLOW, amount, bytes32(log_.txHash));
        } else if (pol.windowOutflowThreshold > 0 && st.windowOutflow >= pol.windowOutflowThreshold) {
            _tryTripVault(
                vaultKey,
                pol,
                st,
                REASON_VELOCITY_BREACH,
                st.windowOutflow,
                bytes32(log_.txHash)
            );
        }
    }

    function _handleApprovalLog(LogRecord calldata log_) internal {
        address ownerAddr = address(uint160(log_.topic1));
        address spender = address(uint160(log_.topic2));
        bytes32 vaultKey = getVaultKey(log_.chainId, ownerAddr);
        VaultPolicy storage pol = policies[vaultKey];
        if (!pol.active || whitelistedSpenders[vaultKey][spender] || log_.data.length < 32) {
            return;
        }

        uint256 allowanceValue = abi.decode(log_.data, (uint256));
        VelocityState storage st = velocityStates[vaultKey];
        st.totalEventsProcessed += 1;

        emit TelemetryProcessed(vaultKey, ERC20_APPROVAL_TOPIC0, allowanceValue, st.windowOutflow);

        if (pol.maxApprovalThreshold > 0 && allowanceValue >= pol.maxApprovalThreshold) {
            _tryTripVault(
                vaultKey,
                pol,
                st,
                REASON_SUSPICIOUS_APPROVAL,
                allowanceValue,
                bytes32(log_.txHash)
            );
        }
    }

    function _handleOracleLog(LogRecord calldata log_) internal {
        address asset = address(uint160(log_.topic1));
        uint256 deviationBps = log_.topic2;
        bytes32[] storage linkedVaults = _assetToVaultKeys[log_.chainId][asset];

        for (uint256 i = 0; i < linkedVaults.length; i++) {
            bytes32 vaultKey = linkedVaults[i];
            VaultPolicy storage pol = policies[vaultKey];
            if (!pol.active) {
                continue;
            }
            VelocityState storage st = velocityStates[vaultKey];
            st.totalEventsProcessed += 1;
            emit TelemetryProcessed(vaultKey, ORACLE_DEVIATION_TOPIC0, deviationBps, st.windowOutflow);

            if (pol.maxOracleDeviationBps > 0 && deviationBps >= pol.maxOracleDeviationBps) {
                _tryTripVault(
                    vaultKey,
                    pol,
                    st,
                    REASON_ORACLE_DEVIATION,
                    deviationBps,
                    bytes32(log_.txHash)
                );
            }
        }
    }

    function _tryTripVault(
        bytes32 vaultKey_,
        VaultPolicy storage pol_,
        VelocityState storage st_,
        uint256 reasonCode_,
        uint256 observedValue_,
        bytes32 originTxHash_
    ) internal {
        if (st_.lastTripTimestamp != 0 && block.timestamp < st_.lastTripTimestamp + pol_.cooldownSeconds) {
            emit CooldownSuppressed(vaultKey_, reasonCode_, st_.lastTripTimestamp + pol_.cooldownSeconds);
            return;
        }

        st_.lastTripTimestamp = block.timestamp;
        st_.totalTrips += 1;

        emit CircuitBreakerTriggered(
            vaultKey_,
            pol_.destinationChainId,
            pol_.vault,
            reasonCode_,
            observedValue_,
            originTxHash_
        );

        // Slot 0 MUST be address(0); Reactive Network replaces the first 160 bits with address(this).
        bytes memory payload = abi.encodeWithSignature(
            "onSentinelTrip(address,uint256,uint256,bytes32)",
            address(0),
            reasonCode_,
            observedValue_,
            originTxHash_
        );

        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: pol_.destinationChainId,
                recipient: pol_.vault,
                gasLimit: pol_.callbackGasLimit,
                payload: payload
            })
        );
    }

    function _subscribeToken(
        bytes32 vaultKey_,
        uint256 originChainId_,
        address vault_,
        address token_
    ) internal {
        uint256 vaultTopic = uint256(uint160(vault_));
        SYSTEM.subscribe(
            originChainId_,
            token_,
            ERC20_TRANSFER_TOPIC0,
            vaultTopic,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
        SYSTEM.subscribe(
            originChainId_,
            token_,
            ERC20_APPROVAL_TOPIC0,
            vaultTopic,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
        emit TokenSubscriptionAdded(vaultKey_, originChainId_, token_);
    }

    function _subscribeOracle(
        bytes32 vaultKey_,
        uint256 originChainId_,
        address oracleEmitter_,
        address asset_
    ) internal {
        if (!_vaultWatchesAsset[vaultKey_][asset_]) {
            _vaultWatchesAsset[vaultKey_][asset_] = true;
            _assetToVaultKeys[originChainId_][asset_].push(vaultKey_);
        }
        SYSTEM.subscribe(
            originChainId_,
            oracleEmitter_,
            ORACLE_DEVIATION_TOPIC0,
            uint256(uint160(asset_)),
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
        emit OracleSubscriptionAdded(vaultKey_, originChainId_, oracleEmitter_, asset_);
    }

    /**
     * @notice Settles any outstanding debt to the Reactive System Contract from this contract's REACT balance.
     */
    function coverDebt() external {
        _coverDebt();
    }

    /**
     * @notice Withdraws surplus REACT held on this contract.
     */
    function withdrawSurplus(address payable to_, uint256 amount_) external onlyOwner {
        if (to_ == address(0)) revert ZeroAddress();
        (bool ok, ) = to_.call{ value: amount_ }("");
        require(ok, "Withdraw failed");
    }
}
