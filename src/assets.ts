import type { Address } from "viem";

// Canonical Robinhood mainnet deployments from https://api.robinhood.com/rhj/assets
// and https://docs.robinhood.com/chain/contracts/. Live route proof: docs/RWA_CHECK.md.
// These are issuer-backed stock tokens, not direct share ownership. ETH is gas only.
export const ASSETS = {
  USDG: { id: "USDG", symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address, decimals: 6 },
  TSLA: { id: "TSLA", symbol: "TSLA", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address, decimals: 18 },
  AAPL: { id: "AAPL", symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" as Address, decimals: 18 },
  NVDA: { id: "NVDA", symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address, decimals: 18 },
  AMZN: { id: "AMZN", symbol: "AMZN", address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54" as Address, decimals: 18 },
} as const;

export const QUOTE_ASSET_ID = "USDG" as const;
export type AssetId = keyof typeof ASSETS;
