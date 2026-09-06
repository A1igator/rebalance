// Verified application receipts: docs/evidence/robinhood-app-gas-reference.json.
// Repricing measured gas at current rates is a display benchmark, not a fresh
// transaction estimate: route, allowance state, calldata and L1 charges can vary.
export const GAS_REFERENCE = Object.freeze({
  chainId: 4663,
  swapGas: '168785',
  approvalGas: '57976',
  swapHash: '0xc5f28da6296df5dadbc6ad61ad0382e4c3531456f8abea838d17f2071e0bb280',
  approvalHash: '0xd02a355336fb725c5887a757b6b97948d64bb4966c20a4ad21818ac113f04c38',
} as const);
