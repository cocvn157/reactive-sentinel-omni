const hre = require("hardhat");

const SYSTEM_CONTRACT_ADDRESS = "0x8888888888888888888888888888888888888888";

async function main() {
  const [owner, operator, attacker, recovery] = await hre.ethers.getSigners();
  console.log("=== Reactive Sentinel Omni: Local Full-Flow Breach Simulation ===");

  const MockSystemFactory = await hre.ethers.getContractFactory("MockSystemContract");
  const tempSystem = await MockSystemFactory.deploy();
  await tempSystem.waitForDeployment();
  const runtimeCode = await hre.ethers.provider.getCode(await tempSystem.getAddress());
  await hre.network.provider.send("hardhat_setCode", [SYSTEM_CONTRACT_ADDRESS, runtimeCode]);
  const systemContract = await hre.ethers.getContractAt("MockSystemContract", SYSTEM_CONTRACT_ADDRESS);

  const Sentinel = await hre.ethers.getContractFactory("SentinelReactive");
  const sentinel = await Sentinel.deploy(owner.address, { value: hre.ethers.parseEther("1") });
  await sentinel.waitForDeployment();

  const Proxy = await hre.ethers.getContractFactory("MockCallbackProxy");
  const proxy = await Proxy.deploy();
  await proxy.waitForDeployment();

  const Token = await hre.ethers.getContractFactory("MockOriginToken");
  const token = await Token.deploy("Mock Sentinel USD", "mUSDC", owner.address, hre.ethers.parseEther("50000"));
  await token.waitForDeployment();

  const Emitter = await hre.ethers.getContractFactory("OriginActivityEmitter");
  const emitter = await Emitter.deploy(owner.address);
  await emitter.waitForDeployment();

  const Treasury = await hre.ethers.getContractFactory("ProtectedTreasury");
  const treasury = await Treasury.deploy(
    await proxy.getAddress(),
    await sentinel.getAddress(),
    owner.address,
    operator.address,
    recovery.address,
    { value: hre.ethers.parseEther("0.1") }
  );
  await treasury.waitForDeployment();

  await token.approve(await treasury.getAddress(), hre.ethers.parseEther("10000"));
  await treasury.depositToken(await token.getAddress(), hre.ethers.parseEther("10000"));

  await sentinel.registerVaultAndSubscribe(
    {
      active: true,
      originChainId: 84532n,
      destinationChainId: 84532n,
      vault: await treasury.getAddress(),
      singleTxThreshold: hre.ethers.parseEther("1000"),
      windowOutflowThreshold: hre.ethers.parseEther("1500"),
      windowSeconds: 120n,
      maxApprovalThreshold: hre.ethers.parseEther("2000"),
      maxOracleDeviationBps: 1000n,
      cooldownSeconds: 60n,
      callbackGasLimit: 500000n,
    },
    await token.getAddress(),
    await emitter.getAddress()
  );

  console.log("1. Normal withdrawal of 250 mUSDC...");
  await treasury.connect(operator).withdrawToken(await token.getAddress(), owner.address, hre.ethers.parseEther("250"));

  console.log("2. Compromised operator initiates 1,500 mUSDC flash-drain...");
  const drainTx = await treasury
    .connect(operator)
    .withdrawToken(await token.getAddress(), attacker.address, hre.ethers.parseEther("1500"));
  const receipt = await drainTx.wait();

  const transferTopic = hre.ethers.id("Transfer(address,address,uint256)");
  const tokenAddrLower = (await token.getAddress()).toLowerCase();
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === tokenAddrLower && l.topics[0] === transferTopic
  );

  console.log("3. Reactive Network (~1s finality) processes Transfer log via react()...");
  await systemContract.dispatchReact(await sentinel.getAddress(), {
    chainId: 84532n,
    contractAddress: log.address,
    topic0: BigInt(log.topics[0]),
    topic1: BigInt(log.topics[1]),
    topic2: BigInt(log.topics[2]),
    topic3: 0n,
    data: log.data,
    blockNumber: BigInt(receipt.blockNumber),
    opCode: BigInt(log.topics.length),
    blockHash: BigInt(receipt.blockHash),
    txHash: BigInt(receipt.hash),
    logIndex: BigInt(log.index),
  });

  const cfg = await systemContract.getCallbackRequest(0);
  console.log(`4. CallbackRequest queued for chain ${cfg.chainId} -> recipient ${cfg.recipient}`);
  await proxy.deliverCallback(cfg.recipient, await sentinel.getAddress(), cfg.payload);

  console.log(`5. ProtectedTreasury frozen = ${await treasury.frozen()} (reasonCode = ${await treasury.lastReasonCode()})`);
  console.log("6. Cold owner executes unfreezeAndRecover() -> sweeping remaining 8,250 mUSDC to recovery wallet...");
  await treasury.connect(owner).unfreezeAndRecover(await token.getAddress(), recovery.address, hre.ethers.MaxUint256);
  console.log(`7. Recovery wallet mUSDC balance: ${hre.ethers.formatEther(await token.balanceOf(recovery.address))} mUSDC`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
