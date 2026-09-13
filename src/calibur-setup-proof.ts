import { type TransactionReceipt, type Hex } from 'viem';
import { buildCaliburSetupTransaction, CALIBUR_ADDRESS } from './calibur.js';
import { readCaliburState, readDelegatedState } from './calibur-execution.js';
import { delegationFor } from './delegation.js';
import type { Config } from './config.js';
import type { createChain } from './chain.js';
import type { PendingTransaction } from './storage.js';

/** A successful receipt alone cannot prove that its authorization was installed. */
export async function verifyCaliburSetupReceipt(config: Config, chain: ReturnType<typeof createChain>,
  pending: PendingTransaction, receipt: TransactionReceipt): Promise<void> {
  const fail = () => new Error('Calibur setup does not match the expected empty self-call and current delegation; preserve the pending record.');
  if (pending.kind !== 'calibur-setup' || receipt.transactionHash.toLowerCase() !== pending.hash.toLowerCase() ||
      receipt.from.toLowerCase() !== config.wallet.toLowerCase() || receipt.to?.toLowerCase() !== config.wallet.toLowerCase()) throw fail();
  const tx = await chain.publicClient.getTransaction({ hash: pending.hash as Hex });
  const expected = buildCaliburSetupTransaction(config.wallet);
  const authorization = tx.type === 'eip7702' && tx.authorizationList?.length === 1 ? tx.authorizationList[0] : undefined;
  if (tx.type !== 'eip7702' || tx.hash.toLowerCase() !== pending.hash.toLowerCase() ||
      tx.from.toLowerCase() !== config.wallet.toLowerCase() || tx.to?.toLowerCase() !== config.wallet.toLowerCase() ||
      tx.value !== 0n || tx.input.toLowerCase() !== expected.data.toLowerCase() || tx.nonce !== pending.nonce || tx.chainId !== 4663 ||
      tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || !authorization ||
      authorization.chainId !== 4663 || authorization.nonce !== pending.nonce + 1 ||
      authorization.address.toLowerCase() !== CALIBUR_ADDRESS.toLowerCase()) throw fail();
  if (await readCaliburState(chain, config.wallet) !== 'calibur') throw fail();
}

/** The pending kind fixes contract identity; changing config cannot reinterpret it. */
export async function verifyDelegatedSetupReceipt(config: Config, chain: ReturnType<typeof createChain>,
  pending: PendingTransaction, receipt: TransactionReceipt): Promise<void> {
  if (pending.kind === 'calibur-setup') return verifyCaliburSetupReceipt(config, chain, pending, receipt);
  if (pending.kind !== 'simple7702-setup') throw new Error('Not a supported delegation setup receipt');
  const delegate = delegationFor('simple7702'), expected = delegate.buildSetupTransaction(config.wallet);
  const fail = () => new Error('Simple7702 setup differs from the expected empty self-call and delegation; preserve the pending record.');
  if (receipt.transactionHash.toLowerCase() !== pending.hash.toLowerCase() ||
      receipt.from.toLowerCase() !== config.wallet.toLowerCase() || receipt.to?.toLowerCase() !== config.wallet.toLowerCase()) throw fail();
  const tx = await chain.publicClient.getTransaction({ hash: pending.hash as Hex });
  const authorization = tx.type === 'eip7702' && tx.authorizationList?.length === 1 ? tx.authorizationList[0] : undefined;
  if (tx.type !== 'eip7702' || tx.hash.toLowerCase() !== pending.hash.toLowerCase() ||
      tx.from.toLowerCase() !== config.wallet.toLowerCase() || tx.to?.toLowerCase() !== config.wallet.toLowerCase() ||
      tx.value !== 0n || tx.input.toLowerCase() !== expected.data.toLowerCase() || tx.nonce !== pending.nonce || tx.chainId !== 4663 ||
      tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || !authorization ||
      authorization.chainId !== 4663 || authorization.nonce !== pending.nonce + 1 ||
      authorization.address.toLowerCase() !== delegate.address.toLowerCase()) throw fail();
  if (await readDelegatedState(chain, config.wallet, 'simple7702') !== 'simple7702') throw fail();
}
