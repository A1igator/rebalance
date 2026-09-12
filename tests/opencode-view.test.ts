import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { getAddress, type Address } from 'viem';
import { connectionPath, readProfiles } from '../scripts/profile-routing.mjs';
import { atomicWriteJson, readJson } from '../src/storage.js';
import { connectView, issueView, readView, requestWalletSetup, viewState, type ViewDelivery } from '../src/view-session.js';
import { WalletSetups, type WalletSetupDependencies } from '../src/wallet-setup.js';

const sessionId = 'opencode:ses_fixtureRootA';
const otherSession = 'opencode:ses_fixtureRootB';
const codexSession = '00000000-0000-4000-8000-000000000001';
const wallet = `0x${'a'.repeat(40)}` as Address;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-opencode-view-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('OpenCode view capabilities infer their delivery kind and enable setup only for a validated namespace', async t => {
  const root = await fixture(t);
  for (const descriptor of [undefined, { kind: 'opencode' } as const]) {
    const { token } = await issueView(root, sessionId, descriptor);
    const record = await readView(root, token);
    assert.equal(record.sessionId, sessionId);
    assert.deepEqual(record.delivery, { kind: 'opencode' });
    assert.deepEqual(await viewState(root, token), { connectedWallet: null, canSetup: true });
  }
  for (const malformed of ['opencode:ses_', 'opencode:ses_a/b', 'opencode:ses_a:b', `opencode:ses_${'a'.repeat(129)}`]) {
    const { token } = await issueView(root, malformed);
    assert.equal((await readView(root, token)).delivery, null);
    assert.deepEqual(await viewState(root, token), { connectedWallet: null, canSetup: false });
    await assert.rejects(issueView(root, malformed, { kind: 'opencode' }), /unavailable or invalid/);
  }
  await assert.rejects(issueView(root, 'opencode:ses_bad\nchat'), /unavailable or invalid/);
});

test('OpenCode view descriptors reject a different host identity and invalid delivery fields', async t => {
  const root = await fixture(t);
  for (const otherId of [codexSession, 'claude:fixture', 'ses_missingNamespace', 'local-fixture']) {
    await assert.rejects(issueView(root, otherId, { kind: 'opencode' }), /unavailable or invalid/);
  }
  for (const descriptor of [
    { kind: 'codex' }, { kind: 'claude' }, { kind: 'opencode', command: 'codex' }, { kind: 'opencode', parentID: 'ses_parent' },
  ]) {
    await assert.rejects(issueView(root, sessionId, descriptor as ViewDelivery), /unavailable or invalid/);
  }
});

test('stored OpenCode view identity tampering cannot enable setup through another host', async t => {
  const root = await fixture(t), { token } = await issueView(root, sessionId);
  const record = await readView(root, token), path = join(root, 'views', `${hash(token)}.json`);
  for (const replacement of [
    { ...record, delivery: { kind: 'codex' } },
    { ...record, delivery: { kind: 'claude' } },
    { ...record, sessionId: codexSession },
    { ...record, sessionId: 'opencode:ses_' },
  ]) {
    await atomicWriteJson(path, replacement);
    await assert.rejects(readView(root, token), /unavailable or invalid/);
    await assert.rejects(viewState(root, token), /unavailable or invalid/);
  }
});

test('legacy wallet-setup queue rejects OpenCode before persisting or invoking the Codex transport', async t => {
  const root = await fixture(t), { token } = await issueView(root, sessionId);
  let executions = 0, writes = 0;
  for (const mode of ['private-key', 'privy', 'ledger'] as const) {
    await assert.rejects(requestWalletSetup(root, token, mode, randomUUID(), {
      execute: async () => { executions++; throw new Error('Unexpected fixture transport'); },
      persist: async () => { writes++; throw new Error('Unexpected fixture queue write'); },
    }), /OpenCode; setup runs locally without a model queue/);
  }
  assert.equal(executions, 0); assert.equal(writes, 0);
  await assert.rejects(readdir(join(root, 'ui-requests')), { code: 'ENOENT' });
});

test('deterministic setup accepts an OpenCode view with a stub provider and connects only that conversation', async t => {
  const root = await fixture(t), a = await issueView(root, sessionId), b = await issueView(root, otherSession);
  const requestId = randomUUID();
  let providerCalls = 0;
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected fixture signer'); };
  const providers: WalletSetupDependencies['providers'] = {
    'private-key': async context => {
      providerCalls++;
      assert.equal(context.rootDir, root);
      assert.equal(context.requestKey, hash(`${hash(a.token)}\0${requestId}`));
      return { address: wallet };
    },
    privy: unexpected, ledger: unexpected,
  };
  const external: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => { external.push('fetch'); throw new Error('Unexpected fixture network'); });
  for (const name of ['execFile', 'execFileSync', 'spawn'] as const) t.mock.method(childProcess, name, () => {
    external.push(name); throw new Error('Unexpected fixture subprocess');
  });
  syncBuiltinESMExports();
  const service = new WalletSetups(root, { providers });
  try {
    const initial = await service.begin(a.token, 'private-key', requestId);
    assert.equal(initial.tradingChanged, false);
    let ready = await service.read(a.token, requestId);
    for (let i = 0; i < 1000 && ready.state !== 'ready'; i++) {
      await delay(5); ready = await service.read(a.token, requestId);
    }
    assert.equal(ready.state, 'ready'); assert.equal(ready.wallet, getAddress(wallet));
    assert.equal(ready.tradingChanged, false);
    assert.deepEqual(await service.begin(a.token, 'private-key', requestId), ready);
    assert.equal(providerCalls, 1);
    await assert.rejects(service.read(b.token, requestId), /unavailable or invalid/);
    assert.deepEqual(await viewState(root, a.token), { connectedWallet: null, canSetup: true });
    const selected = await connectView(root, a.token, ready.wallet!);
    assert.equal(selected.sessionId, sessionId); assert.equal(selected.tradingChanged, false);
    assert.deepEqual(await viewState(root, a.token), { connectedWallet: wallet, canSetup: true });
    assert.deepEqual(await viewState(root, b.token), { connectedWallet: null, canSetup: true });
    assert.equal(await readJson(connectionPath(root, otherSession)), null);
    const profiles = await readProfiles(root);
    assert.equal(profiles.length, 1);
    assert.deepEqual(await readdir(profiles[0].dataDir), ['config.json']);
    for (const name of ['private-key', 'run.lock', 'pending.json', 'cycle.json', 'recovery.json', 'stop.json', 'events.json']) {
      assert.equal(await readJson(join(root, name)), null);
    }
    await assert.rejects(readdir(join(root, 'ui-requests')), { code: 'ENOENT' });
    assert.deepEqual(external, []);
  } finally {
    await service.close(); t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
