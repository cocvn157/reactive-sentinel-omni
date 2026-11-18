const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  console.log(`Deploying SentinelReactive on chain ${network.name} (${network.chainId})...`);
  console.log(`Deployer: ${deployer.address}`);

  const fundAmount = hre.ethers.parseEther(process.env.REACTIVE_FUND_REACT || "0.2");
  const Sentinel = await hre.ethers.getContractFactory("SentinelReactive");
  const sentinel = await Sentinel.deploy(deployer.address, { value: fundAmount });
  await sentinel.waitForDeployment();

  const addr = await sentinel.getAddress();
  console.log(`SentinelReactive deployed at: ${addr}`);
  console.log(`Funded with ${hre.ethers.formatEther(fundAmount)} lREACT/REACT`);
  console.log("\nNext step: set SENTINEL_REACTIVE_ADDRESS=" + addr + " in .env and deploy ProtectedTreasury on origin/destination chain(s).");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
