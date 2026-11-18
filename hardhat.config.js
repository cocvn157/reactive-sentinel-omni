require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.29",
    settings: {
      evmVersion: "paris",
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    reactiveLasna: {
      url: process.env.REACTIVE_LASNA_RPC || "https://lasna-rpc.rnk.dev/",
      chainId: 5318007,
      accounts: PRIVATE_KEY,
    },
    reactiveMainnet: {
      url: process.env.REACTIVE_MAINNET_RPC || "https://mainnet-rpc.rnk.dev/",
      chainId: 1597,
      accounts: PRIVATE_KEY,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      chainId: 84532,
      accounts: PRIVATE_KEY,
    },
    unichainSepolia: {
      url: process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org",
      chainId: 1301,
      accounts: PRIVATE_KEY,
    },
    ethereumSepolia: {
      url: process.env.ETHEREUM_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: PRIVATE_KEY,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
