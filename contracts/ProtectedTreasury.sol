// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IPayable } from "./reactive/interfaces/IPayable.sol";
import { AbstractCallback } from "./reactive/base/AbstractCallback.sol";

/**
 * @title ProtectedTreasury
 * @notice Origin/Destination vault protected by Reactive Network Omni.
 *         Inherits AbstractCallback to cryptographically authenticate incoming emergency freeze
 *         callbacks via both `onlyServiceProvider` (Callback Proxy) and `onlyCallbackSender`
 *         (authorized SentinelReactive contract address injected into payload slot 0).
 */
contract ProtectedTreasury is AbstractCallback, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bool public frozen;
    uint256 public frozenAt;
    uint256 public lastReasonCode;
    uint256 public lastObservedValue;
    bytes32 public lastOriginTxHash;
    uint256 public tripCount;

    address public guardianOperator;
    address public emergencyRecoveryAddress;

    event TokenDeposited(address indexed token, address indexed sender, uint256 amount);
    event TokenWithdrawn(address indexed token, address indexed caller, address indexed to, uint256 amount);
    event SpenderApproved(address indexed token, address indexed caller, address indexed spender, uint256 amount);
    event EmergencyFrozen(
        address indexed reactiveSender,
        uint256 indexed reasonCode,
        uint256 observedValue,
        bytes32 originTxHash,
        uint256 timestamp
    );
    event VaultUnfrozen(address indexed owner, uint256 timestamp);
    event EmergencyRecovered(address indexed token, address indexed to, uint256 amount);
    event GuardianOperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event RecoveryAddressUpdated(address indexed previousRecovery, address indexed newRecovery);

    error VaultFrozen(uint256 reasonCode, uint256 frozenAt);
    error UnauthorizedCaller(address caller);
    error ZeroAddress();
    error ZeroAmount();

    modifier whenNotFrozen() {
        if (frozen) {
            revert VaultFrozen(lastReasonCode, frozenAt);
        }
        _;
    }

    modifier onlyOwnerOrOperator() {
        if (msg.sender != owner() && (guardianOperator == address(0) || msg.sender != guardianOperator)) {
            revert UnauthorizedCaller(msg.sender);
        }
        _;
    }

    /**
     * @param callbackProxy_ Official Reactive Callback Proxy on this destination chain.
     * @param callbackSender_ Deployed SentinelReactive address on Reactive Network.
     * @param initialOwner_ Cold owner address allowed to unfreeze & recover funds.
     * @param guardianOperator_ Optional hot operator key for day-to-day treasury actions.
     * @param recoveryAddress_ Default cold destination for emergency fund sweeps.
     */
    constructor(
        IPayable callbackProxy_,
        address callbackSender_,
        address initialOwner_,
        address guardianOperator_,
        address recoveryAddress_
    ) payable AbstractCallback(callbackProxy_, callbackSender_) Ownable(initialOwner_) {
        if (address(callbackProxy_) == address(0) || callbackSender_ == address(0)) {
            revert ZeroAddress();
        }
        guardianOperator = guardianOperator_;
        emergencyRecoveryAddress = recoveryAddress_ == address(0) ? initialOwner_ : recoveryAddress_;
    }

    /**
     * @notice Deposits ERC-20 tokens into the protected treasury.
     */
    function depositToken(address token_, uint256 amount_) external nonReentrant {
        if (token_ == address(0)) revert ZeroAddress();
        if (amount_ == 0) revert ZeroAmount();
        IERC20(token_).safeTransferFrom(msg.sender, address(this), amount_);
        emit TokenDeposited(token_, msg.sender, amount_);
    }

    /**
     * @notice Transfers ERC-20 tokens out of the vault. Blocked immediately once frozen.
     *         The emitted ERC-20 Transfer(vault, to_, amount_) is monitored by SentinelReactive.
     */
    function withdrawToken(
        address token_,
        address to_,
        uint256 amount_
    ) external onlyOwnerOrOperator whenNotFrozen nonReentrant {
        if (token_ == address(0) || to_ == address(0)) revert ZeroAddress();
        if (amount_ == 0) revert ZeroAmount();
        IERC20(token_).safeTransfer(to_, amount_);
        emit TokenWithdrawn(token_, msg.sender, to_, amount_);
    }

    /**
     * @notice Approves an external spender. Blocked immediately once frozen.
     *         The emitted ERC-20 Approval(vault, spender_, amount_) is monitored by SentinelReactive.
     */
    function approveSpender(
        address token_,
        address spender_,
        uint256 amount_
    ) external onlyOwnerOrOperator whenNotFrozen nonReentrant {
        if (token_ == address(0) || spender_ == address(0)) revert ZeroAddress();
        IERC20(token_).forceApprove(spender_, amount_);
        emit SpenderApproved(token_, msg.sender, spender_, amount_);
    }

    /**
     * @notice Autonomous circuit-breaker callback invoked by Reactive Network via Callback Proxy.
     * @dev Reactive Network overwrites the first 160 bits of payload with the requesting
     *      SentinelReactive contract address (`reactive_`). Both `onlyServiceProvider` and
     *      `onlyCallbackSender` are enforced so neither direct callers nor rogue RCs can spoof a freeze.
     */
    function onSentinelTrip(
        address reactive_,
        uint256 reasonCode_,
        uint256 observedValue_,
        bytes32 originTxHash_
    ) external onlyServiceProvider onlyCallbackSender(reactive_) {
        frozen = true;
        frozenAt = block.timestamp;
        lastReasonCode = reasonCode_;
        lastObservedValue = observedValue_;
        lastOriginTxHash = originTxHash_;
        tripCount += 1;

        emit EmergencyFrozen(reactive_, reasonCode_, observedValue_, originTxHash_, block.timestamp);
    }

    /**
     * @notice Allows the cold owner to manually lock the vault at any time.
     */
    function manualFreeze(uint256 reasonCode_) external onlyOwner {
        frozen = true;
        frozenAt = block.timestamp;
        lastReasonCode = reasonCode_;
        tripCount += 1;
        emit EmergencyFrozen(msg.sender, reasonCode_, 0, bytes32(0), block.timestamp);
    }

    /**
     * @notice Cold-owner unfreeze without moving assets.
     */
    function unfreezeOnly() external onlyOwner {
        frozen = false;
        emit VaultUnfrozen(msg.sender, block.timestamp);
    }

    /**
     * @notice Cold-owner unfreeze and atomic rescue sweep of protected tokens.
     * @param token_ ERC-20 token to sweep (or address(0) to only unfreeze).
     * @param to_ Recipient address (defaults to emergencyRecoveryAddress if address(0)).
     * @param amount_ Amount to sweep, or type(uint256).max for full vault balance.
     */
    function unfreezeAndRecover(
        address token_,
        address to_,
        uint256 amount_
    ) external onlyOwner nonReentrant {
        frozen = false;
        emit VaultUnfrozen(msg.sender, block.timestamp);

        if (token_ != address(0)) {
            address recipient = to_ == address(0) ? emergencyRecoveryAddress : to_;
            if (recipient == address(0)) revert ZeroAddress();

            uint256 balance = IERC20(token_).balanceOf(address(this));
            uint256 sweepAmount = amount_ == type(uint256).max ? balance : amount_;
            if (sweepAmount > 0) {
                IERC20(token_).safeTransfer(recipient, sweepAmount);
                emit EmergencyRecovered(token_, recipient, sweepAmount);
            }
        }
    }

    function setGuardianOperator(address newOperator_) external onlyOwner {
        address prev = guardianOperator;
        guardianOperator = newOperator_;
        emit GuardianOperatorUpdated(prev, newOperator_);
    }

    function setEmergencyRecoveryAddress(address newRecovery_) external onlyOwner {
        if (newRecovery_ == address(0)) revert ZeroAddress();
        address prev = emergencyRecoveryAddress;
        emergencyRecoveryAddress = newRecovery_;
        emit RecoveryAddressUpdated(prev, newRecovery_);
    }

    /**
     * @notice Settles any outstanding callback proxy debt from the contract's native ETH balance.
     */
    function coverDebt() external {
        _coverDebt();
    }
}
