import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCreate2Address, keccak256, type Hex } from 'viem';
import artifact from '../src/artifacts/simple7702.json' with { type: 'json' };
import { SIMPLE7702_ADDRESS } from '../src/simple7702.js';
import { buildSimple7702DeploymentTransaction, readSimple7702Deployment, verifySimple7702DeploymentReceipt, type DeploymentRecord } from '../scripts/simple7702-deployment-proof.js';
import type { Config } from '../src/config.js';
test('deployment payload exactly reproduces Ledger allowlisted CREATE2 address', () => {
  const tx = buildSimple7702DeploymentTransaction();
  assert.equal(tx.to, artifact.factoryAddress); assert.equal(tx.value, 0n);
  assert.equal(tx.data, artifact.salt + artifact.initCode.slice(2));
  assert.equal(getCreate2Address({ from: tx.to, salt: artifact.salt as Hex, bytecode: artifact.initCode as Hex }).toLowerCase(), SIMPLE7702_ADDRESS.toLowerCase());
  assert.equal(keccak256(artifact.runtimeBytecode as Hex), artifact.runtimeCodeHash);
});
test('public deployment check pins chain, factory, and actual runtime', async () => {
  let implementation: Hex | undefined, factory = artifact.factoryRuntimeBytecode as Hex, chainId = 4663;
  const seen: bigint[] = [];
  const chain = { publicClient: { getChainId: async () => chainId, getBlockNumber: async () => 42n,
    getCode: async ({ address, blockNumber }: { address: string; blockNumber: bigint }) => {
      seen.push(blockNumber); return address.toLowerCase() === SIMPLE7702_ADDRESS.toLowerCase() ? implementation : factory;
    } } } as unknown as Parameters<typeof readSimple7702Deployment>[0];
  assert.equal(await readSimple7702Deployment(chain), 'undeployed'); assert.deepEqual(seen, [42n, 42n]);
  factory = '0x00'; await assert.rejects(readSimple7702Deployment(chain), /factory/);
  implementation = '0x00'; await assert.rejects(readSimple7702Deployment(chain), /runtime/);
  implementation = artifact.runtimeBytecode as Hex; assert.equal(await readSimple7702Deployment(chain), 'deployed');
  chainId = 1; await assert.rejects(readSimple7702Deployment(chain), /Robinhood/);
});
test('successful deployment receipt requires exact calldata and actual installed runtime', async () => {
  const expected = buildSimple7702DeploymentTransaction(), wallet = '0x1111111111111111111111111111111111111111';
  const hash = `0x${'ab'.repeat(32)}` as Hex, blockHash = `0x${'cd'.repeat(32)}` as Hex;
  const pending = { kind: 'simple7702-deploy', wallet, hash, nonce: 7, chainId: 4663 } as DeploymentRecord;
  const receipt = { transactionHash: hash, from: wallet, to: expected.to, status: 'success', blockHash, blockNumber: 100n };
  const tx = { type: 'legacy', hash, from: wallet, to: expected.to, input: expected.data, value: 0n, nonce: 7, chainId: 4663, blockHash, blockNumber: 100n };
  let code: Hex = artifact.runtimeBytecode as Hex;
  const chain = { publicClient: { getTransaction: async () => tx, getChainId: async () => 4663, getBlockNumber: async () => 101n,
    getCode: async () => code } } as unknown as Parameters<typeof verifySimple7702DeploymentReceipt>[1];
  const verify = () => verifySimple7702DeploymentReceipt({ wallet } as unknown as Config, chain, pending, receipt as never);
  await verify(); tx.input = '0x'; await assert.rejects(verify(), /canonical/);
  tx.input = expected.data; code = '0x00'; await assert.rejects(verify(), /runtime/);
});
