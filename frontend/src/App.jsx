import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Lock,
  Radio,
  RefreshCw,
  Shield,
  ShieldAlert,
  Unlock,
  Wallet,
  Zap,
} from "lucide-react";
import {
  NETWORKS,
  ORIGIN_EMITTER_ABI,
  PROTECTED_TREASURY_ABI,
  REASON_LABELS,
  SENTINEL_REACTIVE_ABI,
} from "./contracts";

const INITIAL_POLICY = {
  originChainKey: "baseSepolia",
  destChainKey: "baseSepolia",
  singleTxThreshold: 1000,
  windowOutflowThreshold: 1500,
  windowSeconds: 120,
  maxApprovalThreshold: 2000,
  maxOracleDeviationBps: 1000,
  cooldownSeconds: 60,
  callbackGasLimit: 500000,
};

function randomTxHash() {
  const hex = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `0x${hex}`;
}

export default function App() {
  const [mode, setMode] = useState("simulation"); // "simulation" | "testnet"
  const [walletAddress, setWalletAddress] = useState("");
  const [chainId, setChainId] = useState(null);
  const [rpcBlocks, setRpcBlocks] = useState({
    baseSepolia: "probing...",
    unichainSepolia: "probing...",
    reactiveLasna: "probing...",
  });

  // Deployed contract addresses for Live Testnet Mode
  const [addresses, setAddresses] = useState({
    sentinelReactive: "",
    protectedTreasury: "",
    originToken: "",
    originEmitter: "",
  });

  // Sentinel & Vault state
  const [policy, setPolicy] = useState(INITIAL_POLICY);
  const [vaultBalance, setVaultBalance] = useState(10000);
  const [recoveryBalance, setRecoveryBalance] = useState(0);
  const [windowOutflow, setWindowOutflow] = useState(0);
  const [frozen, setFrozen] = useState(false);
  const [lastReasonCode, setLastReasonCode] = useState(0);
  const [lastObservedValue, setLastObservedValue] = useState(0);
  const [tripCount, setTripCount] = useState(0);
  const [eventsProcessed, setEventsProcessed] = useState(0);
  const [activeStage, setActiveStage] = useState(0); // 0 idle, 1 origin, 2 reactive, 3 callback
  const [busy, setBusy] = useState(false);

  const [logs, setLogs] = useState([
    {
      id: "boot-1",
      kind: "normal",
      title: "SentinelReactive Armed on Reactive Omni (Lasna 5318007)",
      detail:
        "Subscribed via SYSTEM (0x8888...8888) to ERC-20 Transfer, Approval, and OraclePriceDeviation on Base Sepolia (84532) & Unichain Sepolia (1301).",
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      time: new Date().toLocaleTimeString(),
    },
  ]);

  const appendLog = (entry) => {
    setLogs((prev) => [{ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString(), ...entry }, ...prev].slice(0, 40));
  };

  const probeRpcs = async () => {
    const entries = Object.entries(NETWORKS);
    const next = {};
    await Promise.all(
      entries.map(async ([key, cfg]) => {
        try {
          const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.id, { staticNetwork: true });
          const blockNum = await Promise.race([
            provider.getBlockNumber(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4500)),
          ]);
          next[key] = `#${blockNum.toLocaleString()}`;
        } catch {
          next[key] = "offline / rate-limited";
        }
      })
    );
    setRpcBlocks(next);
  };

  useEffect(() => {
    probeRpcs();
  }, []);

  const connectWallet = async () => {
    if (!window.ethereum) {
      appendLog({
        kind: "breach",
        title: "No EVM Wallet Detected",
        detail: "Install MetaMask (disable Smart Transactions for Reactive Lasna) to sign live testnet transactions.",
      });
      return;
    }
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const net = await provider.getNetwork();
      setWalletAddress(await signer.getAddress());
      setChainId(Number(net.chainId));
      appendLog({
        kind: "recovered",
        title: "Wallet Connected",
        detail: `Connected ${await signer.getAddress()} on chainId ${Number(net.chainId)}.`,
      });
    } catch (err) {
      appendLog({
        kind: "breach",
        title: "Wallet Connection Rejected",
        detail: err?.message || "User declined connection.",
      });
    }
  };

  const pulsePipeline = async (shouldTrip) => {
    setActiveStage(1);
    await new Promise((r) => setTimeout(r, 260));
    setActiveStage(2);
    await new Promise((r) => setTimeout(r, 380));
    if (shouldTrip) {
      setActiveStage(3);
      await new Promise((r) => setTimeout(r, 420));
    }
    setTimeout(() => setActiveStage(0), 1200);
  };

  const runSimulationAction = async (kind) => {
    if (busy) return;
    setBusy(true);
    try {
      const originChain = NETWORKS[policy.originChainKey];
      const destChain = NETWORKS[policy.destChainKey];
      const txHash = randomTxHash();

      if (kind === "normal_transfer") {
        if (frozen) {
          appendLog({
            kind: "breach",
            title: "Blocked by Circuit Breaker (VaultFrozen)",
            detail: `ProtectedTreasury reverted withdrawToken(250 mUSDC) — vault is frozen (reasonCode=${lastReasonCode}).`,
            txHash,
          });
          return;
        }
        const amount = 250;
        const nextWindow = windowOutflow + amount;
        setVaultBalance((v) => Math.max(0, v - amount));
        setWindowOutflow(nextWindow);
        setEventsProcessed((n) => n + 1);

        const breachedVelocity = nextWindow >= policy.windowOutflowThreshold;
        await pulsePipeline(breachedVelocity);
        if (breachedVelocity) {
          setFrozen(true);
          setLastReasonCode(2);
          setLastObservedValue(nextWindow);
          setTripCount((c) => c + 1);
          appendLog({
            kind: "breach",
            title: "Velocity Threshold Breached -> Callback Freeze Executed",
            detail: `250 mUSDC transfer pushed sliding-window outflow to ${nextWindow} mUSDC (>= ${policy.windowOutflowThreshold}). Reactive dispatched requestCallbackV_1_0 -> ${destChain.name}.`,
            txHash,
          });
        } else {
          appendLog({
            kind: "normal",
            title: `Normal Transfer Processed (${amount} mUSDC)`,
            detail: `${originChain.name} Transfer -> SentinelReactive.react() updated windowOutflow=${nextWindow}/${policy.windowOutflowThreshold} mUSDC. Status: ARMED.`,
            txHash,
          });
        }
      } else if (kind === "whitelisted_approval") {
        if (frozen) {
          appendLog({
            kind: "breach",
            title: "Blocked by Circuit Breaker (VaultFrozen)",
            detail: "approveSpender reverted because ProtectedTreasury is currently frozen.",
            txHash,
          });
          return;
        }
        setEventsProcessed((n) => n + 1);
        await pulsePipeline(false);
        appendLog({
          kind: "normal",
          title: "Whitelisted DEX Router Approval Ignored Safely",
          detail: "SentinelReactive verified spender is in whitelistedSpenders[vaultKey]. No false-positive freeze triggered.",
          txHash,
        });
      } else if (kind === "flash_drain") {
        if (frozen) {
          appendLog({
            kind: "breach",
            title: "Attacker Follow-Up Drain Blocked (VaultFrozen)",
            detail: `ProtectedTreasury reverted withdrawToken(1,200 mUSDC) with custom error VaultFrozen(${lastReasonCode}). Zero additional funds lost.`,
            txHash,
          });
          return;
        }
        const amount = Math.max(policy.singleTxThreshold + 200, 1200);
        setVaultBalance((v) => Math.max(0, v - amount));
        setWindowOutflow((w) => w + amount);
        setEventsProcessed((n) => n + 1);
        await pulsePipeline(true);
        setFrozen(true);
        setLastReasonCode(1);
        setLastObservedValue(amount);
        setTripCount((c) => c + 1);
        appendLog({
          kind: "breach",
          title: `Flash-Drain Detected (${amount} mUSDC) -> Vault Frozen in ~1s`,
          detail: `Origin ${originChain.name} Transfer exceeded singleTxThreshold (${policy.singleTxThreshold}). SentinelReactive called SYSTEM.requestCallbackV_1_0 -> ${destChain.callbackProxy.slice(0, 10)}... -> ProtectedTreasury.onSentinelTrip(1).`,
          txHash,
        });
      } else if (kind === "split_drain") {
        if (frozen) {
          appendLog({
            kind: "breach",
            title: "Split-Drain Blocked (VaultFrozen)",
            detail: "ProtectedTreasury is already locked; withdrawToken reverts with VaultFrozen.",
            txHash,
          });
          return;
        }
        const chunk = Math.ceil(policy.windowOutflowThreshold / 3);
        const nextWindow = windowOutflow + chunk;
        setVaultBalance((v) => Math.max(0, v - chunk));
        setWindowOutflow(nextWindow);
        setEventsProcessed((n) => n + 1);
        const breached = nextWindow >= policy.windowOutflowThreshold;
        await pulsePipeline(breached);
        if (breached) {
          setFrozen(true);
          setLastReasonCode(2);
          setLastObservedValue(nextWindow);
          setTripCount((c) => c + 1);
          appendLog({
            kind: "breach",
            title: `Split-Drain Velocity Breach (${nextWindow} mUSDC) -> Vault Frozen`,
            detail: `Chunk of ${chunk} mUSDC was below singleTxThreshold (${policy.singleTxThreshold}), but cumulative sliding-window hit ${nextWindow} >= ${policy.windowOutflowThreshold}. Autonomous freeze delivered!`,
            txHash,
          });
        } else {
          appendLog({
            kind: "normal",
            title: `Split-Drain Probe #${Math.ceil(nextWindow / chunk)} (${chunk} mUSDC)`,
            detail: `Cumulative windowOutflow=${nextWindow}/${policy.windowOutflowThreshold} mUSDC. Click Split-Drain again to cross threshold.`,
            txHash,
          });
        }
      } else if (kind === "rogue_approval") {
        if (frozen) {
          appendLog({
            kind: "breach",
            title: "Rogue Approval Blocked (VaultFrozen)",
            detail: "approveSpender reverted because vault is frozen.",
            txHash,
          });
          return;
        }
        setEventsProcessed((n) => n + 1);
        await pulsePipeline(true);
        setFrozen(true);
        setLastReasonCode(3);
        setLastObservedValue(policy.maxApprovalThreshold);
        setTripCount((c) => c + 1);
        appendLog({
          kind: "breach",
          title: "Rogue Unlimited ERC-20 Approval Intercepted -> Vault Frozen",
          detail: `Approval(vault, unknownSpender, MaxUint256) exceeded maxApprovalThreshold (${policy.maxApprovalThreshold}). Callback delivered via ${destChain.name} proxy.`,
          txHash,
        });
      } else if (kind === "oracle_depeg") {
        const devBps = Math.max(policy.maxOracleDeviationBps + 500, 1500);
        setEventsProcessed((n) => n + 1);
        await pulsePipeline(true);
        setFrozen(true);
        setLastReasonCode(4);
        setLastObservedValue(devBps);
        setTripCount((c) => c + 1);
        appendLog({
          kind: "breach",
          title: `Oracle Deviation Alert (${(devBps / 100).toFixed(1)}%) -> Cross-Chain Freeze`,
          detail: `${originChain.name} OriginActivityEmitter emitted OraclePriceDeviation(${devBps} bps). Reactive froze ${destChain.name} ProtectedTreasury preemptively.`,
          txHash,
        });
      } else if (kind === "recover") {
        const swept = vaultBalance;
        setRecoveryBalance((r) => r + swept);
        setVaultBalance(0);
        setWindowOutflow(0);
        setFrozen(false);
        setLastReasonCode(0);
        setLastObservedValue(0);
        appendLog({
          kind: "recovered",
          title: `Cold Owner Executed unfreezeAndRecover()`,
          detail: `Vault unfrozen and ${swept.toLocaleString()} mUSDC atomically swept to cold emergencyRecoveryAddress.`,
          txHash,
        });
      } else if (kind === "reset_demo") {
        setVaultBalance(10000);
        setRecoveryBalance(0);
        setWindowOutflow(0);
        setFrozen(false);
        setLastReasonCode(0);
        setLastObservedValue(0);
        appendLog({
          kind: "recovered",
          title: "Demo Vault Reseeded (10,000 mUSDC)",
          detail: "Sliding-window velocity state reset; circuit breaker armed.",
          txHash,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const syncLiveContracts = async () => {
    if (!addresses.protectedTreasury && !addresses.sentinelReactive) {
      appendLog({
        kind: "breach",
        title: "Enter Deployed Addresses First",
        detail: "Provide ProtectedTreasury and/or SentinelReactive addresses to read live testnet state.",
      });
      return;
    }
    setBusy(true);
    try {
      const originCfg = NETWORKS[policy.originChainKey];
      if (addresses.protectedTreasury && ethers.isAddress(addresses.protectedTreasury)) {
        const p = new ethers.JsonRpcProvider(originCfg.rpcUrl, originCfg.id, { staticNetwork: true });
        const treasury = new ethers.Contract(addresses.protectedTreasury, PROTECTED_TREASURY_ABI, p);
        const [isFrozen, reason, obs, trips] = await Promise.all([
          treasury.frozen(),
          treasury.lastReasonCode(),
          treasury.lastObservedValue(),
          treasury.tripCount(),
        ]);
        setFrozen(Boolean(isFrozen));
        setLastReasonCode(Number(reason));
        setLastObservedValue(Number(obs));
        setTripCount(Number(trips));
      }

      if (
        addresses.sentinelReactive &&
        ethers.isAddress(addresses.sentinelReactive) &&
        addresses.protectedTreasury &&
        ethers.isAddress(addresses.protectedTreasury)
      ) {
        const lasna = NETWORKS.reactiveLasna;
        const rp = new ethers.JsonRpcProvider(lasna.rpcUrl, lasna.id, { staticNetwork: true });
        const sentinel = new ethers.Contract(addresses.sentinelReactive, SENTINEL_REACTIVE_ABI, rp);
        const key = await sentinel.getVaultKey(originCfg.id, addresses.protectedTreasury);
        const vel = await sentinel.velocityStates(key);
        setWindowOutflow(Number(ethers.formatEther(vel.windowOutflow)));
        setEventsProcessed(Number(vel.totalEventsProcessed));
      }

      appendLog({
        kind: "recovered",
        title: "Live Testnet State Synced",
        detail: `Queried ${originCfg.name} and Reactive Lasna RPCs directly.`,
      });
    } catch (err) {
      appendLog({
        kind: "breach",
        title: "Live RPC Query Error",
        detail: err?.message || "Failed to read live contract state.",
      });
    } finally {
      setBusy(false);
    }
  };

  const triggerLiveAction = async (action) => {
    if (!window.ethereum) {
      appendLog({ kind: "breach", title: "Wallet Required", detail: "Connect MetaMask first." });
      return;
    }
    setBusy(true);
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      if (action === "unfreeze" && ethers.isAddress(addresses.protectedTreasury)) {
        const treasury = new ethers.Contract(addresses.protectedTreasury, PROTECTED_TREASURY_ABI, signer);
        const tx = await treasury.unfreezeOnly();
        appendLog({
          kind: "recovered",
          title: "Live unfreezeOnly() Submitted",
          detail: `Tx submitted: ${tx.hash}`,
          txHash: tx.hash,
        });
        await tx.wait();
        await syncLiveContracts();
      } else if (action === "oracle_alert" && ethers.isAddress(addresses.originEmitter) && ethers.isAddress(addresses.originToken)) {
        const emitter = new ethers.Contract(addresses.originEmitter, ORIGIN_EMITTER_ABI, signer);
        const tx = await emitter.reportOraclePrice(
          addresses.originToken,
          ethers.parseEther("0.85"),
          ethers.parseEther("1.00")
        );
        appendLog({
          kind: "breach",
          title: "Live OraclePriceDeviation (1500 bps) Submitted",
          detail: `Origin Tx: ${tx.hash} — Reactive Lasna will process via react() in ~1s.`,
          txHash: tx.hash,
        });
      }
    } catch (err) {
      appendLog({
        kind: "breach",
        title: "Live Transaction Failed",
        detail: err?.shortMessage || err?.message || "Transaction rejected.",
      });
    } finally {
      setBusy(false);
    }
  };

  const velocityPct = Math.min(100, Math.round((windowOutflow / Math.max(1, policy.windowOutflowThreshold)) * 100));
  const originNet = NETWORKS[policy.originChainKey];
  const destNet = NETWORKS[policy.destChainKey];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <Shield size={24} />
          </div>
          <div>
            <h1>Reactive Sentinel Omni</h1>
            <p>Autonomous Cross-Chain Circuit Breaker • Base Sepolia ↔ Unichain Sepolia ↔ Reactive Lasna</p>
          </div>
        </div>

        <div className="topbar-actions">
          <span className={`pill ${frozen ? "frozen" : "live"}`}>
            {frozen ? <Lock size={14} /> : <Radio size={14} />}
            {frozen ? `CIRCUIT TRIPPED (CODE ${lastReasonCode})` : "SENTINEL ARMED"}
          </span>

          <button
            className={`btn ${mode === "simulation" ? "btn-primary" : ""}`}
            onClick={() => setMode(mode === "simulation" ? "testnet" : "simulation")}
          >
            <Cpu size={15} />
            {mode === "simulation" ? "Mode: Interactive Simulator" : "Mode: Live Testnet RPC"}
          </button>

          <button className="btn" onClick={connectWallet}>
            <Wallet size={15} />
            {walletAddress ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)} (${chainId})` : "Connect Wallet"}
          </button>
        </div>
      </header>

      <section className="rpc-strip">
        {Object.entries(NETWORKS).map(([key, net]) => (
          <div key={key} className="rpc-card">
            <div>
              <div className="title">{net.name}</div>
              <div className="label mono">
                Chain ID {net.id} • {net.systemContract ? `SYSTEM ${net.systemContract.slice(0, 10)}...` : `Proxy ${net.callbackProxy.slice(0, 10)}...`}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="mono" style={{ color: rpcBlocks[key]?.startsWith("#") ? "var(--emerald)" : "var(--amber)" }}>
                {rpcBlocks[key]}
              </div>
              <div className="label">live block</div>
            </div>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">
            <Zap size={18} color="var(--cyan)" />
            Reactive Omni Execution Pipeline (~1s CometBFT Finality, Zero Off-Chain Bots)
          </h2>
          <button className="btn" onClick={probeRpcs}>
            <RefreshCw size={14} />
            Refresh RPCs
          </button>
        </div>

        <div className="pipeline">
          <div className={`pipe-node ${activeStage === 1 ? "active-step" : ""}`}>
            <div className="mono" style={{ color: "var(--cyan)", marginBottom: 6 }}>
              1. ORIGIN CHAIN ({originNet.shortName.toUpperCase()} • {originNet.id})
            </div>
            <strong>ProtectedTreasury + ERC-20 + Oracle</strong>
            <p className="muted" style={{ fontSize: "0.82rem", margin: "6px 0 0" }}>
              Emits <span className="mono">Transfer(vault, to, val)</span>, <span className="mono">Approval</span>, or{" "}
              <span className="mono">OraclePriceDeviation</span> logs. Filtered by <span className="mono">topic1 = vault</span>.
            </p>
          </div>

          <div className="pipe-arrow">
            <ArrowRight size={22} />
          </div>

          <div className={`pipe-node ${activeStage === 2 ? "active-step" : ""}`}>
            <div className="mono" style={{ color: "var(--violet)", marginBottom: 6 }}>
              2. REACTIVE OMNI (LASNA • 5318007)
            </div>
            <strong>SentinelReactive.react(LogRecord)</strong>
            <p className="muted" style={{ fontSize: "0.82rem", margin: "6px 0 0" }}>
              Invoked by <span className="mono">SYSTEM (0x8888...8888)</span>. Tracks sliding-window velocity &amp; calls{" "}
              <span className="mono">requestCallbackV_1_0</span> on breach.
            </p>
          </div>

          <div className="pipe-arrow">
            <ArrowRight size={22} />
          </div>

          <div className={`pipe-node ${activeStage === 3 || frozen ? "tripped-step" : ""}`}>
            <div className="mono" style={{ color: frozen ? "var(--crimson)" : "var(--emerald)", marginBottom: 6 }}>
              3. DESTINATION ({destNet.shortName.toUpperCase()} • {destNet.id})
            </div>
            <strong>CallbackProxy → onSentinelTrip()</strong>
            <p className="muted" style={{ fontSize: "0.82rem", margin: "6px 0 0" }}>
              Proxy <span className="mono">{destNet.callbackProxy.slice(0, 12)}...</span> injects sender into slot 0;{" "}
              <span className="mono">AbstractCallback</span> locks vault atomically.
            </p>
          </div>
        </div>
      </section>

      <section className="stat-grid">
        <div className="stat-box">
          <div className="k">Vault Protected Balance</div>
          <div className="v">{vaultBalance.toLocaleString()} mUSDC</div>
          <div className="muted" style={{ fontSize: "0.75rem" }}>
            Cold Recovery: {recoveryBalance.toLocaleString()} mUSDC
          </div>
        </div>
        <div className="stat-box">
          <div className="k">Sliding-Window Velocity</div>
          <div className="v" style={{ color: velocityPct >= 100 ? "var(--crimson)" : "var(--cyan)" }}>
            {windowOutflow.toLocaleString()} / {policy.windowOutflowThreshold.toLocaleString()} mUSDC
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: `${velocityPct}%`,
                background: velocityPct >= 100 ? "var(--crimson)" : velocityPct >= 65 ? "var(--amber)" : "var(--cyan)",
              }}
            />
          </div>
        </div>
        <div className="stat-box">
          <div className="k">Circuit Breaker Status</div>
          <div className="v" style={{ color: frozen ? "var(--crimson)" : "var(--emerald)" }}>
            {frozen ? "FROZEN" : "ARMED"}
          </div>
          <div className="muted" style={{ fontSize: "0.75rem" }}>
            {REASON_LABELS[lastReasonCode] || "Nominal"}
          </div>
        </div>
        <div className="stat-box">
          <div className="k">Reactive Telemetry</div>
          <div className="v">
            {eventsProcessed} logs / {tripCount} trips
          </div>
          <div className="muted" style={{ fontSize: "0.75rem" }}>
            Last observed: {lastObservedValue.toLocaleString()}
          </div>
        </div>
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">
              <ShieldAlert size={18} color="var(--amber)" />
              {mode === "simulation" ? "Attack & Self-Defense Simulator" : "Live Testnet Contract Controls"}
            </h2>
            {mode === "simulation" && (
              <button className="btn" onClick={() => runSimulationAction("reset_demo")}>
                <RefreshCw size={14} /> Reset Vault
              </button>
            )}
          </div>

          {mode === "simulation" ? (
            <div className="action-grid">
              <button className="btn" disabled={busy} onClick={() => runSimulationAction("normal_transfer")}>
                <CheckCircle2 size={15} color="var(--emerald)" />
                Normal Transfer (250 mUSDC)
              </button>
              <button className="btn" disabled={busy} onClick={() => runSimulationAction("whitelisted_approval")}>
                <Shield size={15} color="var(--cyan)" />
                Whitelisted DEX Approval
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => runSimulationAction("flash_drain")}>
                <AlertTriangle size={15} />
                Flash-Drain Attack (1,200+)
              </button>
              <button className="btn btn-warning" disabled={busy} onClick={() => runSimulationAction("split_drain")}>
                <Activity size={15} />
                Split-Drain Velocity Probe
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => runSimulationAction("rogue_approval")}>
                <AlertTriangle size={15} />
                Rogue Unlimited Approval
              </button>
              <button className="btn btn-warning" disabled={busy} onClick={() => runSimulationAction("oracle_depeg")}>
                <Zap size={15} />
                Oracle 15% Depeg Alert
              </button>
              <button
                className="btn btn-success"
                disabled={busy || (!frozen && vaultBalance === 0)}
                onClick={() => runSimulationAction("recover")}
                style={{ gridColumn: "1 / -1" }}
              >
                <Unlock size={15} />
                Cold Owner: unfreezeAndRecover() — Rescue Remaining Funds
              </button>
            </div>
          ) : (
            <div>
              <div className="form-grid" style={{ marginBottom: 14 }}>
                <div className="field">
                  <label>SentinelReactive (Lasna 5318007)</label>
                  <input
                    placeholder="0x..."
                    value={addresses.sentinelReactive}
                    onChange={(e) => setAddresses({ ...addresses, sentinelReactive: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>ProtectedTreasury ({originNet.shortName})</label>
                  <input
                    placeholder="0x..."
                    value={addresses.protectedTreasury}
                    onChange={(e) => setAddresses({ ...addresses, protectedTreasury: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>MockOriginToken</label>
                  <input
                    placeholder="0x..."
                    value={addresses.originToken}
                    onChange={(e) => setAddresses({ ...addresses, originToken: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>OriginActivityEmitter</label>
                  <input
                    placeholder="0x..."
                    value={addresses.originEmitter}
                    onChange={(e) => setAddresses({ ...addresses, originEmitter: e.target.value })}
                  />
                </div>
              </div>

              <div className="action-grid">
                <button className="btn btn-primary" disabled={busy} onClick={syncLiveContracts}>
                  <RefreshCw size={15} />
                  Sync Live RPC State
                </button>
                <button className="btn btn-warning" disabled={busy} onClick={() => triggerLiveAction("oracle_alert")}>
                  <Zap size={15} />
                  Emit Live Oracle Alert (15%)
                </button>
                <button className="btn btn-success" disabled={busy} onClick={() => triggerLiveAction("unfreeze")}>
                  <Unlock size={15} />
                  Live Owner: unfreezeOnly()
                </button>
              </div>
            </div>
          )}

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
            <h3 style={{ margin: "0 0 10px", fontSize: "0.88rem" }}>Sentinel VaultPolicy Parameters</h3>
            <div className="form-grid">
              <div className="field">
                <label>Origin Chain</label>
                <select
                  value={policy.originChainKey}
                  onChange={(e) => setPolicy({ ...policy, originChainKey: e.target.value })}
                >
                  <option value="baseSepolia">Base Sepolia (84532)</option>
                  <option value="unichainSepolia">Unichain Sepolia (1301)</option>
                </select>
              </div>
              <div className="field">
                <label>Destination Chain</label>
                <select
                  value={policy.destChainKey}
                  onChange={(e) => setPolicy({ ...policy, destChainKey: e.target.value })}
                >
                  <option value="baseSepolia">Base Sepolia (84532)</option>
                  <option value="unichainSepolia">Unichain Sepolia (1301)</option>
                </select>
              </div>
              <div className="field">
                <label>Single-TX Threshold (mUSDC)</label>
                <input
                  type="number"
                  value={policy.singleTxThreshold}
                  onChange={(e) => setPolicy({ ...policy, singleTxThreshold: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="field">
                <label>Window Outflow Cap (mUSDC)</label>
                <input
                  type="number"
                  value={policy.windowOutflowThreshold}
                  onChange={(e) => setPolicy({ ...policy, windowOutflowThreshold: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="field">
                <label>Max Oracle Deviation (bps)</label>
                <input
                  type="number"
                  value={policy.maxOracleDeviationBps}
                  onChange={(e) => setPolicy({ ...policy, maxOracleDeviationBps: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="field">
                <label>Callback Gas Limit (&ge;150k)</label>
                <input
                  type="number"
                  value={policy.callbackGasLimit}
                  onChange={(e) => setPolicy({ ...policy, callbackGasLimit: Number(e.target.value) || 500000 })}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">
              <Activity size={18} color="var(--cyan)" />
              Cross-Chain Telemetry &amp; Callback Feed
            </h2>
            <span className="muted mono">{logs.length} events</span>
          </div>

          <div className="log-list">
            {logs.map((item) => (
              <div key={item.id} className={`log-item ${item.kind}`}>
                <div className="log-top">
                  <span>{item.title}</span>
                  <span className="muted mono">{item.time}</span>
                </div>
                <div className="muted">{item.detail}</div>
                {item.txHash && (
                  <div className="mono muted" style={{ marginTop: 4 }}>
                    tx: {item.txHash.slice(0, 18)}...{item.txHash.slice(-8)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
