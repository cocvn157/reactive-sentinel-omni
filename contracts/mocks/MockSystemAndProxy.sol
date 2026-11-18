// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "../reactive/interfaces/ISystemContract.sol";
import { IReactive } from "../reactive/interfaces/IReactive.sol";
import { IPayable } from "../reactive/interfaces/IPayable.sol";

/**
 * @title MockSystemContract
 * @notice Local Hardhat test harness simulating Reactive Network Omni's SystemContract (0x8888...8888).
 *         Records subscriptions, dispatches `react(LogRecord)` calls, and emits `CallbackRequest`
 *         events when `requestCallbackV_1_0` is invoked.
 */
contract MockSystemContract is ISystemContract {
    struct Subscription {
        address subscriber;
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
        bool active;
    }

    Subscription[] public subscriptions;
    CallbackConfiguration_V_1_0[] public callbackRequests;
    mapping(address => uint256) public debts;
    mapping(address => uint256) public reserves;

    event Subscribed(
        address indexed subscriber,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 topic0,
        uint256 topic1
    );
    event Unsubscribed(
        address indexed subscriber,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 topic0,
        uint256 topic1
    );
    event CallbackRequest(
        uint256 indexed chainId,
        address indexed sender,
        address indexed recipient,
        CallbackVersion version,
        bytes configuration
    );

    receive() external payable override {}

    function depositTo(address target_) external payable {
        reserves[target_] += msg.value;
    }

    function debt(address contract_) external view override returns (uint256) {
        return debts[contract_];
    }

    function setDebt(address contract_, uint256 amount_) external {
        debts[contract_] = amount_;
    }

    function subscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external override {
        subscriptions.push(
            Subscription({
                subscriber: msg.sender,
                chainId: chainId_,
                contractAddress: contract_,
                topic0: topic0_,
                topic1: topic1_,
                topic2: topic2_,
                topic3: topic3_,
                active: true
            })
        );
        emit Subscribed(msg.sender, chainId_, contract_, topic0_, topic1_);
    }

    function unsubscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external override {
        for (uint256 i = 0; i < subscriptions.length; i++) {
            Subscription storage s = subscriptions[i];
            if (
                s.active &&
                s.subscriber == msg.sender &&
                s.chainId == chainId_ &&
                s.contractAddress == contract_ &&
                s.topic0 == topic0_ &&
                s.topic1 == topic1_ &&
                s.topic2 == topic2_ &&
                s.topic3 == topic3_
            ) {
                s.active = false;
            }
        }
        emit Unsubscribed(msg.sender, chainId_, contract_, topic0_, topic1_);
    }

    function requestCallback(CallbackVersion version_, bytes memory config_) external override {
        if (version_ == CallbackVersion.V_1_0) {
            CallbackConfiguration_V_1_0 memory cfg = abi.decode(config_, (CallbackConfiguration_V_1_0));
            callbackRequests.push(cfg);
            emit CallbackRequest(cfg.chainId, msg.sender, cfg.recipient, version_, config_);
        }
    }

    function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config_) external override {
        callbackRequests.push(config_);
        emit CallbackRequest(
            config_.chainId,
            msg.sender,
            config_.recipient,
            CallbackVersion.V_1_0,
            abi.encode(config_)
        );
    }

    function dispatchReact(address reactiveContract_, IReactive.LogRecord calldata log_) external {
        IReactive(payable(reactiveContract_)).react(log_);
    }

    function getSubscriptionCount() external view returns (uint256) {
        return subscriptions.length;
    }

    function getCallbackRequestCount() external view returns (uint256) {
        return callbackRequests.length;
    }

    function getCallbackRequest(uint256 index_) external view returns (CallbackConfiguration_V_1_0 memory) {
        return callbackRequests[index_];
    }
}

/**
 * @title MockCallbackProxy
 * @notice Local Hardhat test harness simulating Reactive Network's destination Callback Proxy.
 *         Overwrites the first 32-byte argument word (after 4-byte selector) with `reactiveSender_`
 *         to mirror the exact production Reactive Signer -> Callback Proxy behavior.
 */
contract MockCallbackProxy is IPayable {
    mapping(address => uint256) public debts;
    mapping(address => uint256) public reserves;

    event CallbackDelivered(address indexed recipient, address indexed reactiveSender, bool success);

    receive() external payable override {}

    function debt(address contract_) external view override returns (uint256) {
        return debts[contract_];
    }

    function deliverCallback(
        address recipient_,
        address reactiveSender_,
        bytes memory payload_
    ) external returns (bool success, bytes memory returnData) {
        require(payload_.length >= 36, "Payload missing selector+sender slot");
        // Overwrite bytes [4..36] (first ABI address argument) with reactiveSender_, matching Reactive Proxy.
        bytes32 encodedSender = bytes32(uint256(uint160(reactiveSender_)));
        assembly {
            mstore(add(payload_, 36), encodedSender)
        }
        (success, returnData) = recipient_.call(payload_);
        emit CallbackDelivered(recipient_, reactiveSender_, success);
    }
}
