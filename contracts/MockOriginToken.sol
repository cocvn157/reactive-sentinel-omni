// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockOriginToken
 * @notice Testnet ERC-20 token deployed on origin chains (Base Sepolia / Unichain Sepolia)
 *         to demonstrate autonomous Reactive Sentinel protection against unauthorized drains and approvals.
 */
contract MockOriginToken is ERC20, Ownable {
    uint256 public constant MAX_FAUCET_MINT = 100_000 ether;

    error FaucetCapExceeded(uint256 requested, uint256 maxAllowed);

    constructor(
        string memory name_,
        string memory symbol_,
        address initialOwner_,
        uint256 initialSupply_
    ) ERC20(name_, symbol_) Ownable(initialOwner_) {
        if (initialSupply_ > 0) {
            _mint(initialOwner_, initialSupply_);
        }
    }

    /**
     * @notice Public testnet faucet mint capped at 100,000 tokens per call.
     */
    function faucetMint(address to_, uint256 amount_) external {
        if (amount_ > MAX_FAUCET_MINT) {
            revert FaucetCapExceeded(amount_, MAX_FAUCET_MINT);
        }
        _mint(to_, amount_);
    }

    /**
     * @notice Owner-only arbitrary mint for scripted scenarios.
     */
    function mint(address to_, uint256 amount_) external onlyOwner {
        _mint(to_, amount_);
    }
}
