import type { Address } from 'viem';

export type WalletSetupProgress = {
  state: 'preparing' | 'awaiting-approval' | 'awaiting-device';
  message: string;
  approval?: { url: string; code: string };
};
export type WalletSetupContext = {
  rootDir: string;
  requestKey: string;
  signal: AbortSignal;
  onProgress: (progress: WalletSetupProgress) => Promise<void>;
};
export type SetupWallet = { address: Address; reused?: boolean; accountIndex?: number; derivationPath?: string };
