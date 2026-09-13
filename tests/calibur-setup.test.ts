import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { decodeFunctionData, keccak256, parseTransaction, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CALIBUR_ABI, CALIBUR_ADDRESS, CALIBUR_DELEGATION_CODE } from '../src/calibur.js';
import { atomicWriteJson, readJson, acquireLock, type PendingTransaction } from '../src/storage.js';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';
import type { CaliburAuthorizationRequest, PreparedTransaction } from '../src/privy.js';
import type { FeeTargetInput } from '../src/fee-target.js';

// Published disposable signing vector; never loads a device, credential or RPC.
const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`), wallet = account.address;
const data = await mkdtemp(join(tmpdir(), 'rebalance-calibur-setup-'));
assertTemporaryTestDirectory(data); process.env.REBALANCE_DATA_DIR = data;
const { CONFIG_PATH, DATA, PENDING_PATH, validateConfig } = await import('../src/config.js');
assert.equal(DATA, data);
const { setupCalibur, caliburSetupStatus } = await import('../src/calibur-setup.js');
type Dependencies = NonNullable<Parameters<typeof setupCalibur>[1]>;
const evidence = JSON.parse(await readFile(new URL('../docs/evidence/calibur-deployment.json', import.meta.url), 'utf8'));
const implementation = evidence.runtimeBytecode as Hex;
const stopPath = join(data, 'stop.json');
const untouched = ['config.json', 'stop.json', 'cycle.json', 'runner-preference.json', 'status.json'];
function configuration(target?: string) {
  return validateConfig({ version: 1, chainId: 4663, wallet, mode: 'ledger', execution: 'calibur', rpcUrl: 'http://127.0.0.1:1',
    targets: { USDG: 500, AAPL: 2375, AMD: 2375, NVDA: 2375, MSFT: 2375 }, driftThresholdBps: 500,
    slippageBps: 50, deadlineSeconds: 120, pollSeconds: 5, ...(target ? { rebalanceFeeTargetUsdE8: target } : {}) });
}
async function protectedState() { return Promise.all(untouched.map(name => readFile(join(data, name), 'utf8'))); }
beforeEach(async () => {
  await rm(data, { recursive: true, force: true }); await mkdir(data, { mode: 0o700 });
  await atomicWriteJson(CONFIG_PATH, configuration());
  await atomicWriteJson(stopPath, { requestedAt: 1, requestId: 'existing-owner-stop' });
  await atomicWriteJson(join(data, 'cycle.json'), { fixture: 'unchanged cadence' });
  await atomicWriteJson(join(data, 'runner-preference.json'), { enabled: false });
  await atomicWriteJson(join(data, 'status.json'), { armed: false, fixture: 'unchanged holdings' });
});
after(() => rm(data, { recursive: true, force: true }));
function fixture(delegated = false) {
  const state = { nonce: 7, confirmed: 7, accountCode: delegated ? CALIBUR_DELEGATION_CODE as Hex | undefined : undefined,
    implementation, balance: 10n ** 18n, receipt: 'missing' as 'missing' | 'success' | 'reverted',
    receiptTo: wallet, head: 101n };
  const authorizations: CaliburAuthorizationRequest[] = [], signed: PreparedTransaction[] = [], sent: Hex[] = [], estimates: unknown[] = [], trace: string[] = [];
  let afterAuthorization: (() => Promise<void>) | undefined, afterSignature: (() => Promise<void>) | undefined;
  let signerLoads = 0, signingSignal: AbortSignal | undefined;
  const rpc = {
    async getChainId() { return 4663; }, async getBlockNumber() { return state.head; },
    async getCode({ address }: { address: Address }) { return address.toLowerCase() === CALIBUR_ADDRESS.toLowerCase() ? state.implementation : state.accountCode; },
    async getTransactionCount({ blockTag }: { blockTag: string }) { return blockTag === 'pending' ? state.nonce : state.confirmed; },
    async estimateGas(input: unknown) { estimates.push(input); trace.push('estimate'); return 40_000n; },
    async getGasPrice() { return 500_000_000n; }, async getBalance() { trace.push('balance'); return state.balance; },
    async sendRawTransaction({ serializedTransaction }: { serializedTransaction: Hex }) {
      const pending = await readJson<PendingTransaction>(PENDING_PATH);
      assert.equal(pending?.kind, 'calibur-setup'); assert.equal(pending?.status, 'prepared'); assert.equal(pending?.hash, keccak256(serializedTransaction));
      trace.push('send'); sent.push(serializedTransaction); return keccak256(serializedTransaction);
    },
    async getTransactionReceipt({ hash }: { hash: Hex }) {
      if (state.receipt === 'missing') throw new TransactionReceiptNotFoundError({ hash });
      return { transactionHash: hash, status: state.receipt, from: wallet, to: state.receiptTo,
        blockNumber: 100n, blockHash: `0x${'ab'.repeat(32)}` as Hex };
    },
    async getTransaction({ hash }: { hash: Hex }) {
      const tx = parseTransaction(sent.at(-1)!);
      return { ...tx, hash, from: wallet, to: wallet, value: tx.value ?? 0n, input: tx.data,
        blockNumber: 100n, blockHash: `0x${'ab'.repeat(32)}` as Hex };
    },
    async getBlock() { return { hash: `0x${'ab'.repeat(32)}` as Hex }; },
  };
  const signer: NonNullable<Dependencies['signer']> = async (_config, options = {}) => {
    signerLoads++; signingSignal = options.signal;
    return { address: wallet,
      async signDelegationAuthorization(request) { trace.push('authorize'); authorizations.push(request);
        const result = await account.signAuthorization(request); await afterAuthorization?.(); return result; },
      async signTransaction(input) { trace.push('sign'); signed.push(input);
        const result = await account.signTransaction(input); await afterSignature?.(); return result; },
    };
  };
  const deps: Dependencies = { chain: { publicClient: rpc } as unknown as Dependencies['chain'], signer };
  return { state, rpc, deps, authorizations, signed, sent, estimates, trace,
    get signerLoads() { return signerLoads; }, get signal() { return signingSignal; },
    afterAuthorization(fn: () => Promise<void>) { afterAuthorization = fn; }, afterSignature(fn: () => Promise<void>) { afterSignature = fn; } };
}

test('standalone setup signs authN+1 and one empty type4 self-call while preserving Stop, holdings and cadence', async () => {
  const f = fixture(), before = await protectedState();
  const result = await setupCalibur({}, f.deps);
  assert.equal(result.outcome, 'pending'); assert.equal(f.authorizations.length, 1); assert.equal(f.signed.length, 1); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.authorizations[0], { chainId: 4663, address: CALIBUR_ADDRESS, nonce: 8 });
  const parsed = parseTransaction(f.sent[0]!);
  assert.equal(parsed.type, 'eip7702'); assert.equal(parsed.chainId, 4663); assert.equal(parsed.nonce, 7);
  assert.equal(parsed.to?.toLowerCase(), wallet.toLowerCase()); assert.equal(parsed.value ?? 0n, 0n);
  assert.equal(parsed.gas, 78_000n); assert.equal(parsed.maxFeePerGas, 600_000_000n);
  const batch = decodeFunctionData({ abi: CALIBUR_ABI, data: parsed.data! }).args[0];
  assert.deepEqual(batch, { calls: [], revertOnFailure: true });
  assert.deepEqual(f.estimates, [{ account: wallet, to: wallet, data: parsed.data, value: 0n,
    stateOverride: [{ address: wallet, code: CALIBUR_DELEGATION_CODE }] }]);
  assert.ok(f.trace.indexOf('estimate') < f.trace.indexOf('authorize')); assert.ok(f.trace.indexOf('balance') < f.trace.indexOf('authorize'));
  assert.deepEqual(await protectedState(), before);
  const pending = await readJson<PendingTransaction>(PENDING_PATH);
  assert.equal(pending?.kind, 'calibur-setup'); assert.equal(pending?.nonce, 7); assert.equal(pending?.status, 'broadcast');
  assert.ok(!JSON.stringify(pending).includes('authorization'));
  assert.deepEqual((await readdir(data)).sort(), [...untouched, 'pending.json', 'calibur-setup-status.json'].sort());
});

test('already-enabled Calibur needs no signer, simulation or transaction', async () => {
  const f = fixture(true), before = await protectedState();
  assert.equal((await setupCalibur({}, f.deps)).outcome, 'already-enabled');
  assert.equal(f.signerLoads, 0); assert.equal(f.estimates.length, 0); assert.equal(f.sent.length, 0);
  assert.deepEqual(await protectedState(), before); assert.equal(await readJson(PENDING_PATH), null);
});

test('active runner, wrong mode, foreign delegate and changed implementation fail closed before signing', async () => {
  const f = fixture();
  const release = await acquireLock(data, 'run.lock');
  try { await assert.rejects(setupCalibur({}, f.deps), /Lock run.lock/); } finally { await release(); }
  for (const config of [{ ...configuration(), execution: 'direct' }, { ...configuration(), execution: 'direct', mode: 'private-key' }]) {
    await atomicWriteJson(CONFIG_PATH, config); await assert.rejects(setupCalibur({}, f.deps), /saved Ledger Calibur/);
  }
  await atomicWriteJson(CONFIG_PATH, configuration());
  f.state.accountCode = `0xef0100${'ab'.repeat(20)}`;
  await assert.rejects(setupCalibur({}, f.deps), /different delegation/);
  f.state.accountCode = undefined; f.state.implementation = '0x6000';
  await assert.rejects(setupCalibur({}, f.deps), /pinned runtime/);
  assert.equal(f.signerLoads, 0); assert.equal(f.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('setup refuses another pending nonce, missing full-call simulation and insufficient native ETH before loading Ledger', async () => {
  const mismatch = fixture(); mismatch.state.nonce++;
  await assert.rejects(setupCalibur({}, mismatch.deps), /another transaction is pending/); assert.equal(mismatch.signerLoads, 0);
  const unavailable = fixture(); unavailable.rpc.estimateGas = async () => { throw new Error('fixture unsupported override'); };
  const failedSimulation = await setupCalibur({}, unavailable.deps);
  assert.equal(failedSimulation.outcome, 'blocked'); assert.equal(failedSimulation.blockedReason, 'simulation-failed'); assert.equal(unavailable.signerLoads, 0);
  const poor = fixture(); poor.state.balance = 78_000n * 600_000_000n - 1n;
  const insufficient = await setupCalibur({}, poor.deps);
  assert.equal(insufficient.outcome, 'blocked'); assert.equal(insufficient.blockedReason, 'insufficient-eth'); assert.equal(poor.signerLoads, 0);
  assert.equal(await readJson(PENDING_PATH), null);
});

test('setup fee target counts only complete enrollment gas and blocks before either signature', async t => {
  const f = fixture(); await atomicWriteJson(CONFIG_PATH, configuration('5000000'));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount: '3000' } })));
  const { checkRebalanceFee } = await import('../src/fee-target.js');
  const inputs: FeeTargetInput[] = [];
  const result = await setupCalibur({}, { ...f.deps, async checkFee(input) { inputs.push(input); return checkRebalanceFee(input); } });
  assert.equal(result.outcome, 'blocked'); assert.equal(result.blockedReason, 'fee-above-target');
  assert.deepEqual(inputs, [{ targetUsdE8: '5000000', kind: 'calibur-setup', swaps: 0, swapsInCurrentTransaction: 0,
    remainingApprovals: 0, gas: 78_000n, gasPrice: 600_000_000n }]);
  assert.equal(f.signerLoads, 0); assert.equal(f.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('changed Stop generation, settings, account or nonce during authorization prevents the outer signature', async () => {
  for (const change of ['new-stop', 'same-stop-replaced', 'config', 'nonce', 'delegate', 'implementation']) {
    const f = fixture(); await atomicWriteJson(CONFIG_PATH, configuration());
    f.afterAuthorization(async () => {
      if (change === 'new-stop') await atomicWriteJson(stopPath, { requestedAt: Date.now() });
      if (change === 'same-stop-replaced') await atomicWriteJson(stopPath, await readJson(stopPath));
      if (change === 'config') await atomicWriteJson(CONFIG_PATH, { ...configuration(), slippageBps: 51 });
      if (change === 'nonce') f.state.nonce++;
      if (change === 'delegate') f.state.accountCode = CALIBUR_DELEGATION_CODE;
      if (change === 'implementation') f.state.implementation = '0x6000';
    });
    await assert.rejects(setupCalibur({}, f.deps), /Stop changed|account or nonce changed|pinned runtime/);
    assert.equal(f.authorizations.length, 1); assert.equal(f.signed.length, 0); assert.equal(f.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
  }
});

test('a new Stop actively cancels a waiting device authorization without a reconnect', async () => {
  const f = fixture(); let entered!: () => void;
  const authorizing = new Promise<void>(resolve => { entered = resolve; });
  f.afterAuthorization(async () => {
    entered();
    await new Promise<void>((_resolve, reject) => {
      const signal = f.signal!; signal.throwIfAborted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const pending = setupCalibur({}, f.deps); const rejected = assert.rejects(pending, /Stop changed/);
  await authorizing; await atomicWriteJson(stopPath, { requestedAt: Date.now(), requestId: 'new-owner-stop' });
  await rejected;
  assert.equal(f.signal?.aborted, true); assert.equal(f.signed.length, 0); assert.equal(f.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('authorization rejection, post-sign nonce changes and caller cancellation never broadcast', async () => {
  const rejected = fixture(); rejected.afterAuthorization(async () => { throw new Error('fixture rejected'); });
  await assert.rejects(setupCalibur({}, rejected.deps), /fixture rejected/); assert.equal(rejected.signed.length, 0);
  const changed = fixture(); changed.afterSignature(async () => { changed.state.nonce++; });
  await assert.rejects(setupCalibur({}, changed.deps), /account or nonce changed/); assert.equal(changed.signed.length, 1); assert.equal(changed.sent.length, 0);
  const canceled = fixture(), controller = new AbortController(); canceled.afterAuthorization(async () => { controller.abort(new Error('fixture canceled')); });
  await assert.rejects(setupCalibur({ signal: controller.signal }, canceled.deps), /fixture canceled/); assert.equal(canceled.signed.length, 0);
  assert.equal(await readJson(PENDING_PATH), null);
});

test('unknown setup send keeps one hash; repeating setup is receipt-only and does not authorize or send again', async () => {
  const f = fixture(), before = await protectedState();
  f.rpc.sendRawTransaction = async ({ serializedTransaction }) => { f.sent.push(serializedTransaction); throw new Error('fixture lost response'); };
  const first = await setupCalibur({}, f.deps); assert.equal(first.outcome, 'unresolved');
  const pending = await readJson<PendingTransaction>(PENDING_PATH); assert.equal(pending?.status, 'unknown'); assert.equal(pending?.nonce, 7);
  const second = await setupCalibur({}, f.deps); assert.equal(second.outcome, 'unresolved'); assert.equal(second.hash, first.hash);
  assert.equal(f.signerLoads, 1); assert.equal(f.authorizations.length, 1); assert.equal(f.sent.length, 1);
  assert.deepEqual(await readJson(PENDING_PATH), pending); assert.deepEqual(await protectedState(), before);
});

test('setup receipt confirmation requires exact current delegation and preserves cadence and Stop', async () => {
  const f = fixture(), before = await protectedState(); await setupCalibur({}, f.deps);
  f.state.receipt = 'success'; f.state.nonce = 9; f.state.confirmed = 9;
  await assert.rejects(setupCalibur({}, f.deps), /expected empty self-call and current delegation/); assert.ok(await readJson(PENDING_PATH));
  f.state.accountCode = `0xef0100${'ab'.repeat(20)}`;
  await assert.rejects(setupCalibur({}, f.deps), /different delegation/); assert.ok(await readJson(PENDING_PATH));
  f.state.accountCode = CALIBUR_DELEGATION_CODE; f.state.implementation = '0x6000';
  await assert.rejects(setupCalibur({}, f.deps), /pinned runtime/); assert.ok(await readJson(PENDING_PATH));
  f.state.implementation = implementation; f.state.receiptTo = CALIBUR_ADDRESS;
  await assert.rejects(setupCalibur({}, f.deps), /expected empty self-call and current delegation/); assert.ok(await readJson(PENDING_PATH));
  f.state.receiptTo = wallet; const confirmed = await setupCalibur({}, f.deps);
  assert.equal(confirmed.outcome, 'confirmed'); assert.equal(await readJson(PENDING_PATH), null);
  assert.equal(f.signerLoads, 1); assert.equal(f.sent.length, 1); assert.deepEqual(await protectedState(), before);
  assert.equal((await readJson<{ kind: string }>(join(data, 'last-transaction.json')))?.kind, 'calibur-setup');
});

test('an existing other transaction is reconciled only, even if its receipt clears in this invocation', async () => {
  const f = fixture(); f.state.receipt = 'success';
  const hash = `0x${'ab'.repeat(32)}`;
  await atomicWriteJson(PENDING_PATH, { chainId: 4663, wallet, hash, nonce: 5, kind: 'approval', status: 'broadcast', createdAt: new Date().toISOString() });
  const result = await setupCalibur({}, f.deps);
  assert.equal(result.outcome, 'existing-transaction'); assert.equal(result.pendingKind, 'approval'); assert.equal(result.status, 'confirmed');
  assert.equal(await readJson(PENDING_PATH), null); assert.equal(f.signerLoads, 0); assert.equal(f.sent.length, 0);
});

test('a reverted setup preserves its receipt barrier although delegation may already be installed', async () => {
  const f = fixture(); await setupCalibur({}, f.deps);
  f.state.receipt = 'reverted'; f.state.accountCode = CALIBUR_DELEGATION_CODE; f.state.nonce = 9; f.state.confirmed = 9;
  const pending = await readJson(PENDING_PATH), result = await setupCalibur({}, f.deps);
  assert.equal(result.outcome, 'reverted'); assert.deepEqual(await readJson(PENDING_PATH), pending);
  assert.equal(f.signerLoads, 1); assert.equal(f.authorizations.length, 1); assert.equal(f.sent.length, 1);
});


test('expected Stop token rejects a superseded Start before any device, simulation or signing', async () => {
  const f = fixture();
  const expectedStop = createHash('sha256').update(JSON.stringify(await readJson(stopPath))).digest('hex');
  await atomicWriteJson(stopPath, { requestedAt: Date.now(), requestId: 'new-stop-before-setup' });
  await assert.rejects(setupCalibur({ expectedStop }, f.deps), /newer Stop superseded/);
  assert.equal(f.signerLoads, 0); assert.equal(f.estimates.length, 0); assert.equal(f.sent.length, 0);
  await assert.rejects(setupCalibur({ expectedStop: 'invalid' }, f.deps), /Invalid expected Stop/);
});

test('status is non-signing when enrollment is needed or enabled and exposes only bounded public progress during device waits', async () => {
  const f = fixture();
  assert.equal((await caliburSetupStatus({ chain: f.deps.chain })).outcome, 'needed'); assert.equal(f.signerLoads, 0);
  let entered!: () => void, release!: () => void;
  const authorizing = new Promise<void>(resolve => { entered = resolve; });
  const authorization = new Promise<void>(resolve => { release = resolve; });
  f.afterAuthorization(async () => { entered(); await authorization; });
  const pending = setupCalibur({}, f.deps); await authorizing;
  try {
    const status = await caliburSetupStatus({ chain: f.deps.chain });
    assert.equal(status.outcome, 'authorizing'); assert.equal(status.wallet, wallet);
    const stage = await readFile(join(data, 'calibur-setup-status.json'), 'utf8');
    assert.equal(JSON.parse(stage).stage, 'authorizing');
    assert.ok(!stage.includes('authorizationList')); assert.ok(!stage.includes('"r":')); assert.ok(!stage.includes('"data":'));
  } finally { release(); }
  await pending;
  assert.equal((await caliburSetupStatus({ chain: f.deps.chain })).outcome, 'pending'); assert.equal(f.signerLoads, 1);
  f.state.receipt = 'success'; f.state.nonce = 9; f.state.confirmed = 9; f.state.accountCode = CALIBUR_DELEGATION_CODE;
  assert.equal((await caliburSetupStatus({ chain: f.deps.chain })).outcome, 'confirmed');
  assert.equal((await caliburSetupStatus({ chain: f.deps.chain })).outcome, 'already-enabled');
  assert.equal(f.signerLoads, 1); assert.equal(f.authorizations.length, 1); assert.equal(f.sent.length, 1);
});


test('malformed authorization-bearing adapter output is rejected with a fixed diagnostic and no broadcast', async () => {
  const f = fixture();
  const signer: NonNullable<Dependencies['signer']> = async () => ({ address: wallet,
    async signDelegationAuthorization(request) { return account.signAuthorization(request); },
    async signTransaction() { return '0x04deadbeef'; },
  });
  await assert.rejects(setupCalibur({}, { ...f.deps, signer }), error => {
    assert.equal((error as Error).message, 'Ledger setup transaction differs from its prepared payload');
    assert.ok(!String(error).includes('deadbeef')); return true;
  });
  assert.equal(f.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});


test('known device rejection is blocked without a pending barrier; a fresh explicit setup can retry', async () => {
  const f = fixture(), before = await protectedState();
  const { LedgerSigningError } = await import('../src/ledger-signing.js');
  f.afterAuthorization(async () => { throw new LedgerSigningError('rejected'); });
  const result = await setupCalibur({}, f.deps);
  assert.equal(result.outcome, 'blocked'); assert.equal(result.blockedReason, 'rejected'); assert.equal(result.wallet, wallet);
  assert.equal(result.message, 'Calibur setup was canceled on Ledger. Press Start to retry when ready.');
  assert.equal(await readJson(PENDING_PATH), null); assert.equal(f.signed.length, 0); assert.equal(f.sent.length, 0);
  assert.deepEqual(await protectedState(), before);
  f.afterAuthorization(async () => {});
  assert.equal((await setupCalibur({}, f.deps)).outcome, 'pending');
  assert.equal(f.authorizations.length, 2); assert.equal(f.signed.length, 1); assert.equal(f.sent.length, 1);
});


test('slow no-pending status reads never own run.lock and cannot claim ready after a new setup starts', async () => {
  const f = fixture(true); let entered!: () => void, releaseRead!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { releaseRead = resolve; });
  const getCode = f.rpc.getCode;
  f.rpc.getCode = async input => {
    if (input.address.toLowerCase() === CALIBUR_ADDRESS.toLowerCase()) { entered(); await gate; }
    return getCode(input);
  };
  const status = caliburSetupStatus({ chain: f.deps.chain }); await reading;
  assert.equal(await readJson(join(data, 'run.lock')), null);
  const releaseOwner = await acquireLock(data, 'run.lock');
  try {
    const run = await readJson<{ token: string }>(join(data, 'run.lock'));
    await atomicWriteJson(join(data, 'calibur-setup-status.json'), { version: 1, wallet, chainId: 4663,
      runToken: run!.token, stage: 'authorizing', updatedAt: new Date().toISOString() });
    releaseRead();
    assert.equal((await status).outcome, 'authorizing');
    assert.equal((await readJson<{ token: string }>(join(data, 'run.lock')))?.token, run!.token);
  } finally { releaseRead(); await releaseOwner(); }
  assert.equal(f.signerLoads, 0); assert.equal(f.sent.length, 0);
});


test('a receipt cleared before status acquires its lock uses fresh code only for the observed setup identity', async t => {
  const parse = JSON.parse;
  let removeHash: string | undefined;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    const parsed = parse(...args);
    if (removeHash && parsed?.hash === removeHash) {
      removeHash = undefined;
      // Model another receipt observer clearing the record after this reader
      // obtained its bytes, but before it acquires the exclusive runner lock.
      unlinkSync(PENDING_PATH);
    }
    return parsed;
  });
  for (const kind of ['calibur-setup', 'approval'] as const) {
    const f = fixture(true), hash = `0x${(kind === 'calibur-setup' ? 'ac' : 'bd').repeat(32)}`;
    await atomicWriteJson(PENDING_PATH, { chainId: 4663, wallet, hash, nonce: 7, kind, status: 'broadcast', createdAt: new Date().toISOString() });
    if (kind === 'approval') f.rpc.getCode = async () => assert.fail('An unrelated cleared receipt must not become setup readiness');
    removeHash = hash;
    const result = await caliburSetupStatus({ chain: f.deps.chain });
    assert.equal(result.outcome, kind === 'calibur-setup' ? 'already-enabled' : 'existing-transaction');
    assert.equal(f.signerLoads, 0); assert.equal(f.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
  }
});

test('known Ledger readiness and unavailable fee guards are blocked, but a send-time error is still uncertain', async () => {
  const { LedgerSigningError } = await import('../src/ledger-signing.js');
  const f = fixture();
  const notReady = await setupCalibur({}, { ...f.deps, async signer() { throw new LedgerSigningError('unavailable'); } });
  assert.equal(notReady.outcome, 'blocked'); assert.equal(notReady.blockedReason, 'unavailable'); assert.equal(await readJson(PENDING_PATH), null);
  await atomicWriteJson(CONFIG_PATH, configuration('5000000'));
  const noFee = await setupCalibur({}, { ...f.deps, async checkFee(input) { return { state: 'unavailable', targetUsdE8: input.targetUsdE8,
    estimatedUsdE8: null, gasPriceWei: null, ethUsdE8: null, observedAt: null }; } });
  assert.equal(noFee.outcome, 'blocked'); assert.equal(noFee.blockedReason, 'fee-unavailable'); assert.equal(f.authorizations.length, 0);
  await atomicWriteJson(CONFIG_PATH, configuration());
  f.rpc.sendRawTransaction = async ({ serializedTransaction }) => { f.sent.push(serializedTransaction); throw new LedgerSigningError('unavailable'); };
  const sent = await setupCalibur({}, f.deps);
  assert.equal(sent.outcome, 'unresolved'); assert.equal(sent.blockedReason, undefined); assert.equal(f.sent.length, 1);
  assert.equal((await readJson<PendingTransaction>(PENDING_PATH))?.status, 'unknown');
});
