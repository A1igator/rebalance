import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { decodeFunctionData, erc20Abi } from 'viem';
import { validateConfig, type Config } from '../src/config.js';
import { ROUTER } from '../src/chain.js';
import { atomicWriteJson } from '../src/storage.js';
import { checkPaymaster, discoverPaymaster, DELEGATION_NOTICE, paymasterProbe, readHiddenProviderKey, runPaymasterCommand,
  type PaymasterCheck, type PaymasterCommandDependencies } from '../src/paymaster-commands.js';
import { PAYMASTER_ACCOUNT_ABI, PAYMASTER_ENTRY_POINT, PAYMASTER_NONCE_KEY, PAYMASTER_USDG } from '../src/paymaster-protocol.js';
import { PaymasterBalanceError } from '../src/paymaster.js';

const wallet = '0x1111111111111111111111111111111111111111';
const paymaster = '0x2222222222222222222222222222222222222222';
const policy = '12345678-1234-1234-1234-123456789abc';
const gasPayment = { provider: 'alchemy' as const, token: 'USDG' as const, policyId: policy, paymaster };
const base = (): Config => validateConfig({ version: 1, chainId: 4663, wallet, mode: 'ledger',
  targets: { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 },
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', driftThresholdBps: 500, slippageBps: 50,
  deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600, rebalanceFeeTargetUsdE8: '5000000' });
const quote = (): PaymasterCheck => ({ state: 'estimate-verified', observedAt: '2026-09-10T12:00:00.000Z', feeTokenAmount: '12000',
  feeUSDG: '0.012', requiresDelegation: true, scope: 'USDG approval probe; not a rebalance fee or execution result' });
function harness(config = base()) {
  let current = structuredClone(config), pending: unknown = null, saves = 0, locked = false;
  const history: string[] = [];
  const deps: PaymasterCommandDependencies = {
    load: async () => structuredClone(current),
    save: async next => { assert.ok(locked); saves++; current = structuredClone(next); history.push('save'); },
    pending: async () => pending,
    lock: async () => { assert.equal(locked, false); locked = true; history.push('lock'); return async () => { locked = false; history.push('unlock'); }; },
    check: async next => { assert.equal(locked, false); assert.deepEqual(next.gasPayment, gasPayment); history.push('check'); return quote(); },
    discover: async (_config, policyId) => { assert.equal(policyId, policy); history.push('discover'); return paymaster; },
    credentialStatus: async () => { history.push('credential-presence'); return 'file-present'; },
    setup: async () => { history.push('setup'); },
  };
  return { deps, history, saves: () => saves, current: () => current, set: (config: Config) => { current = config; }, pending: (value: unknown) => { pending = value; } };
}

test('paymaster status is public presence only and never claims readiness or calls a provider', async () => {
  for (const enabled of [false, true]) {
    const f = harness(validateConfig({ ...base(), ...(enabled ? { gasPayment } : {}) }));
    const result = await runPaymasterCommand(['status'], f.deps);
    assert.equal(result.state, enabled ? 'configured' : 'disabled');
    assert.equal(result.readiness, 'not-checked');
    assert.equal(result.credential, 'file-present');
    assert.deepEqual(f.history, ['credential-presence']); assert.equal(f.saves(), 0);
    assert.equal(result.delegationNotice, DELEGATION_NOTICE);
  }
});

test('configure checks before taking config lock, saves only gasPayment and preserves pending receipts', async () => {
  const f = harness(), original = f.current(), pending = { transport: 'native', hash: 'fixture' };
  f.pending(pending);
  const result = await runPaymasterCommand(['configure', policy, paymaster], f.deps);
  assert.deepEqual(f.history, ['check', 'lock', 'save', 'unlock']);
  assert.deepEqual(f.current(), { ...original, gasPayment });
  assert.equal(result.pendingReceiptPreserved, true); assert.equal(result.state, 'configured');
  assert.equal(result.check?.state, 'estimate-verified');
  assert.match(result.message!, /No signing or transaction/);
  assert.deepEqual(pending, { transport: 'native', hash: 'fixture' });
});

test('policy-only configure discovers the public contract then verifies the full estimation before saving', async () => {
  const f = harness();
  const result = await runPaymasterCommand(['configure', policy], f.deps);
  assert.deepEqual(f.history, ['discover', 'check', 'lock', 'save', 'unlock']);
  assert.deepEqual(result.gasPayment, gasPayment);
  const failed = harness(); failed.deps.discover = async () => { throw new Error('Fixture discovery unavailable'); };
  await assert.rejects(runPaymasterCommand(['configure', policy], failed.deps), /unavailable/);
  assert.equal(failed.saves(), 0); assert.deepEqual(failed.history, []);
});

