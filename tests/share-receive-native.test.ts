import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { connectionPath } from '../scripts/profile-routing.mjs';
import { atomicWriteJson } from '../src/storage.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const code = 'rebalance:v1 AAPL=30,AMD=21.81,MSFT=21.8,NVDA=21.8,USDG=4.59 drift=5 interval=3600';
const session = 'share-native-isolated-fixture';
function invoke(root: string, turn: string, prompt = code): Promise<Record<string, any>> {
  return new Promise((done, fail) => {
    const child = execFile(process.execPath, [join(repository, 'scripts/rebalance-hook.mjs')], {
      cwd: repository, timeout: 20_000, maxBuffer: 32_768,
      env: { ...process.env, REBALANCE_ROOT_DIR: root, REBALANCE_DATA_DIR: root,
        REBALANCE_PROFILE_PINNED: '', REBALANCE_PROFILE_WALLET: '', REBALANCE_CHART_PORT: '',
        REBALANCE_SESSION_ID: session, CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '' },
    }, (error, stdout) => {
      if (error) { fail(error); return; }
      try {
        const reply = JSON.parse(stdout);
        const context = reply.hookSpecificOutput.additionalContext as string;
        done({ context, result: JSON.parse(context.slice(context.indexOf('\n') + 1)) });
      } catch (error) { fail(error); }
    });
    child.stdin?.on('error', fail);
    child.stdin?.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: repository,
      session_id: session, turn_id: turn, permission_mode: 'default', prompt }));
  });
}

test('real native hook applies once through the CLI to its isolated attachment and replay leaves later settings untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-share-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wallets = ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)];
  const profiles = wallets.map((wallet, i) => ({wallet, chainId: 4663, directory: `wallets/${wallet}`, chartPort: 58000 + i}));
  await atomicWriteJson(join(root, 'portfolios.json'), { version: 1, profiles });
  const config = (wallet: string) => ({version: 1, chainId: 4663, wallet, mode: 'ledger', rpcUrl: 'https://fixture.invalid',
    targets: {USDG:500,AAPL:2375,AMD:2375,MSFT:2375,NVDA:2375}, driftThresholdBps: 500,
    rebalanceIntervalSeconds: 3600, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceFeeTargetUsdE8: '5000000'});
  for (const profile of profiles) await atomicWriteJson(join(root, profile.directory, 'config.json'), config(profile.wallet));
  const first = join(root, profiles[0]!.directory), second = join(root, profiles[1]!.directory);
  const secondBefore = await readFile(join(second, 'config.json'), 'utf8');
  const markers = ['pending.json', 'cycle.json', 'stop.json', 'runner-preference.json', 'status.json'];
  for (const file of markers) await atomicWriteJson(join(first, file), { fixture: file });
  const beforeMarkers = await Promise.all(markers.map(file => readFile(join(first, file), 'utf8')));
  await atomicWriteJson(connectionPath(root, session), {version:1,chainId:4663,wallet:wallets[0]});
  const firstReply = await invoke(root, 'native-apply-turn');
  assert.equal(firstReply.result.outcome, 'applied'); assert.equal(firstReply.result.applied, true);
  assert.equal(firstReply.result.wallet, wallets[0]);
  assert.match(firstReply.context, /without asking to choose or apply again/);
  const applied = JSON.parse(await readFile(join(first, 'config.json'), 'utf8'));
  assert.deepEqual(applied.targets, {USDG:459,AAPL:3000,AMD:2181,MSFT:2180,NVDA:2180});
  assert.equal(applied.rebalanceFeeTargetUsdE8, '5000000');
  assert.deepEqual(await Promise.all(markers.map(file => readFile(join(first, file), 'utf8'))), beforeMarkers);
  assert.equal(await readFile(join(second, 'config.json'), 'utf8'), secondBefore);
  await atomicWriteJson(join(first, 'config.json'), {...applied, driftThresholdBps: 900});
  await atomicWriteJson(connectionPath(root, session), {version:1,chainId:4663,wallet:wallets[1]});
  const replay = await invoke(root, 'native-apply-turn');
  assert.equal(replay.result.replayed, true); assert.equal(replay.result.wallet, wallets[0]);
  assert.equal(JSON.parse(await readFile(join(first, 'config.json'), 'utf8')).driftThresholdBps, 900);
  assert.equal(await readFile(join(second, 'config.json'), 'utf8'), secondBefore);
});
