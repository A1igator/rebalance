import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { captureAppEntryInputs, readAppEntryInputs, runnerInputMatches, type RunnerInput } from '../scripts/app-entry-inputs.mjs';
import { atomicWriteJson } from '../src/storage.js';

const walletA = `0x${'a'.repeat(40)}`, walletB = `0x${'b'.repeat(40)}`;
const session = 'frozen-input-fixture';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const preference = (wallet: string, enabled = true) => ({ version: 1, wallet, chainId: 4663, enabled, generation: randomUUID() });
async function fixture(t: TestContext, count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-entry-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = [
    { wallet: walletA, chainId: 4663, directory: '.', chartPort: 4663 },
    { wallet: walletB, chainId: 4663, directory: `wallets/${walletB}`, chartPort: 4664 },
  ].slice(0, count);
  await atomicWriteJson(join(root, 'portfolios.json'), { version: 1, profiles });
  const requestId = randomUUID(), path = join(root, 'app-entry-inputs', `${hash(requestId)}.json`);
  return { root, profiles, requestId, path };
}

test('capture freezes only public hashes and replay cannot add a newly registered or enabled wallet', async t => {
  const f = await fixture(t);
  await atomicWriteJson(join(f.root, 'runner-preference.json'), preference(walletA));
  const expected = await captureAppEntryInputs(f.root, f.requestId, session);
  const original = await readFile(f.path, 'utf8');
  assert.equal(expected.entries.length, 1); assert.match(expected.entries[0]!.input!.preference, /^[a-f0-9]{64}$/);
  assert.equal(expected.entries[0]!.input!.stop, 'missing'); assert.equal(expected.entries[0]!.input!.legacy, undefined);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, 'app-entry-inputs'))).mode & 0o777, 0o700);
  assert.ok(!original.includes('enabled')); assert.ok(!original.includes('generation'));
  await atomicWriteJson(join(f.root, 'runner-preference.json'), preference(walletA));
  await atomicWriteJson(join(f.root, 'portfolios.json'), { version: 1, profiles: [...f.profiles,
    { wallet: walletB, chainId: 4663, directory: `wallets/${walletB}`, chartPort: 4664 }] });
  assert.deepEqual(await captureAppEntryInputs(f.root, f.requestId, session), expected);
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.equal(await runnerInputMatches(f.root, expected.entries[0]!.input!), false);
});

test('missing preference captures legacy inputs but ordinary status observations do not change running identity', async t => {
  const f = await fixture(t);
  const config = { fixture: 'public configured identity' }, lock = { pid: 123, token: 'first-lock' };
  const status = { app: 'Rebalance', wallet: walletA, chain: { id: 4663, name: 'Robinhood' }, mode: 'ledger', armed: true,
    updatedAt: '2026-09-12T00:00:00Z', portfolio: { observed: 'before' } };
  await atomicWriteJson(join(f.root, 'config.json'), config);
  await atomicWriteJson(join(f.root, 'run.lock'), lock);
  await atomicWriteJson(join(f.root, 'status.json'), status);
  const input = (await captureAppEntryInputs(f.root, f.requestId, session)).entries[0]!.input!;
  assert.equal(input.preference, 'missing'); assert.ok(input.legacy);
  assert.equal(await runnerInputMatches(f.root, input), true);
  await atomicWriteJson(join(f.root, 'status.json'), { ...status, updatedAt: '2026-09-12T00:01:00Z', portfolio: { observed: 'after' } });
  assert.equal(await runnerInputMatches(f.root, input), true);
  assert.equal(await runnerInputMatches(f.root, { legacy: input.legacy, stop: input.stop, preference: input.preference }), true);
  for (const changed of [{ ...status, armed: false }, { ...status, wallet: walletB }, { ...status, chain: { id: 1 } }]) {
    await atomicWriteJson(join(f.root, 'status.json'), changed);
    assert.equal(await runnerInputMatches(f.root, input), false);
  }
  await atomicWriteJson(join(f.root, 'status.json'), status);
  await atomicWriteJson(join(f.root, 'run.lock'), { ...lock, token: 'new-lock' });
  assert.equal(await runnerInputMatches(f.root, input), false);
});

test('Stop then Start remains a changed input even when the newer start removes Stop', async t => {
  const f = await fixture(t);
  await atomicWriteJson(join(f.root, 'runner-preference.json'), preference(walletA));
  const input = (await captureAppEntryInputs(f.root, f.requestId, session)).entries[0]!.input!;
  await atomicWriteJson(join(f.root, 'stop.json'), { requestId: 'newer-stop' });
  await atomicWriteJson(join(f.root, 'runner-preference.json'), preference(walletA, false));
  assert.equal(await runnerInputMatches(f.root, input), false);
  await atomicWriteJson(join(f.root, 'runner-preference.json'), preference(walletA));
  await rm(join(f.root, 'stop.json'));
  assert.equal(await runnerInputMatches(f.root, input), false);
});