test('failed estimation or concurrent settings changes cannot enable or overwrite transport', async () => {
  const failed = harness();
  failed.deps.check = async () => { throw new Error('Fixture verification unavailable'); };
  await assert.rejects(runPaymasterCommand(['configure', policy, paymaster], failed.deps), /unavailable/);
  assert.equal(failed.saves(), 0); assert.deepEqual(failed.history, []);
  const raced = harness();
  raced.deps.check = async () => { raced.set({ ...raced.current(), driftThresholdBps: 700 }); return quote(); };
  await assert.rejects(runPaymasterCommand(['configure', policy, paymaster], raced.deps), /settings changed/);
  assert.equal(raced.saves(), 0); assert.equal(raced.current().driftThresholdBps, 700);
  assert.deepEqual(raced.history, ['lock', 'unlock']);
});

test('disable preserves every other setting and existing UserOperation without network or signature', async () => {
  const f = harness(validateConfig({ ...base(), gasPayment })), pending = { transport: 'alchemy-usdg', hash: 'pending-fixture' };
  f.pending(pending);
  const result = await runPaymasterCommand(['disable'], f.deps);
  assert.deepEqual(f.current(), base()); assert.equal(result.transport, 'native-eth');
  assert.equal(result.pendingReceiptPreserved, true); assert.match(result.delegationNotice!, /does not revoke/);
  assert.deepEqual(f.history, ['lock', 'save', 'unlock']); assert.deepEqual(pending, { transport: 'alchemy-usdg', hash: 'pending-fixture' });
});

test('read-only check never edits settings and identifies the probe instead of a rebalance fee', async () => {
  const f = harness(validateConfig({ ...base(), gasPayment }));
  const result = await runPaymasterCommand(['check'], f.deps);
  assert.deepEqual(f.history, ['check']); assert.equal(f.saves(), 0);
  assert.equal(result.check?.scope, 'USDG approval probe; not a rebalance fee or execution result');
  await assert.rejects(runPaymasterCommand(['check'], harness().deps), /No USDG gas transport/);
});

test('invalid public command arguments reject before setup, provider use or writes', async () => {
  const f = harness();
  for (const args of [[], ['setup', 'secret-fixture'], ['status', 'extra'], ['configure', 'secret-fixture', paymaster],
    ['configure', policy, 'secret-fixture'], ['configure', policy, paymaster, 'secret-fixture'], ['enable']]) {
    await assert.rejects(runPaymasterCommand(args, f.deps), error => !(error as Error).message.includes('secret-fixture'));
  }
  assert.deepEqual(f.history, []); assert.equal(f.saves(), 0);
});

test('setup uses only the hidden credential handler, without requiring or creating a wallet', async () => {
  const f = harness(); f.deps.load = async () => assert.fail('Provider credential setup must not load a wallet');
  const result = await runPaymasterCommand(['setup'], f.deps);
  assert.equal(result.state, 'credential-saved'); assert.deepEqual(f.history, ['setup']); assert.equal(f.saves(), 0);
});

test('production check prepares only the zero-allowance USDG probe with onlyEstimation true', async () => {
  const config = validateConfig({ ...base(), gasPayment }), chain = {} as never;
  const input = paymasterProbe();
  assert.equal(input.to, PAYMASTER_USDG); assert.equal(input.value, 0n); assert.equal(input.kind, 'approval');
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: input.data }), { functionName: 'approve', args: [ROUTER, 0n] });
  const result = await checkPaymaster(config, {
    createChain: received => { assert.equal(received, config); return chain; },
    prepare: async (received, receivedChain, tx, onlyEstimation) => {
      assert.equal(received, config); assert.equal(receivedChain, chain); assert.equal(onlyEstimation, true); assert.deepEqual(tx, input);
      return { prepared: { feeTokenAmount: 12000n }, state: { requireAuthorization: true }, observedAt: Date.parse(quote().observedAt) } as never;
    },
  });
  assert.deepEqual(result, quote());
  await assert.rejects(checkPaymaster(config, { createChain: () => chain, prepare: async () => { throw new Error('provider-secret-fixture'); } }), error =>
    /verification failed/.test((error as Error).message) && !(error as Error).message.includes('provider-secret-fixture'));
  await assert.rejects(checkPaymaster(config, { createChain: () => chain, prepare: async () => { throw new PaymasterBalanceError(15001n, 0n); } }), /0\.015001 USDG/);
});

