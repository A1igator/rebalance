import type { Address, Hex } from 'viem';
import { localAccount, type Config } from './config.js';
import { privySigner, type PreparedTransaction } from './privy.js';
import { ledgerSigner } from './ledger-signing.js';
export type { PreparedTransaction } from './privy.js';
export type TransactionSigner = { address: Address; signTransaction(tx: PreparedTransaction): Promise<Hex> };

/** Signer selection is explicit. Only the local-key branch can read its local key. */
export async function loadSigner(config: Config, options: { signal?: AbortSignal } = {}): Promise<TransactionSigner> {
  if (config.mode === 'privy') return privySigner(config.wallet);
  if (config.mode === 'ledger') return ledgerSigner(config.wallet, options);
  if (config.mode !== 'private-key') throw new Error(`${config.mode} execution is not connected yet; no fallback signer was used`);
  const account = await localAccount();
  return { address: account.address, signTransaction: tx => account.signTransaction(tx) };
}