test('one unreadable public input cannot redirect reads or block a healthy portfolio', async t => {
  const f = await fixture(t, 2), other = join(f.root, 'wallets', walletB);
  await atomicWriteJson(join(other, 'runner-preference.json'), preference(walletB));
  const target = join(f.root, 'fixture-not-public'); await writeFile(target, 'fixture-do-not-read');
  await symlink(target, join(f.root, 'config.json'));
  const snapshot = await captureAppEntryInputs(f.root, f.requestId, session);
  assert.equal(snapshot.entries[0]!.input, null);
  assert.equal(snapshot.entries[0]!.problem, 'Running state inputs could not be verified.');
  assert.match(snapshot.entries[1]!.input!.preference, /^[a-f0-9]{64}$/);
  assert.ok(!(await readFile(f.path, 'utf8')).includes('fixture-do-not-read'));
  const healthy = snapshot.entries[1]!.input!;
  await rm(join(other, 'runner-preference.json')); await symlink(target, join(other, 'runner-preference.json'));
  assert.equal(await runnerInputMatches(other, healthy), false);
});

test('corrupt status produces a per-wallet problem and does not leak arbitrary file contents', async t => {
  const f = await fixture(t, 2), other = join(f.root, 'wallets', walletB);
  await writeFile(join(f.root, 'status.json'), 'fixture-unparseable-status');
  await atomicWriteJson(join(other, 'runner-preference.json'), preference(walletB));
  const snapshot = await captureAppEntryInputs(f.root, f.requestId, session);
  assert.equal(snapshot.entries[0]!.input, null); assert.ok(snapshot.entries[1]!.input);
  assert.ok(!(await readFile(f.path, 'utf8')).includes('fixture-unparseable-status'));
});

test('snapshots reject mismatched identity, extra fields, escaping profiles and malformed or partial hashes without replacement', async t => {
  const f = await fixture(t);
  await atomicWriteJson(join(f.root, 'runner-preference.json'), preference(walletA));
  const good = await captureAppEntryInputs(f.root, f.requestId, session);
  await assert.rejects(readAppEntryInputs(f.root, f.requestId, 'another-session'));
  await assert.rejects(captureAppEntryInputs('relative-root', f.requestId, session));
  await assert.rejects(captureAppEntryInputs(f.root, 'bad\nrequest', session));
  const entry = good.entries[0]!;
  for (const value of [null, { ...good, extra: true }, { ...good, requestId: 'different' },
    { ...good, entries: [entry, entry] },
    { ...good, entries: [{ ...entry, profile: { ...entry.profile, dataDir: '/outside' } }] },
    { ...good, entries: [{ ...entry, input: { preference: 'unknown', stop: 'missing' } }] },
    { ...good, entries: [{ ...entry, input: { preference: 'missing', stop: 'missing' } }] },
    { ...good, entries: [{ ...entry, input: null, problem: 'untrusted arbitrary message' }] }]) {
    const raw = JSON.stringify(value); await writeFile(f.path, raw);
    await assert.rejects(readAppEntryInputs(f.root, f.requestId, session), /App entry inputs could not be verified/);
    await assert.rejects(captureAppEntryInputs(f.root, f.requestId, session));
    assert.equal(await readFile(f.path, 'utf8'), raw);
  }
  await writeFile(f.path, '{"version":1');
  await assert.rejects(captureAppEntryInputs(f.root, f.requestId, session));
  assert.equal(await readFile(f.path, 'utf8'), '{"version":1');
  await assert.rejects(runnerInputMatches(f.root, { preference: 'missing', stop: 'missing' } as RunnerInput));
});

test('missing receipts stay absent; symlinked or broad-permission receipts fail closed', async t => {
  const f = await fixture(t);
  assert.equal(await readAppEntryInputs(f.root, f.requestId, session), null);
  await captureAppEntryInputs(f.root, f.requestId, session);
  await chmod(f.path, 0o644); await assert.rejects(readAppEntryInputs(f.root, f.requestId, session));
  await chmod(f.path, 0o600);
  const moved = join(f.root, 'copied-inputs.json'); await writeFile(moved, await readFile(f.path));
  await rm(f.path); await symlink(moved, f.path);
  await assert.rejects(readAppEntryInputs(f.root, f.requestId, session));
  await assert.rejects(captureAppEntryInputs(f.root, f.requestId, session));
});

test('concurrent capture keeps one complete immutable winner and never rewrites the request', async t => {
  const f = await fixture(t);
  const replies = await Promise.allSettled(Array.from({ length: 6 }, () => captureAppEntryInputs(f.root, f.requestId, session)));
  const successful = replies.filter(result => result.status === 'fulfilled'); assert.ok(successful.length > 0);
  const saved = await readAppEntryInputs(f.root, f.requestId, session);
  for (const result of successful) assert.deepEqual(result.value, saved);
  for (const result of replies) if (result.status === 'rejected') assert.match(result.reason.message, /App entry inputs could not be verified/);
  assert.deepEqual(await readdir(join(f.root, 'app-entry-inputs')), [`${hash(f.requestId)}.json`]);
  const before = await readFile(f.path, 'utf8');
  await atomicWriteJson(join(f.root, 'runner-preference.json'), preference(walletA));
  assert.deepEqual(await captureAppEntryInputs(f.root, f.requestId, session), saved);
  assert.equal(await readFile(f.path, 'utf8'), before);
});
