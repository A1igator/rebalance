import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { keccak256, parseTransaction, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';
import { acquireLock, atomicWriteJson } from '../src/storage.js';
import { deploySimple7702, parseDeploymentArgs, type Dependencies, type Journal, type Options } from '../scripts/deploy-simple7702.js';
import { buildSimple7702DeploymentTransaction } from '../scripts/simple7702-deployment-proof.js';
import { SIMPLE7702_ADDRESS } from '../src/simple7702.js';
import type { Chain } from '../src/transactions.js';
import type { LegacyPreparedTransaction } from '../src/privy.js';

// Deterministic PUBLIC FIXTURE key, local RPC mocks only. No Ledger, real root,
// configured RPC transport, funded account or real transaction is accessed.
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const wallet = account.address, other = '0x1000000000000000000000000000000000000002' as Address;
const artifact = JSON.parse(await readFile(new URL('../src/artifacts/simple7702.json', import.meta.url), 'utf8'));
const call = buildSimple7702DeploymentTransaction(), blockHash = `0x${'ab'.repeat(32)}` as Hex;
const sandbox = await mkdtemp(join(tmpdir(), 'rebalance-oneoff-deploy-')); assertTemporaryTestDirectory(sandbox);
after(() => rm(sandbox, { recursive: true, force: true }));
async function snapshot(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(path)).sort()) result[name] = await readFile(join(path, name), 'utf8');
  return result;
}
async function fixture() {
  const base = await mkdtemp(join(sandbox, 'case-')), rootDir = join(base, 'portfolio'), journalDir = join(base, 'oneoff');
  await mkdir(rootDir); await mkdir(journalDir);
  const config = { version: 1, chainId: 4663, mode: 'ledger', wallet, rpcUrl: 'http://127.0.0.1:1',
    targets: { USDG: 500, AAPL: 2375, AMD: 2375, NVDA: 2375, MSFT: 2375 }, driftThresholdBps: 500,
    slippageBps: 50, deadlineSeconds: 120, pollSeconds: 5, rebalanceIntervalSeconds: 3600 };
  await writeFile(join(rootDir, 'config.json'), JSON.stringify(config));
  await writeFile(join(rootDir, 'stop.json'), JSON.stringify({ requestedAt: '2026-09-13T00:00:00Z', id: 'fixture-stop' }));
  for (const name of ['cycle.json', 'status.json', 'runner-preference.json']) await writeFile(join(rootDir, name), JSON.stringify({ fixture: name }));
  const options: Options = { wallet, rootDir, journal: join(journalDir, 'deployment.json'), send: false };
  const state = { chainId: 4663, code: '0x' as Hex, factory: artifact.factoryRuntimeBytecode as Hex, latest: 4, pending: 4,
    estimate: 850_000n, price: 10n, balance: 100_000_000n, head: 101n, canonicalHash: blockHash,
    sendMode: 'ok', missingReceipt: false, signed: 0, signers: 0, sent: 0, calls: 0, estimated: 0 };
  let prepared: LegacyPreparedTransaction | undefined;
  let mined: any = null, receipt: any = null;
  let signHook: (tx: LegacyPreparedTransaction, signal: AbortSignal) => Promise<Hex> = tx => account.signTransaction(tx);
  const rpc = {
    async getChainId() { return state.chainId; }, async getBlockNumber() { return state.head; },
    async getCode({ address }: { address: Address }) { return address.toLowerCase() === SIMPLE7702_ADDRESS.toLowerCase() ? state.code : state.factory; },
    async getTransactionCount({ blockTag }: { blockTag: string }) { return blockTag === 'latest' ? state.latest : state.pending; },
    async call(input: any) { state.calls++; assert.equal(input.account, wallet); assert.deepEqual({ to: input.to, value: input.value, data: input.data }, call); return { data: SIMPLE7702_ADDRESS }; },
    async estimateGas(input: any) { state.estimated++; assert.equal(input.value, 0n); assert.equal(input.data, call.data); return state.estimate; },
    async getGasPrice() { return state.price; }, async getBalance() { return state.balance; },
    async sendRawTransaction({ serializedTransaction }: { serializedTransaction: Hex }) {
      state.sent++;
      const journal: Journal = JSON.parse(await readFile(options.journal, 'utf8'));
      assert.equal(journal.hash, keccak256(serializedTransaction), 'durable exact hash exists before broadcast');
      assert.ok(!JSON.stringify(journal).includes(serializedTransaction));
      const decoded = parseTransaction(serializedTransaction);
      assert.equal(decoded.type, 'legacy'); assert.equal(decoded.to?.toLowerCase(), call.to.toLowerCase());
      assert.equal(decoded.value ?? 0n, 0n); assert.equal(decoded.data, call.data); assert.equal(decoded.chainId, 4663);
      mined = { ...decoded, hash: journal.hash, from: wallet, input: decoded.data, value: decoded.value ?? 0n, blockNumber: 100n, blockHash };
      receipt = { transactionHash: journal.hash, from: wallet, to: call.to, blockNumber: 100n, blockHash, status: 'success' };
      if (state.sendMode === 'timeout') throw new Error(`simulated transport error containing ${serializedTransaction}`);
      if (state.sendMode === 'wrong-hash') return `0x${'cd'.repeat(32)}`;
      return journal.hash;
    },
    async getTransactionReceipt() { if (state.missingReceipt || !receipt) throw new Error('fixture missing receipt'); return receipt; },
    async getTransaction() { return mined; }, async getBlock() { return { hash: state.canonicalHash }; },
  };
  const dependencies: Dependencies = { chain: { publicClient: rpc } as unknown as Chain,
    signer: async (_wallet, input) => { state.signers++; assert.equal(_wallet, wallet); assert.equal(input.rootDir, rootDir);
      assert.ok((await readdir(rootDir)).includes('run.lock'), 'wallet run lock held throughout signing');
      return { address: wallet, signTransaction: async tx => { state.signed++; prepared = tx as LegacyPreparedTransaction; return signHook(prepared, input.signal); } }; } };
  const run = (send = false, patch: Partial<Options> = {}, deps: Partial<Dependencies> = {}) =>
    deploySimple7702({ ...options, send, ...(send ? { maxFeeWei: 20_000_000n } : {}), ...patch }, { ...dependencies, ...deps });
  return { base, options, state, rpc, dependencies, run, config, setSign: (fn: typeof signHook) => { signHook = fn; },
    prepared: () => prepared!, tx: () => mined, receipt: () => receipt, journal: async () => JSON.parse(await readFile(options.journal, 'utf8')) as Journal,
    unchanged: async (before: Record<string, string>) => assert.deepEqual(await snapshot(rootDir), before) };
}

