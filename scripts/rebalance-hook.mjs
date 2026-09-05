import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Prompt data never becomes a command. Only the exact bare user command routes. */
export function selectLaunchRequest(input) {
  if (!input || input.hook_event_name !== 'UserPromptSubmit' ||
      typeof input.prompt !== 'string' || input.prompt.trim() !== '$rebalance') return null;
  if (input.permission_mode === 'plan') return { blocked: 'Rebalance launch was not run in Plan mode.' };
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) ||
      typeof input.session_id !== 'string' || !input.session_id ||
      typeof input.turn_id !== 'string' || !input.turn_id) {
    return { blocked: 'Rebalance launch needs a project directory and stable session/turn identity; nothing was started.' };
  }
  return { cwd: input.cwd, requestId: createHash('sha256')
    .update(JSON.stringify([input.session_id, input.turn_id])).digest('hex') };
}

export function hookReply(result) {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'The deterministic Rebalance command handler already handled this invocation. '
        + 'Report the public result below; do not repeat launch or start. An outcome is not a trade receipt.\n'
        + JSON.stringify(result),
    },
  };
}

async function ensureDependencies(root) {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Rebalance requires Node.js 24 or later.');
  }
  try {
    await Promise.all(['tsx', 'viem'].map(name => access(resolve(root, 'node_modules', name, 'package.json'))));
  } catch {
    // Install the existing lockfile only. Do not echo installer output or alter
    // the dependency list, global settings, hook trust or approval policy.
    await executeFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], {
      cwd: root, timeout: 120_000, maxBuffer: 1_048_576,
    });
  }
}

async function readStopToken(root) {
  const directory = resolve(root, process.env.REBALANCE_DATA_DIR || '.local');
  try {
    const stop = JSON.parse(await readFile(resolve(directory, 'stop.json'), 'utf8'));
    return stop === null ? 'none' : createHash('sha256').update(JSON.stringify(stop)).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return 'none';
    throw error;
  }
}

async function runLaunch(root, requestId, expectedStop) {
  const args = ['--import', 'tsx', resolve(root, 'src/cli.ts'), 'launch',
    '--request-id', requestId, '--expected-stop', expectedStop];
  let stdout;
  try {
    ({ stdout } = await executeFile(process.execPath, args, { cwd: root, timeout: 240_000, maxBuffer: 1_048_576 }));
  } catch (error) {
    // Failed launch commands can still return a structured public blocked state.
    // Raw process errors/stderr may contain provider or environment details.
    stdout = typeof error.stdout === 'string' ? error.stdout : '';
  }
  const result = JSON.parse(stdout);
  if (result?.app !== 'Rebalance' || typeof result.outcome !== 'string') throw new Error('Invalid launch result');
  return result;
}

export async function handlePrompt(input, overrides = {}) {
  const selected = selectLaunchRequest(input);
  if (!selected) return null;
  if (selected.blocked) return hookReply({ app: 'Rebalance', outcome: 'blocked', messages: [selected.blocked] });
  const root = await realpath(overrides.repository ?? repository);
  const cwd = await realpath(selected.cwd);
  const child = relative(root, cwd);
  if (child === '..' || child.startsWith('../') || child.startsWith('..\\') || isAbsolute(child)) return null;
  // Capture before a potentially slow npm ci; a stop issued during bootstrap
  // must still win when the launcher reaches its conditional start.
  const expectedStop = await (overrides.readStopToken ?? readStopToken)(root);
  await (overrides.ensureDependencies ?? ensureDependencies)(root);
  return hookReply(await (overrides.runLaunch ?? runLaunch)(root, selected.requestId, expectedStop));
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1_048_576) throw new Error('Hook input too large');
  }
  const response = await handlePrompt(JSON.parse(raw));
  if (response) process.stdout.write(JSON.stringify(response) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(JSON.stringify(hookReply({ app: 'Rebalance', outcome: 'blocked',
      messages: ['The Rebalance hook could not verify completion. Inspect public status; do not blindly repeat a launch.'] })) + '\n');
    process.exitCode = 1;
  });
}
