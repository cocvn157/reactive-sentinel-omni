const hre = require("hardhat");

async function main() {
  const sentinelAddr = process.env.SENTINEL_REACTIVE_ADDRESS;
  const originChainId = BigInt(process.env.ORIGIN_CHAIN_ID || "84532");
  const destChainId = BigInt(process.env.DESTINATION_CHAIN_ID || originChainId.toString());
  const vaultAddr = process.env.ORIGIN_VAULT_ADDRESS || process.env.BASE_VAULT_ADDRESS;
  const tokenAddr = process.env.ORIGIN_TOKEN_ADDRESS || process.env.BASE_TOKEN_ADDRESS;
  const emitterAddr = process.env.ORIGIN_EMITTER_ADDRESS || process.env.BASE_EMITTER_ADDRESS;

  if (!sentinelAddr || !vaultAddr || !tokenAddr) {
    throw new Error("Set SENTINEL_REACTIVE_ADDRESS, ORIGIN_VAULT_ADDRESS, and ORIGIN_TOKEN_ADDRESS in .env");
  }

  const sentinel = await hre.ethers.getContractAt("SentinelReactive", sentinelAddr);

  const policy = {
    active: true,
    originChainId,
    destinationChainId: destChainId,
    vault: vaultAddr,
    singleTxThreshold: hre.ethers.parseEther(process.env.SINGLE_TX_THRESHOLD || "1000"),
    windowOutflowThreshold: hre.ethers.parseEther(process.env.WINDOW_OUTFLOW_THRESHOLD || "1500"),
    windowSeconds: BigInt(process.env.WINDOW_SECONDS || "120"),
    maxApprovalThreshold: hre.ethers.parseEther(process.env.MAX_APPROVAL_THRESHOLD || "2000"),
    maxOracleDeviationBps: BigInt(process.env.MAX_ORACLE_DEVIATION_BPS || "1000"),
    cooldownSeconds: BigInt(process.env.COOLDOWN_SECONDS || "60"),
    callbackGasLimit: BigInt(process.env.CALLBACK_GAS_LIMIT || "500000"),
  };

  console.log(`Wiring SentinelReactive (${sentinelAddr}) -> Vault (${vaultAddr}) on chain ${originChainId}...`);
  const tx = await sentinel.registerVaultAndSubscribe(
    policy,
    tokenAddr,
    emitterAddr || hre.ethers.ZeroAddress
  );
  const receipt = await tx.wait();
  console.log(`Policy registered & subscriptions live! Tx hash: ${receipt.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