test('explicit parser defaults to read-only and rejects ambiguous send intent', () => {
  const args = ['--wallet', wallet, '--root-dir', '/tmp/portfolio', '--journal', '/tmp/oneoff/deploy.json'];
  assert.equal(parseDeploymentArgs(args).send, false);
  assert.equal(parseDeploymentArgs([...args, '--send', '--max-fee-wei', '123']).maxFeeWei, 123n);
  for (const suffix of [['--send'], ['--send', '--send'], ['--max-fee-wei', '0'], ['--max-fee-wei', '-1'], ['--max-fee-wei', '1e9'], ['--other'], ['--wallet', other]])
    assert.throws(() => parseDeploymentArgs([...args, ...suffix]));
  assert.throws(() => parseDeploymentArgs(['--wallet', wallet, '--root-dir', 'relative', '--journal', '/tmp/oneoff/deploy.json']));
});

test('read-only prepare reports buffered ETH fees without loading a signer, writing a journal or touching portfolio state', async () => {
  const f = await fixture(), before = await snapshot(f.options.rootDir);
  const result = await f.run();
  assert.equal(result.outcome, 'ready'); assert.equal('gasLimit' in result && result.gasLimit, '1020000');
  assert.equal('gasPriceWei' in result && result.gasPriceWei, '12'); assert.equal('maximumNetworkFeeWei' in result && result.maximumNetworkFeeWei, '12240000');
  assert.equal(f.state.signers, 0); assert.equal(f.state.sent, 0); await assert.rejects(readFile(f.options.journal)); await f.unchanged(before);
});

test('exact canonical legacy deployment has one fixture signature, durable public pre-send journal, and no portfolio changes', async () => {
  const f = await fixture(), before = await snapshot(f.options.rootDir), result = await f.run(true);
  assert.equal(result.outcome, 'broadcast'); assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 1);
  assert.deepEqual(f.prepared(), { ...call, type: 'legacy', chainId: 4663, nonce: 4, gas: 1_020_000n, gasPrice: 12n });
  const j = await f.journal(); assert.equal(j.kind, 'simple7702-deploy'); assert.equal(j.nonce, 4);
  assert.deepEqual(Object.keys(j).sort(), ['chainId', 'createdAt', 'gas', 'gasPrice', 'hash', 'kind', 'maxFeeWei', 'nonce', 'payloadHash', 'version', 'wallet']);
  assert.equal(f.state.calls, 2); await f.unchanged(before);
});

