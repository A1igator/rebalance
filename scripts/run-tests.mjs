import { spawn } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// POSIX /tmp is independent of an inherited TMPDIR pointing at app storage.
const temporaryRoot = await realpath(process.platform === 'win32' ? tmpdir() : '/tmp');
const directory = await mkdtemp(join(temporaryRoot, 'rebalance-tests-'));
const environment = { ...process.env, REBALANCE_ROOT_DIR: directory, REBALANCE_DATA_DIR: directory, TMPDIR: directory, TMP: directory, TEMP: directory };
// Host portfolio selection and credentials never become test defaults.
for (const name of ['REBALANCE_PRIVATE_KEY', 'REBALANCE_ALCHEMY_API_KEY', 'LEDGER_ORIGIN_TOKEN', 'REBALANCE_PROFILE_WALLET', 'REBALANCE_PROFILE_PINNED',
  'REBALANCE_CHART_PORT', 'REBALANCE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete environment[name];
let child;
let interrupted;
const interrupt = signal => { interrupted = signal; child?.kill(signal); };
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
try {
  const requested = process.argv.slice(2);
  const files = requested.length ? requested : (await readdir(join(repository, 'tests')))
    .filter(name => name.endsWith('.test.ts')).sort().map(name => join('tests', name));
  const result = await new Promise((done, fail) => {
    child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
      cwd: repository, env: environment, stdio: 'inherit',
    });
    child.once('error', fail);
    child.once('exit', (code, signal) => done({ code, signal }));
    if (interrupted) child.kill(interrupted);
  });
  process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 143);
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
