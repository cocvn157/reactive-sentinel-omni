export const NETWORKS = {
  baseSepolia: {
    id: 84532,
    hexId: "0x14a34",
    name: "Base Sepolia",
    shortName: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    callbackProxy: "0x476F44b11F5C942c58f4c8E3d0300E5710743585",
    faucetAddress: "0x2afaFD298b23b62760711756088F75B7409f5967",
    currency: "ETH",
  },
  unichainSepolia: {
    id: 1301,
    hexId: "0x515",
    name: "Unichain Sepolia",
    shortName: "Unichain Sepolia",
    rpcUrl: "https://sepolia.unichain.org",
    explorer: "https://sepolia.uniscan.xyz",
    callbackProxy: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
    currency: "ETH",
  },
  reactiveLasna: {
    id: 5318007,
    hexId: "0x512577",
    name: "Reactive Lasna (Omni)",
    shortName: "Reactive Lasna",
    rpcUrl: "https://lasna-rpc.rnk.dev/",
    explorer: "https://lasna.reactscan.net",
    systemContract: "0x8888888888888888888888888888888888888888",
    currency: "lREACT",
  },
};

export const REASON_LABELS = {
  0: "Nominal",
  1: "Single-TX Outflow Breach",
  2: "Sliding-Window Velocity Breach",
  3: "Suspicious Non-Whitelisted Approval",
  4: "Oracle Price Deviation Alert",
  99: "Manual Cold-Owner Lock",
};

export const SENTINEL_REACTIVE_ABI = [
  "function getVaultKey(uint256 originChainId_, address vault_) view returns (bytes32)",
  "function policies(bytes32 vaultKey) view returns (bool active, uint256 originChainId, uint256 destinationChainId, address vault, uint256 singleTxThreshold, uint256 windowOutflowThreshold, uint256 windowSeconds, uint256 maxApprovalThreshold, uint256 maxOracleDeviationBps, uint64 cooldownSeconds, uint64 callbackGasLimit)",
  "function velocityStates(bytes32 vaultKey) view returns (uint256 windowStart, uint256 windowOutflow, uint256 lastTripTimestamp, uint256 totalTrips, uint256 totalEventsProcessed)",
  "function updatePolicy(uint256 originChainId_, address vault_, bool active_, uint256 singleTxThreshold_, uint256 windowOutflowThreshold_, uint256 windowSeconds_, uint256 maxApprovalThreshold_, uint256 maxOracleDeviationBps_, uint64 cooldownSeconds_) external",
  "function setSpenderWhitelist(uint256 originChainId_, address vault_, address spender_, bool allowed_) external",
  "function coverDebt() external",
  "event TelemetryProcessed(bytes32 indexed vaultKey, uint256 indexed topic0, uint256 amountOrMetric, uint256 windowOutflow)",
  "event CircuitBreakerTriggered(bytes32 indexed vaultKey, uint256 indexed destinationChainId, address indexed vault, uint256 reasonCode, uint256 observedValue, bytes32 originTxHash)",
];

export const PROTECTED_TREASURY_ABI = [
  "function frozen() view returns (bool)",
  "function frozenAt() view returns (uint256)",
  "function lastReasonCode() view returns (uint256)",
  "function lastObservedValue() view returns (uint256)",
  "function lastOriginTxHash() view returns (bytes32)",
  "function tripCount() view returns (uint256)",
  "function owner() view returns (address)",
  "function guardianOperator() view returns (address)",
  "function emergencyRecoveryAddress() view returns (address)",
  "function withdrawToken(address token_, address to_, uint256 amount_) external",
  "function approveSpender(address token_, address spender_, uint256 amount_) external",
  "function unfreezeOnly() external",
  "function unfreezeAndRecover(address token_, address to_, uint256 amount_) external",
  "function manualFreeze(uint256 reasonCode_) external",
  "function coverDebt() external",
  "event EmergencyFrozen(address indexed reactiveSender, uint256 indexed reasonCode, uint256 observedValue, bytes32 originTxHash, uint256 timestamp)",
  "event VaultUnfrozen(address indexed owner, uint256 timestamp)",
  "event EmergencyRecovered(address indexed token, address indexed to, uint256 amount)",
];

export const ORIGIN_EMITTER_ABI = [
  "function reportOraclePrice(address asset_, uint256 currentPrice_, uint256 baselinePrice_) external returns (uint256)",
  "event OraclePriceDeviation(address indexed asset, uint256 indexed deviationBps, uint256 currentPrice, uint256 baselinePrice, uint256 timestamp)",
];