test('deployment already present is read-only even with explicit send', async () => {
  const f = await fixture(), before = await snapshot(f.options.rootDir); f.state.code = artifact.runtimeBytecode;
  assert.equal((await f.run(true)).outcome, 'already-deployed'); assert.equal(f.state.signers, 0); await f.unchanged(before);
});

test('active wallet, missing Stop, pending transaction, fee limit and low balance block before a signer', async t => {
  for (const issue of ['active', 'no-stop', 'pending', 'fee', 'balance', 'nonce', 'factory', 'chain']) await t.test(issue, async () => {
    const f = await fixture(); let release: (() => Promise<void>) | undefined;
    if (issue === 'active') release = await acquireLock(f.options.rootDir, 'run.lock');
    if (issue === 'no-stop') await rm(join(f.options.rootDir, 'stop.json'));
    if (issue === 'pending') await writeFile(join(f.options.rootDir, 'pending.json'), '{}');
    if (issue === 'balance') f.state.balance = 1n;
    if (issue === 'nonce') f.state.pending++;
    if (issue === 'factory') f.state.factory = '0x00';
    if (issue === 'chain') f.state.chainId = 1;
    const before = await snapshot(f.options.rootDir);
    try { await assert.rejects(f.run(true, issue === 'fee' ? { maxFeeWei: 1n } : {})); await f.unchanged(before); }
    finally { await release?.(); }
    assert.equal(f.state.signers, 0); assert.equal(f.state.sent, 0); await assert.rejects(readFile(f.options.journal));
  });
});

test('state or fee mutation after hardware review blocks broadcast and never writes a deployment journal', async t => {
  for (const issue of ['config', 'same-stop-replacement', 'pending', 'nonce', 'gas', 'price', 'balance', 'deployed', 'wrong-signature', 'wrong-payload', 'reject']) await t.test(issue, async () => {
    const f = await fixture();
    f.setSign(async tx => {
      if (issue === 'config') await writeFile(join(f.options.rootDir, 'config.json'), JSON.stringify({ ...f.config, pollSeconds: 6 }));
      if (issue === 'same-stop-replacement') { const p = join(f.options.rootDir, 'stop.json'); await writeFile(`${p}.replace`, await readFile(p)); await rename(`${p}.replace`, p); }
      if (issue === 'pending') await writeFile(join(f.options.rootDir, 'pending.json'), '{}');
      if (issue === 'nonce') { f.state.latest++; f.state.pending++; }
      if (issue === 'gas') f.state.estimate = tx.gas + 1n;
      if (issue === 'price') f.state.price = tx.gasPrice + 1n;
      if (issue === 'balance') f.state.balance = 1n;
      if (issue === 'deployed') f.state.code = artifact.runtimeBytecode;
      if (issue === 'reject') throw new Error('fixture physical rejection');
      if (issue === 'wrong-signature') return privateKeyToAccount(`0x${'22'.repeat(32)}`).signTransaction(tx);
      return account.signTransaction(issue === 'wrong-payload' ? { ...tx, value: 1n } : tx);
    });
    await assert.rejects(f.run(true)); assert.equal(f.state.sent, 0); await assert.rejects(readFile(f.options.journal));
    assert.ok(!(await readdir(f.options.rootDir)).includes('run.lock'));
  });
});

