import { getCreate2Address, keccak256, type Address, type Hex, type TransactionReceipt } from 'viem';
import artifact from '../src/artifacts/simple7702.json' with { type: 'json' };
import { SIMPLE7702_ADDRESS, assertSimple7702Deployment } from '../src/simple7702.js';
import type { createChain } from '../src/chain.js';
import type { Config } from '../src/config.js';
/** One-off deployment journal, separate from portfolio transaction state. */
export type DeploymentRecord = { kind: 'simple7702-deploy'; wallet: string; hash: string; nonce: number; chainId: 4663 };

/** Pure, pinned deployment payload. No constructor parameters or caller-controlled code. */
export function buildSimple7702DeploymentTransaction(): { to: Address; value: 0n; data: Hex } {
  const factory = artifact.factoryAddress as Address, salt = artifact.salt as Hex, initCode = artifact.initCode as Hex;
  if (keccak256(initCode) !== artifact.initCodeHash ||
      getCreate2Address({ from: factory, salt, bytecode: initCode }).toLowerCase() !== SIMPLE7702_ADDRESS.toLowerCase() ||
      artifact.deploymentCalldata !== `${salt}${initCode.slice(2)}`) throw new Error('Canonical Simple7702 deployment artifact is invalid');
  return { to: factory, value: 0n, data: artifact.deploymentCalldata as Hex };
}

/** Public code reads only, at one block. A foreign factory or implementation fails closed. */
export async function readSimple7702Deployment(chain: Pick<ReturnType<typeof createChain>, 'publicClient'>): Promise<'deployed' | 'undeployed'> {
  const rpc = chain.publicClient;
  if (await rpc.getChainId() !== 4663) throw new Error('Simple7702 deployment requires Robinhood mainnet');
  const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 });
  const code = await rpc.getCode({ address: SIMPLE7702_ADDRESS, blockNumber });
  if (code && code !== '0x') { assertSimple7702Deployment(code); return 'deployed'; }
  const factory = await rpc.getCode({ address: artifact.factoryAddress as Address, blockNumber });
  if (!factory || keccak256(factory) !== artifact.factoryRuntimeCodeHash) throw new Error('Canonical deployment factory is unavailable or changed');
  return 'undeployed';
}

/** A deployment receipt never counts as a rebalance or wallet delegation. */
export async function verifySimple7702DeploymentReceipt(config: Config, chain: ReturnType<typeof createChain>,
  pending: DeploymentRecord, receipt: TransactionReceipt): Promise<void> {
  const expected = buildSimple7702DeploymentTransaction();
  const fail = () => new Error('Simple7702 deployment receipt differs from the canonical factory call; preserve the pending record.');
  if (pending.kind !== 'simple7702-deploy' || receipt.transactionHash.toLowerCase() !== pending.hash.toLowerCase() ||
      receipt.from.toLowerCase() !== config.wallet.toLowerCase() || receipt.to?.toLowerCase() !== expected.to.toLowerCase()) throw fail();
  const tx = await chain.publicClient.getTransaction({ hash: pending.hash as Hex });
  if (tx.type !== 'legacy' || tx.hash.toLowerCase() !== pending.hash.toLowerCase() || tx.chainId !== 4663 ||
      tx.from.toLowerCase() !== config.wallet.toLowerCase() || tx.to?.toLowerCase() !== expected.to.toLowerCase() ||
      tx.nonce !== pending.nonce || tx.value !== 0n || tx.input.toLowerCase() !== expected.data.toLowerCase() ||
      tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) throw fail();
  if (receipt.status === 'success' && await readSimple7702Deployment(chain) !== 'deployed') throw fail();
}
