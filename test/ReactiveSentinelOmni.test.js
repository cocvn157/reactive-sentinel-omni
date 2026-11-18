const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const SYSTEM_CONTRACT_ADDRESS = "0x8888888888888888888888888888888888888888";
const BASE_SEPOLIA_CHAIN_ID = 84532n;
const UNICHAIN_SEPOLIA_CHAIN_ID = 1301n;

const REASON_SINGLE_TX_OUTFLOW = 1n;
const REASON_VELOCITY_BREACH = 2n;
const REASON_SUSPICIOUS_APPROVAL = 3n;
const REASON_ORACLE_DEVIATION = 4n;

describe("Reactive Sentinel Omni — End-to-End Circuit Breaker", function () {
  let owner, operator, attacker, dexRouter, recoveryWallet, user;
  let systemContract, callbackProxy, token, emitter, sentinel, treasury;

  function buildLogRecord(chainId, receipt, parsedLog) {
    const rawLog = parsedLog;
    const topics = rawLog.topics;
    return {
      chainId: BigInt(chainId),
      contractAddress: rawLog.address,
      topic0: BigInt(topics[0]),
      topic1: topics[1] ? BigInt(topics[1]) : 0n,
      topic2: topics[2] ? BigInt(topics[2]) : 0n,
      topic3: topics[3] ? BigInt(topics[3]) : 0n,
      data: rawLog.data,
      blockNumber: BigInt(receipt.blockNumber),
      opCode: BigInt(topics.length),
      blockHash: BigInt(receipt.blockHash),
      txHash: BigInt(receipt.hash),
      logIndex: BigInt(rawLog.index),
    };
  }

  async function relayLatestMatchingLog(originChainId, receipt, contractAddress, eventSignatureTopic) {
    const matching = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === contractAddress.toLowerCase() &&
        l.topics[0].toLowerCase() === eventSignatureTopic.toLowerCase()
    );
    expect(matching, "Expected origin log not found in receipt").to.not.be.undefined;
    const logRecord = buildLogRecord(originChainId, receipt, matching);
    const reactTx = await systemContract.dispatchReact(await sentinel.getAddress(), logRecord);
    return reactTx.wait();
  }

  async function deliverLatestCallbackToTreasury() {
    const count = await systemContract.getCallbackRequestCount();
    expect(count).to.be.gt(0n);
    const cfg = await systemContract.getCallbackRequest(count - 1n);
    const sentinelAddr = await sentinel.getAddress();
    const tx = await callbackProxy.deliverCallback(cfg.recipient, sentinelAddr, cfg.payload);
    return tx.wait();
  }

  async function deploySentinelFixture() {
    const [o, op, att, router, rec, u] = await ethers.getSigners();

    // 1. Deploy MockSystemContract and inject its runtime bytecode at 0x8888...8888
    const MockSystemFactory = await ethers.getContractFactory("MockSystemContract");
    const tempSystem = await MockSystemFactory.deploy();
    await tempSystem.waitForDeployment();
    const runtimeCode = await ethers.provider.getCode(await tempSystem.getAddress());
    await network.provider.send("hardhat_setCode", [SYSTEM_CONTRACT_ADDRESS, runtimeCode]);
    const sys = await ethers.getContractAt("MockSystemContract", SYSTEM_CONTRACT_ADDRESS);

    // 2. Deploy SentinelReactive on Reactive Network (funded with 1 REACT via payable constructor)
    const SentinelFactory = await ethers.getContractFactory("SentinelReactive");
    const s = await SentinelFactory.deploy(o.address, { value: ethers.parseEther("1") });
    await s.waitForDeployment();

    // 3. Deploy Origin/Destination stack
    const ProxyFactory = await ethers.getContractFactory("MockCallbackProxy");
    const proxy = await ProxyFactory.deploy();
    await proxy.waitForDeployment();

    const TokenFactory = await ethers.getContractFactory("MockOriginToken");
    const tok = await TokenFactory.deploy("Mock Sentinel USD", "mUSDC", o.address, ethers.parseEther("100000"));
    await tok.waitForDeployment();

    const EmitterFactory = await ethers.getContractFactory("OriginActivityEmitter");
    const em = await EmitterFactory.deploy(o.address);
    await em.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("ProtectedTreasury");
    const tr = await TreasuryFactory.deploy(
      await proxy.getAddress(),
      await s.getAddress(),
      o.address,
      op.address,
      rec.address,
      { value: ethers.parseEther("0.2") }
    );
    await tr.waitForDeployment();

    // 4. Fund ProtectedTreasury with 10,000 mUSDC
    await tok.connect(o).approve(await tr.getAddress(), ethers.parseEther("10000"));
    await tr.connect(o).depositToken(await tok.getAddress(), ethers.parseEther("10000"));

    // 5. Register ProtectedTreasury policy on SentinelReactive
    const policy = {
      active: true,
      originChainId: BASE_SEPOLIA_CHAIN_ID,
      destinationChainId: BASE_SEPOLIA_CHAIN_ID,
      vault: await tr.getAddress(),
      singleTxThreshold: ethers.parseEther("1000"),
      windowOutflowThreshold: ethers.parseEther("1500"),
      windowSeconds: 120n,
      maxApprovalThreshold: ethers.parseEther("2000"),
      maxOracleDeviationBps: 1000n,
      cooldownSeconds: 60n,
      callbackGasLimit: 500000n,
    };

    await s
      .connect(o)
      .registerVaultAndSubscribe(policy, await tok.getAddress(), await em.getAddress());

    return { o, op, att, router, rec, u, sys, proxy, tok, em, s, tr };
  }

  beforeEach(async function () {
    const f = await loadFixture(deploySentinelFixture);
    owner = f.o;
    operator = f.op;
    attacker = f.att;
    dexRouter = f.router;
    recoveryWallet = f.rec;
    user = f.u;
    systemContract = f.sys;
    callbackProxy = f.proxy;
    token = f.tok;
    emitter = f.em;
    sentinel = f.s;
    treasury = f.tr;
  });

  it("registers subscriptions on 0x8888...8888 for Transfer, Approval, and OracleDeviation", async function () {
    const subCount = await systemContract.getSubscriptionCount();
    expect(subCount).to.equal(3n);

    const sub0 = await systemContract.subscriptions(0);
    expect(sub0.subscriber).to.equal(await sentinel.getAddress());
    expect(sub0.chainId).to.equal(BASE_SEPOLIA_CHAIN_ID);
    expect(sub0.contractAddress).to.equal(await token.getAddress());
    expect(sub0.topic0).to.equal(await sentinel.ERC20_TRANSFER_TOPIC0());
    expect(sub0.topic1).to.equal(BigInt(await treasury.getAddress()));

    const sub1 = await systemContract.subscriptions(1);
    expect(sub1.topic0).to.equal(await sentinel.ERC20_APPROVAL_TOPIC0());

    const sub2 = await systemContract.subscriptions(2);
    expect(sub2.contractAddress).to.equal(await emitter.getAddress());
    expect(sub2.topic0).to.equal(await sentinel.ORACLE_DEVIATION_TOPIC0());
  });

  it("processes normal outflows and whitelisted DEX approvals without tripping", async function () {
    const treasuryAddr = await treasury.getAddress();
    const tokenAddr = await token.getAddress();

    // Whitelist legitimate DEX router
    await sentinel
      .connect(owner)
      .setSpenderWhitelist(BASE_SEPOLIA_CHAIN_ID, treasuryAddr, dexRouter.address, true);

    // Approve MaxUint256 to whitelisted DEX router
    const approveTx = await treasury
      .connect(operator)
      .approveSpender(tokenAddr, dexRouter.address, ethers.MaxUint256);
    const approveReceipt = await approveTx.wait();
    const approvalTopic = ethers.id("Approval(address,address,uint256)");
    await relayLatestMatchingLog(BASE_SEPOLIA_CHAIN_ID, approveReceipt, tokenAddr, approvalTopic);

    expect(await systemContract.getCallbackRequestCount()).to.equal(0n);
    expect(await treasury.frozen()).to.equal(false);

    // Small transfer under threshold (300 < 1000 singleTx, < 1500 window)
    const wdTx = await treasury.connect(operator).withdrawToken(tokenAddr, user.address, ethers.parseEther("300"));
    const wdReceipt = await wdTx.wait();
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    await relayLatestMatchingLog(BASE_SEPOLIA_CHAIN_ID, wdReceipt, tokenAddr, transferTopic);

    expect(await systemContract.getCallbackRequestCount()).to.equal(0n);
    const vaultKey = await sentinel.getVaultKey(BASE_SEPOLIA_CHAIN_ID, treasuryAddr);
    const state = await sentinel.velocityStates(vaultKey);
    expect(state.windowOutflow).to.equal(ethers.parseEther("300"));
    expect(state.totalEventsProcessed).to.equal(1n);
  });

  it("trips circuit breaker on single-tx outflow breach and blocks subsequent drains", async function () {
    const tokenAddr = await token.getAddress();
    const transferTopic = ethers.id("Transfer(address,address,uint256)");

    // Compromised operator triggers a 1,200 mUSDC withdrawal (>= 1,000 threshold)
    const drainTx = await treasury
      .connect(operator)
      .withdrawToken(tokenAddr, attacker.address, ethers.parseEther("1200"));
    const drainReceipt = await drainTx.wait();

    const reactReceipt = await relayLatestMatchingLog(
      BASE_SEPOLIA_CHAIN_ID,
      drainReceipt,
      tokenAddr,
      transferTopic
    );

    // Verify CallbackRequest emitted on Reactive System Contract
    expect(await systemContract.getCallbackRequestCount()).to.equal(1n);
    const cfg = await systemContract.getCallbackRequest(0);
    expect(cfg.chainId).to.equal(BASE_SEPOLIA_CHAIN_ID);
    expect(cfg.recipient).to.equal(await treasury.getAddress());
    expect(cfg.gasLimit).to.equal(500000n);

    // Verify CircuitBreakerTriggered event
    await expect(reactReceipt)
      .to.emit(sentinel, "CircuitBreakerTriggered")
      .withArgs(
        await sentinel.getVaultKey(BASE_SEPOLIA_CHAIN_ID, await treasury.getAddress()),
        BASE_SEPOLIA_CHAIN_ID,
        await treasury.getAddress(),
        REASON_SINGLE_TX_OUTFLOW,
        ethers.parseEther("1200"),
        drainReceipt.hash
      );

    // Deliver callback via destination CallbackProxy
    await deliverLatestCallbackToTreasury();

    expect(await treasury.frozen()).to.equal(true);
    expect(await treasury.lastReasonCode()).to.equal(REASON_SINGLE_TX_OUTFLOW);
    expect(await treasury.lastObservedValue()).to.equal(ethers.parseEther("1200"));
    expect(await treasury.lastOriginTxHash()).to.equal(drainReceipt.hash);

    // Follow-up attacker drain attempt MUST revert with VaultFrozen
    await expect(
      treasury.connect(operator).withdrawToken(tokenAddr, attacker.address, ethers.parseEther("100"))
    ).to.be.revertedWithCustomError(treasury, "VaultFrozen");

    await expect(
      treasury.connect(operator).approveSpender(tokenAddr, attacker.address, ethers.MaxUint256)
    ).to.be.revertedWithCustomError(treasury, "VaultFrozen");
  });

  it("detects split-drain cumulative velocity breach across sliding window and resets after window expires", async function () {
    const tokenAddr = await token.getAddress();
    const transferTopic = ethers.id("Transfer(address,address,uint256)");

    // 3 transfers of 550 mUSDC each: each < 1000 singleTxThreshold, total = 1,650 >= 1,500 windowOutflowThreshold
    for (let i = 0; i < 3; i++) {
      const tx = await treasury
        .connect(operator)
        .withdrawToken(tokenAddr, attacker.address, ethers.parseEther("550"));
      const receipt = await tx.wait();
      await relayLatestMatchingLog(BASE_SEPOLIA_CHAIN_ID, receipt, tokenAddr, transferTopic);
    }

    expect(await systemContract.getCallbackRequestCount()).to.equal(1n);
    await deliverLatestCallbackToTreasury();
    expect(await treasury.frozen()).to.equal(true);
    expect(await treasury.lastReasonCode()).to.equal(REASON_VELOCITY_BREACH);
    expect(await treasury.lastObservedValue()).to.equal(ethers.parseEther("1650"));

    // Owner unfreezes & advance time past windowSeconds (120s) + cooldownSeconds (60s)
    await treasury.connect(owner).unfreezeOnly();
    await time.increase(125);

    // A fresh 550 mUSDC transfer resets the window and does NOT trip
    const txAfter = await treasury
      .connect(operator)
      .withdrawToken(tokenAddr, user.address, ethers.parseEther("550"));
    const receiptAfter = await txAfter.wait();
    await relayLatestMatchingLog(BASE_SEPOLIA_CHAIN_ID, receiptAfter, tokenAddr, transferTopic);

    expect(await systemContract.getCallbackRequestCount()).to.equal(1n);
    expect(await treasury.frozen()).to.equal(false);
  });

  it("trips circuit breaker on suspicious non-whitelisted ERC-20 Approval", async function () {
    const tokenAddr = await token.getAddress();
    const approvalTopic = ethers.id("Approval(address,address,uint256)");

    const tx = await treasury
      .connect(operator)
      .approveSpender(tokenAddr, attacker.address, ethers.MaxUint256);
    const receipt = await tx.wait();
    await relayLatestMatchingLog(BASE_SEPOLIA_CHAIN_ID, receipt, tokenAddr, approvalTopic);

    expect(await systemContract.getCallbackRequestCount()).to.equal(1n);
    await deliverLatestCallbackToTreasury();
    expect(await treasury.frozen()).to.equal(true);
    expect(await treasury.lastReasonCode()).to.equal(REASON_SUSPICIOUS_APPROVAL);
  });

  it("trips cross-chain vault on origin OraclePriceDeviation >= threshold", async function () {
    const tokenAddr = await token.getAddress();
    const emitterAddr = await emitter.getAddress();
    const oracleTopic = ethers.id("OraclePriceDeviation(address,uint256,uint256,uint256,uint256)");

    // 15% price deviation (1500 bps >= 1000 bps threshold)
    const tx = await emitter
      .connect(owner)
      .reportOraclePrice(tokenAddr, ethers.parseEther("0.85"), ethers.parseEther("1.00"));
    const receipt = await tx.wait();
    await relayLatestMatchingLog(BASE_SEPOLIA_CHAIN_ID, receipt, emitterAddr, oracleTopic);

    expect(await systemContract.getCallbackRequestCount()).to.equal(1n);
    await deliverLatestCallbackToTreasury();
    expect(await treasury.frozen()).to.equal(true);
    expect(await treasury.lastReasonCode()).to.equal(REASON_ORACLE_DEVIATION);
    expect(await treasury.lastObservedValue()).to.equal(1500n);
  });

  it("supports cross-chain monitoring: Base Sepolia origin alert freezes Unichain Sepolia vault", async function () {
    // Deploy a second vault on Unichain Sepolia (1301) linked to the same SentinelReactive
    const TreasuryFactory = await ethers.getContractFactory("ProtectedTreasury");
    const unichainVault = await TreasuryFactory.deploy(
      await callbackProxy.getAddress(),
      await sentinel.getAddress(),
      owner.address,
      operator.address,
      recoveryWallet.address
    );
    await unichainVault.waitForDeployment();

    await sentinel.connect(owner).registerVaultAndSubscribe(
      {
        active: true,
        originChainId: UNICHAIN_SEPOLIA_CHAIN_ID,
        destinationChainId: UNICHAIN_SEPOLIA_CHAIN_ID,
        vault: await unichainVault.getAddress(),
        singleTxThreshold: ethers.parseEther("500"),
        windowOutflowThreshold: ethers.parseEther("1000"),
        windowSeconds: 60n,
        maxApprovalThreshold: ethers.parseEther("1000"),
        maxOracleDeviationBps: 800n,
        cooldownSeconds: 30n,
        callbackGasLimit: 500000n,
      },
      await token.getAddress(),
      await emitter.getAddress()
    );

    // Subscribe Unichain vault to Base Sepolia oracle deviation as well (cross-chain protection)
    await sentinel
      .connect(owner)
      .subscribeOracleForVault(
        BASE_SEPOLIA_CHAIN_ID,
        await treasury.getAddress(),
        await emitter.getAddress(),
        await token.getAddress()
      );

    // Trigger oracle deviation on Unichain Sepolia (1301) -> requestCallback targets 1301
    const emitterAddr = await emitter.getAddress();
    const tokenAddr = await token.getAddress();
    const oracleTopic = ethers.id("OraclePriceDeviation(address,uint256,uint256,uint256,uint256)");
    const tx = await emitter
      .connect(owner)
      .reportOraclePrice(tokenAddr, ethers.parseEther("0.88"), ethers.parseEther("1.00")); // 1200 bps
    const receipt = await tx.wait();
    await relayLatestMatchingLog(UNICHAIN_SEPOLIA_CHAIN_ID, receipt, emitterAddr, oracleTopic);

    const cfg = await systemContract.getCallbackRequest(0);
    expect(cfg.chainId).to.equal(UNICHAIN_SEPOLIA_CHAIN_ID);
    expect(cfg.recipient).to.equal(await unichainVault.getAddress());

    await callbackProxy.deliverCallback(cfg.recipient, await sentinel.getAddress(), cfg.payload);
    expect(await unichainVault.frozen()).to.equal(true);
  });

  it("rejects spoofed callbacks and unauthorized react() calls", async function () {
    // 1. Direct attacker call to ProtectedTreasury.onSentinelTrip -> reverts NotAuthorized (onlyServiceProvider)
    await expect(
      treasury
        .connect(attacker)
        .onSentinelTrip(await sentinel.getAddress(), 1, 999, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(treasury, "NotAuthorized");

    // 2. CallbackProxy delivering call with rogue reactive sender -> reverts CallbackNotAuthorized
    const payload = treasury.interface.encodeFunctionData("onSentinelTrip", [
      ethers.ZeroAddress,
      1,
      999,
      ethers.ZeroHash,
    ]);
    await callbackProxy.deliverCallback(await treasury.getAddress(), attacker.address, payload);
    expect(await treasury.frozen()).to.equal(false);

    // 3. Direct attacker call to SentinelReactive.react -> reverts NotAuthorized (onlySystem)
    const dummyLog = {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      contractAddress: await token.getAddress(),
      topic0: 0n,
      topic1: 0n,
      topic2: 0n,
      topic3: 0n,
      data: "0x",
      blockNumber: 1n,
      opCode: 3n,
      blockHash: 0n,
      txHash: 0n,
      logIndex: 0n,
    };
    await expect(sentinel.connect(attacker).react(dummyLog)).to.be.revertedWithCustomError(
      sentinel,
      "NotAuthorized"
    );
  });

  it("prevents duplicate callback spam via cooldownSeconds and ignores unmatched logs without reverting", async function () {
    const tokenAddr = await token.getAddress();
    const transferTopic = ethers.id("Transfer(address,address,uint256)");

    // First breach -> triggers callback
    const tx1 = await treasury
      .connect(operator)
      .withdrawToken(tokenAddr, attacker.address, ethers.parseEther("1100"));
    const r1 = await tx1.wait();
    await relayLatestMatchingLog(BASE_SEPOLIA_CHAIN_ID, r1, tokenAddr, transferTopic);
    expect(await systemContract.getCallbackRequestCount()).to.equal(1n);

    // Second breach within 60s cooldown -> suppressed, no duplicate callback
    const tx2 = await treasury
      .connect(operator)
      .withdrawToken(tokenAddr, attacker.address, ethers.parseEther("1100"));
    const r2 = await tx2.wait();
    const react2 = await relayLatestMatchingLog(BASE_SEPOLIA_CHAIN_ID, r2, tokenAddr, transferTopic);
    await expect(react2).to.emit(sentinel, "CooldownSuppressed");
    expect(await systemContract.getCallbackRequestCount()).to.equal(1n);

    // Unmatched log (opCode != 3 or unknown topic0) falls through cleanly without revert
    await systemContract.dispatchReact(await sentinel.getAddress(), {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      contractAddress: tokenAddr,
      topic0: 123456n,
      topic1: 0n,
      topic2: 0n,
      topic3: 0n,
      data: "0x",
      blockNumber: 10n,
      opCode: 3n,
      blockHash: 0n,
      txHash: 0n,
      logIndex: 0n,
    });

    // Advance past cooldown -> new breach fires callback #2
    await time.increase(65);
    const tx3 = await treasury
      .connect(operator)
      .withdrawToken(tokenAddr, attacker.address, ethers.parseEther("1100"));
    const r3 = await tx3.wait();
    await relayLatestMatchingLog(BASE_SEPOLIA_CHAIN_ID, r3, tokenAddr, transferTopic);
    expect(await systemContract.getCallbackRequestCount()).to.equal(2n);
  });

  it("allows only cold owner to unfreezeAndRecover and settles debt via coverDebt()", async function () {
    const tokenAddr = await token.getAddress();
    const transferTopic = ethers.id("Transfer(address,address,uint256)");

    const drainTx = await treasury
      .connect(operator)
      .withdrawToken(tokenAddr, attacker.address, ethers.parseEther("1200"));
    const drainReceipt = await drainTx.wait();
    await relayLatestMatchingLog(BASE_SEPOLIA_CHAIN_ID, drainReceipt, tokenAddr, transferTopic);
    await deliverLatestCallbackToTreasury();
    expect(await treasury.frozen()).to.equal(true);

    // Compromised operator CANNOT unfreeze or recover
    await expect(
      treasury.connect(operator).unfreezeAndRecover(tokenAddr, attacker.address, ethers.MaxUint256)
    ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");

    // Cold owner atomically unfreezes and sweeps remaining 8,800 mUSDC to recoveryWallet
    const beforeRecovery = await token.balanceOf(recoveryWallet.address);
    await treasury.connect(owner).unfreezeAndRecover(tokenAddr, ethers.ZeroAddress, ethers.MaxUint256);

    expect(await treasury.frozen()).to.equal(false);
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(0n);
    expect(await token.balanceOf(recoveryWallet.address) - beforeRecovery).to.equal(
      ethers.parseEther("8800")
    );

    // Test coverDebt() on SentinelReactive against 0x8888...8888
    await systemContract.setDebt(await sentinel.getAddress(), ethers.parseEther("0.05"));
    await sentinel.coverDebt();
    expect(await ethers.provider.getBalance(SYSTEM_CONTRACT_ADDRESS)).to.equal(
      ethers.parseEther("0.05")
    );
  });
});