test('Stop replacement aborts an outstanding prompt without relying on the signer returning', async () => {
  const f = await fixture();
  f.setSign(async (_tx, signal) => {
    await writeFile(join(f.options.rootDir, 'stop.json'), '{"id":"new-stop"}');
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await assert.rejects(f.run(true)); assert.equal(f.state.sent, 0); await assert.rejects(readFile(f.options.journal));
});

test('journal persistence failure or post-persistence Stop mutation never broadcasts', async t => {
  for (const issue of ['write-failed', 'post-write-stop']) await t.test(issue, async () => {
    const f = await fixture();
    await assert.rejects(f.run(true, {}, { persist: async (path, value) => {
      if (issue === 'write-failed') throw new Error('fixture disk failure');
      await atomicWriteJson(path, value); await writeFile(join(f.options.rootDir, 'stop.json'), '{"id":"later-stop"}');
    } }));
    assert.equal(f.state.sent, 0);
    if (issue === 'write-failed') await assert.rejects(readFile(f.options.journal));
    else { assert.equal((await f.journal()).kind, 'simple7702-deploy'); assert.equal((await f.run(true)).outcome, 'unresolved'); assert.equal(f.state.signed, 1); }
  });
});

test('unknown broadcast outcomes retain the exact journal and repeated --send only reads receipts', async t => {
  for (const mode of ['timeout', 'wrong-hash']) await t.test(mode, async () => {
    const f = await fixture(); f.state.sendMode = mode;
    const result = await f.run(true); assert.equal(result.outcome, 'unresolved');
    assert.ok(!JSON.stringify(result).includes(call.data)); const before = await readFile(f.options.journal, 'utf8');
    f.state.missingReceipt = true;
    assert.equal((await f.run(true)).outcome, 'unresolved'); assert.equal((await f.run()).outcome, 'unresolved');
    assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 1); assert.equal(await readFile(f.options.journal, 'utf8'), before);
  });
});

test('two-confirmation exact canonical deployment receipt is observed without another signature or portfolio changes', async () => {
  const f = await fixture(), before = await snapshot(f.options.rootDir); await f.run(true); f.state.code = artifact.runtimeBytecode;
  const saved = await readFile(f.options.journal, 'utf8');
  assert.equal((await f.run(true)).outcome, 'confirmed'); assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 1);
  assert.equal(await readFile(f.options.journal, 'utf8'), saved); await f.unchanged(before);
});

test('unconfirmed and reverted receipts are distinct and retain the public barrier', async () => {
  const f = await fixture(); await f.run(true); f.state.head = 100n;
  assert.equal((await f.run()).outcome, 'confirming'); f.state.head = 101n; f.receipt().status = 'reverted';
  assert.equal((await f.run()).outcome, 'reverted'); assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 1); assert.ok(await f.journal());
});

test('wrong receipt or mined transaction proof cannot claim deployment and preserves journal', async t => {
  const cases: [string, (f: Awaited<ReturnType<typeof fixture>>) => void][] = [
    ['receipt-hash', f => { f.receipt().transactionHash = `0x${'cd'.repeat(32)}`; }],
    ['receipt-from', f => { f.receipt().from = other; }], ['receipt-to', f => { f.receipt().to = other; }],
    ['transaction-hash', f => { f.tx().hash = `0x${'cd'.repeat(32)}`; }], ['input', f => { f.tx().input = '0x'; }],
    ['nonce', f => { f.tx().nonce++; }], ['value', f => { f.tx().value = 1n; }], ['sender', f => { f.tx().from = other; }],
    ['type', f => { f.tx().type = 'eip1559'; }], ['gas', f => { f.tx().gas++; }], ['gasPrice', f => { f.tx().gasPrice++; }],
    ['missing-code', f => { f.state.code = '0x'; }], ['foreign-code', f => { f.state.code = '0x00'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = await fixture(); await f.run(true); f.state.code = artifact.runtimeBytecode; mutate(f);
    const saved = await readFile(f.options.journal, 'utf8'); await assert.rejects(f.run(true));
    assert.equal(await readFile(f.options.journal, 'utf8'), saved); assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 1);
  });
});

test('mismatched journal and journal links are never read as permission to retry', async t => {
  for (const mode of ['wallet', 'payloadHash', 'extra-field', 'link', 'in-root']) await t.test(mode, async () => {
    const f = await fixture(); await f.run(true); const saved = await f.journal();
    if (mode === 'wallet') await writeFile(f.options.journal, JSON.stringify({ ...saved, wallet: other }));
    if (mode === 'payloadHash') await writeFile(f.options.journal, JSON.stringify({ ...saved, payloadHash: `0x${'00'.repeat(32)}` }));
    if (mode === 'extra-field') await writeFile(f.options.journal, JSON.stringify({ ...saved, rawTransaction: '0x' }));
    if (mode === 'link') { await rename(f.options.journal, `${f.options.journal}.saved`); await symlink(`${f.options.journal}.saved`, f.options.journal); }
    await assert.rejects(f.run(true, mode === 'in-root' ? { journal: join(f.options.rootDir, 'deployment.json') } : {}));
    assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 1);
  });
});


test('nonce consumed while final fee simulation waits is rechecked before any journal or broadcast', async () => {
  const f = await fixture();
  const balance = f.rpc.getBalance;
  f.rpc.getBalance = async () => {
    if (f.state.signed) { await new Promise(resolve => setTimeout(resolve, 15)); f.state.latest++; f.state.pending++; }
    return balance();
  };
  await assert.rejects(f.run(true), /during the final fee check/);
  assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 0); await assert.rejects(readFile(f.options.journal));
});