test('paymaster discovery sends only an unsigned probe to the fixed bundler route on chain4663', async () => {
  const calls: unknown[] = [];
  const chain = { publicClient: { getChainId: async () => 4663, readContract: async (request: unknown) => { calls.push(request); return 1n << 64n; } } } as never;
  const result = await discoverPaymaster(base(), policy.toUpperCase(), { createChain: () => chain,
    provider: async (method, params, route) => {
      assert.equal(method, 'pm_getPaymasterStubData'); assert.equal(route, 'bundler');
      const operation = params[0] as { sender: string; nonce: string; callData: `0x${string}` };
      assert.equal(operation.sender, wallet); assert.equal(operation.nonce, '0x10000000000000000');
      assert.deepEqual(Object.keys(operation).sort(), ['callData', 'nonce', 'sender']);
      assert.deepEqual(decodeFunctionData({ abi: PAYMASTER_ACCOUNT_ABI, data: operation.callData }),
        { functionName: 'execute', args: [PAYMASTER_USDG, 0n, paymasterProbe().data] });
      assert.deepEqual(params.slice(1), [PAYMASTER_ENTRY_POINT, '0x1237', { policyId: policy, erc20Context: { tokenAddress: PAYMASTER_USDG } }]);
      return { paymaster, paymasterData: '0x1234' };
    },
  });
  assert.equal(result, paymaster);
  assert.equal((calls[0] as { address: string }).address, PAYMASTER_ENTRY_POINT);
  assert.deepEqual((calls[0] as { args: unknown[] }).args, [wallet, PAYMASTER_NONCE_KEY]);
});

test('discovery rejects invalid policies, chain, nonce and stub response without echoing provider data', async () => {
  let providerCalls = 0;
  const createChain = (id = 4663, nonce: unknown = 1n) => () => ({ publicClient: { getChainId: async () => id, readContract: async () => nonce } }) as never;
  const provider = async () => { providerCalls++; return { paymaster, paymasterData: '0x' }; };
  await assert.rejects(discoverPaymaster(base(), 'secret-fixture', { createChain: () => assert.fail('Invalid policy must not call RPC'), provider }), error =>
    !(error as Error).message.includes('secret-fixture'));
  for (const chain of [createChain(1), createChain(4663, -1n), createChain(4663, '1'), createChain(4663, 2n ** 256n)]) {
    await assert.rejects(discoverPaymaster(base(), policy, { createChain: chain, provider }), /Could not discover/);
  }
  assert.equal(providerCalls, 0);
  for (const reply of [null, [], {}, { paymaster: 'secret-fixture', paymasterData: '0x' }, { paymaster: '0x' + '0'.repeat(40), paymasterData: '0x' },
    { paymaster }, { paymaster, paymasterData: '0x1' }, { paymaster, paymasterData: 'secret-fixture' }]) {
    await assert.rejects(discoverPaymaster(base(), policy, { createChain: createChain(), provider: async () => reply }), error =>
      /Could not discover/.test((error as Error).message) && !(error as Error).message.includes('secret-fixture'));
  }
});

class FakeTty extends EventEmitter {
  isTTY = true; isRaw = false; resumed = false; paused = false;
  setRawMode(value: boolean) { this.isRaw = value; return this; }
  resume() { this.resumed = true; return this; }
  pause() { this.paused = true; return this; }
}
function terminal() {
  const input = new FakeTty(), output: string[] = [];
  return { input, output,
    inputPort: input as unknown as Parameters<typeof readHiddenProviderKey>[0],
    outputPort: { isTTY: true, write: (value: string) => { output.push(value); return true; } } as Parameters<typeof readHiddenProviderKey>[1] };
}

test('local hidden prompt never echoes the key and restores raw mode and listeners', async () => {
  const f = terminal(), pending = readHiddenProviderKey(f.inputPort, f.outputPort);
  f.input.emit('data', Buffer.from('fixture-api-key-12345X\u007f\r'));
  assert.equal(await pending, 'fixture-api-key-12345');
  assert.ok(!f.output.join('').includes('fixture-api-key')); assert.equal(f.input.isRaw, false);
  assert.equal(f.input.paused, true); assert.equal(f.input.listenerCount('data'), 0);
});

