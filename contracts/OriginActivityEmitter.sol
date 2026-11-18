// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title OriginActivityEmitter
 * @notice Emits origin-chain oracle price deviation telemetry on Base Sepolia / Unichain Sepolia.
 *         Subscribed to by SentinelReactive on Reactive Network (~1s finality).
 */
contract OriginActivityEmitter is Ownable {
    event OraclePriceDeviation(
        address indexed asset,
        uint256 indexed deviationBps,
        uint256 currentPrice,
        uint256 baselinePrice,
        uint256 timestamp
    );

    event ProtocolRiskAlert(
        address indexed vault,
        uint256 indexed severity,
        bytes32 detailHash,
        uint256 timestamp
    );

    error ZeroBaselinePrice();

    constructor(address initialOwner_) Ownable(initialOwner_) {}

    /**
     * @notice Reports an oracle price update and emits its deviation in basis points (10000 = 100%).
     */
    function reportOraclePrice(
        address asset_,
        uint256 currentPrice_,
        uint256 baselinePrice_
    ) external returns (uint256 deviationBps) {
        if (baselinePrice_ == 0) {
            revert ZeroBaselinePrice();
        }
        uint256 diff = currentPrice_ >= baselinePrice_
            ? currentPrice_ - baselinePrice_
            : baselinePrice_ - currentPrice_;
        deviationBps = (diff * 10_000) / baselinePrice_;

        emit OraclePriceDeviation(
            asset_,
            deviationBps,
            currentPrice_,
            baselinePrice_,
            block.timestamp
        );
    }

    /**
     * @notice Emits an operator/protocol risk alert log for off-vault telemetry.
     */
    function emitRiskAlert(
        address vault_,
        uint256 severity_,
        bytes32 detailHash_
    ) external onlyOwner {
        emit ProtocolRiskAlert(vault_, severity_, detailHash_, block.timestamp);
    }
}
