import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectionPath } from '../scripts/profile-routing.mjs';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const one = '0x0000000000000000000000000000000000000001';
const two = '0x0000000000000000000000000000000000000002';
const args = ['allocation', 'optimize', 'sharpe'];

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-sharpe-routing-'));
  assertTemporaryTestDirectory(root);
  const configuration = (wallet: string) => ({ version: 1, chainId: 4663, wallet, mode: 'ledger',
    rpcUrl: 'http://routing-fixture.invalid', targets: { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 },
    driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });
  await writeFile(join(root, 'config.json'), JSON.stringify(configuration(one)));
  const second = join(root, 'wallets', two);
  await mkdir(second, { recursive: true });
  await writeFile(join(second, 'config.json'), JSON.stringify(configuration(two)));
  const preload = join(root, 'offline.mjs');
  await writeFile(preload, `import {writeFileSync} from 'node:fs';
globalThis.fetch=async()=>{writeFileSync(process.env.REBALANCE_ROOT_DIR+'/unexpected-network','blocked');throw Error('No fixture network');};`);
  const env = { ...process.env };
  for (const key of ['REBALANCE_PRIVATE_KEY', 'REBALANCE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID',
    'REBALANCE_PROFILE_PINNED', 'REBALANCE_PROFILE_WALLET', 'REBALANCE_CHART_PORT']) delete env[key];
  Object.assign(env, { REBALANCE_ROOT_DIR: root, REBALANCE_DATA_DIR: root, NODE_OPTIONS: `--import=${preload}` });
  const rawCommand = async (input: string[], overrides: NodeJS.ProcessEnv = {}) => JSON.parse((await execute(process.execPath,
    ['--import', 'tsx', cli, ...input], { cwd: repository, env: { ...env, ...overrides }, timeout: 15_000 })).stdout);
  const command = (extra: string[] = [], overrides: NodeJS.ProcessEnv = {}) => rawCommand([...args, ...extra], overrides);
  const registry = async () => writeFile(join(root, 'portfolios.json'), JSON.stringify({ version: 1, profiles: [
    { wallet: one, chainId: 4663, directory: '.', chartPort: 4663 },
    { wallet: two, chainId: 4663, directory: `wallets/${two}`, chartPort: 4664 },
  ] }));
  const connect = async (value: unknown) => {
    const path = connectionPath(root, 'sharpe-chat'); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  };
  const before = await Promise.all([root, second].map(dir => readFile(join(dir, 'config.json'), 'utf8')));
  t.after(async () => {
    try {
      assert.deepEqual(await Promise.all([root, second].map(dir => readFile(join(dir, 'config.json'), 'utf8'))), before);
      for (const dir of [root, second]) for (const file of ['unexpected-network', 'run.lock', 'pending.json', 'start.log']) {
        assert.equal(existsSync(join(dir, file)), false, file);
      }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  });
  return { root, second, command, rawCommand, connect, registry };
}

test('Sharpe requires selection even when legacy routing has exactly one portfolio', async t => {
  const f = await fixture(t);
  for (const flags of [[], ['--session', 'sharpe-chat'], ['--preset', 'stock-usdg-1y']]) {
    const result = await f.command(flags);
    assert.equal(result.mode, 'needs-selection'); assert.equal(result.changesTargets, false);
  }
});

test('Sharpe captures the saved conversation wallet and explicit profile overrides it', async t => {
  const f = await fixture(t); await f.registry();
  await f.connect({ version: 1, chainId: 4663, wallet: two });
  const attached = await f.command(['--session', 'sharpe-chat']);
  assert.equal(attached.outcome, 'needs-input'); assert.equal(attached.wallet.toLowerCase(), two);
  const explicit = await f.command(['--session', 'sharpe-chat', '--profile', one]);
  assert.equal(explicit.outcome, 'needs-input'); assert.equal(explicit.wallet.toLowerCase(), one);
});

test('leading and interspersed optimization flags cannot acquire lone-wallet authority', async t => {
  const f = await fixture(t);
  for (const input of [
    ['--preset', 'stock-usdg-1y', ...args],
    ['allocation', '--preview', 'optimize', 'sharpe', '--preset', 'stock-usdg-1y'],
    ['--preview', 'allocation', 'optimize', '--preset=stock-usdg-1y', 'sharpe'],
  ]) assert.equal((await f.rawCommand(input)).mode, 'needs-selection');
  assert.equal((await f.rawCommand(['--preview', ...args, '--profile', one])).outcome, 'needs-input');
});

test('invalid, foreign-chain and nonexistent attachment never fall back to another wallet', async t => {
  const f = await fixture(t); await f.registry();
  for (const value of [{ version: 1, chainId: 1, wallet: one }, { version: 2, chainId: 4663, wallet: one },
    { version: 1, chainId: 4663, wallet: 'invalid' },
    { version: 1, chainId: 4663, wallet: '0x0000000000000000000000000000000000000003' }]) {
    await f.connect(value); await assert.rejects(f.command(['--session', 'sharpe-chat']));
  }
});

test('pinned Sharpe identity must be valid and match its directory and explicit profile', async t => {
  const f = await fixture(t);
  const pinned = { REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: one };
  assert.equal((await f.command([], pinned)).wallet.toLowerCase(), one);
  await assert.rejects(f.command(['--profile', two], pinned));
  await assert.rejects(f.command([], { ...pinned, REBALANCE_PROFILE_WALLET: '' }));
  await assert.rejects(f.command([], { ...pinned, REBALANCE_DATA_DIR: f.second }));
});