test('hidden prompt rejects pipes, cancellation, unsafe paste and timeout without retaining listeners', async () => {
  const pipe = terminal(); pipe.input.isTTY = false;
  await assert.rejects(readHiddenProviderKey(pipe.inputPort, pipe.outputPort), /local terminal/);
  assert.deepEqual(pipe.output, []);
  for (const text of ['fixture-api-key\u0003', 'fixture-api-key\u001b', 'fixture-api-key space', 'a'.repeat(257)]) {
    const f = terminal(), pending = readHiddenProviderKey(f.inputPort, f.outputPort);
    f.input.emit('data', Buffer.from(text));
    await assert.rejects(pending, error => !(error as Error).message.includes('fixture-api-key'));
    assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.input.isRaw, false); assert.equal(f.input.paused, true);
    assert.ok(!f.output.join('').includes('fixture-api-key'));
  }
  const timeout = terminal();
  await assert.rejects(readHiddenProviderKey(timeout.inputPort, timeout.outputPort, 10), /timed out/);
  assert.equal(timeout.input.listenerCount('data'), 0); assert.equal(timeout.input.isRaw, false);
});

test('hidden prompt interruption restores terminal mode without a process signal or echo', async () => {
  const before = new Set(process.listeners('SIGTERM')), f = terminal();
  const pending = readHiddenProviderKey(f.inputPort, f.outputPort);
  f.input.emit('data', Buffer.from('fixture-api-key'));
  const interrupt = process.listeners('SIGTERM').find(listener => !before.has(listener));
  assert.ok(interrupt); interrupt('SIGTERM');
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.input.isRaw, false); assert.equal(f.input.listenerCount('data'), 0);
  assert.ok(!f.output.join('').includes('fixture-api-key'));
  assert.deepEqual(new Set(process.listeners('SIGTERM')), before);
});

async function cliFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-paymaster-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = validateConfig({ ...base(), gasPayment });
  await atomicWriteJson(join(directory, 'config.json'), config);
  const env: NodeJS.ProcessEnv = { ...process.env, REBALANCE_ROOT_DIR: directory, REBALANCE_DATA_DIR: directory,
    REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: wallet };
  delete env.REBALANCE_ALCHEMY_API_KEY;
  const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname, ...args],
    { env, timeout: 15_000, maxBuffer: 50_000 });
  return { directory, config, run };
}

test('actual CLI scopes status and disable to temporary portfolio while preserving pending and cadence', async t => {
  const f = await cliFixture(t);
  const pending = { transport: 'alchemy-usdg', marker: 'receipt-fixture' }, cycle = { marker: 'cadence-fixture' }, stop = { marker: 'stop-fixture' };
  for (const [name, value] of Object.entries({ 'pending.json': pending, 'cycle.json': cycle, 'stop.json': stop })) await atomicWriteJson(join(f.directory, name), value);
  const before = await readdir(f.directory);
  const result = JSON.parse((await f.run(['paymaster', 'status'])).stdout);
  assert.equal(result.wallet, wallet); assert.equal(result.credential, 'missing'); assert.equal(result.readiness, 'not-checked');
  const disabled = JSON.parse((await f.run(['paymaster', 'disable'])).stdout);
  assert.equal(disabled.pendingReceiptPreserved, true);
  assert.equal(disabled.state, 'disabled'); assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'config.json'), 'utf8')), base());
  for (const [name, value] of Object.entries({ 'pending.json': pending, 'cycle.json': cycle, 'stop.json': stop })) assert.deepEqual(JSON.parse(await readFile(join(f.directory, name), 'utf8')), value);
  assert.deepEqual(await readdir(f.directory), before);
});

test('generic configure preserves selected gas transport and CLI setup refuses noninteractive input', async t => {
  const f = await cliFixture(t);
  await f.run(['configure', '--threshold', '7']);
  const next = JSON.parse(await readFile(join(f.directory, 'config.json'), 'utf8'));
  assert.deepEqual(next.gasPayment, gasPayment); assert.deepEqual(next.targets, f.config.targets); assert.equal(next.driftThresholdBps, 700);
  await assert.rejects(f.run(['paymaster', 'setup']), error => /local terminal/.test((error as { stderr: string }).stderr));
  await assert.rejects(stat(join(f.directory, 'alchemy-api-key')), { code: 'ENOENT' });
  await assert.rejects(f.run(['paymaster', 'setup', 'secret-fixture']), error => !(error as { stderr: string }).stderr.includes('secret-fixture'));
});
