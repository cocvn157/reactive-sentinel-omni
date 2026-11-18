const hre = require("hardhat");

const CALLBACK_PROXIES = {
  84532: "0x476F44b11F5C942c58f4c8E3d0300E5710743585", // Base Sepolia
  1301: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",  // Unichain Sepolia
  11155111: "0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4", // Ethereum Sepolia
};

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  const callbackProxy = process.env.CALLBACK_PROXY_ADDRESS || CALLBACK_PROXIES[chainId];
  const sentinelAddress = process.env.SENTINEL_REACTIVE_ADDRESS;
  if (!callbackProxy) {
    throw new Error(`No default Callback Proxy for chainId ${chainId}. Set CALLBACK_PROXY_ADDRESS in .env.`);
  }
  if (!sentinelAddress) {
    throw new Error("SENTINEL_REACTIVE_ADDRESS is required in .env (deploy SentinelReactive first).");
  }

  console.log(`Deploying Origin/Destination stack on chainId ${chainId}...`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Callback Proxy: ${callbackProxy}`);
  console.log(`Authorized SentinelReactive: ${sentinelAddress}`);

  const Token = await hre.ethers.getContractFactory("MockOriginToken");
  const token = await Token.deploy(
    "Mock Sentinel USD",
    "mUSDC",
    deployer.address,
    hre.ethers.parseEther("100000")
  );
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  const Emitter = await hre.ethers.getContractFactory("OriginActivityEmitter");
  const emitter = await Emitter.deploy(deployer.address);
  await emitter.waitForDeployment();
  const emitterAddr = await emitter.getAddress();

  const vaultFund = hre.ethers.parseEther(process.env.VAULT_CALLBACK_FUND_ETH || "0.02");
  const Treasury = await hre.ethers.getContractFactory("ProtectedTreasury");
  const treasury = await Treasury.deploy(
    callbackProxy,
    sentinelAddress,
    deployer.address,
    deployer.address,
    deployer.address,
    { value: vaultFund }
  );
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();

  // Seed vault with 10,000 mUSDC
  const approveTx = await token.approve(treasuryAddr, hre.ethers.parseEther("10000"));
  await approveTx.wait();
  const depositTx = await treasury.depositToken(tokenAddr, hre.ethers.parseEther("10000"));
  await depositTx.wait();

  console.log("\n=== Deployed Origin/Destination Contracts ===");
  console.log(`MockOriginToken (mUSDC):   ${tokenAddr}`);
  console.log(`OriginActivityEmitter:     ${emitterAddr}`);
  console.log(`ProtectedTreasury (Vault): ${treasuryAddr}`);
  console.log(`Funded vault callback gas: ${hre.ethers.formatEther(vaultFund)} native ETH`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
