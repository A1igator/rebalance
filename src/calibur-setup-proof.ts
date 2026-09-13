import { type TransactionReceipt, type Hex } from 'viem';
import { buildCaliburSetupTransaction, CALIBUR_ADDRESS } from './calibur.js';
import { readCaliburState } from './calibur-execution.js';
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
