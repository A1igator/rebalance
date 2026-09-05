import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Prompt data never becomes a command. Accept the typed command or this project's picker reference. */
export function selectLaunchRequest(input, root = repository) {
  if (!input || input.hook_event_name !== 'UserPromptSubmit' ||
      typeof input.prompt !== 'string') return null;
  const prompt = input.prompt.trim();
  const skillReference = `[$rebalance](${resolve(root, 'skills/rebalance/SKILL.md')})`;
  if (prompt !== '$rebalance' && prompt !== skillReference) return null;
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

function hookFailure(phase) {
  const messages = {
    input: 'The Rebalance hook could not read its event input; no startup was attempted.',
    workspace: 'The Rebalance hook could not verify its project directory; no startup was attempted. Review the project hook setup.',
    'stop-state': 'The Rebalance hook could not read its saved stop state; no startup was attempted. Preserve local records for recovery.',
    dependencies: 'The Rebalance hook could not prepare its locked dependencies; no startup was attempted. Check the local runtime and dependencies; Node.js 24 or later is required.',
    launch: 'The Rebalance launcher may have started the runner, but its result could not be verified. Current trading state is unknown. Inspect public status; do not repeat launch or start.',
  };
  // These fixed messages are deliberately independent of caught errors, paths,
  // stdin and subprocess output. A dispatched launcher can outlive its result.
  return hookReply({ app: 'Rebalance', outcome: phase === 'launch' ? 'starting' : 'blocked',
    status: null, phase, messages: [messages[phase]] });
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
  const selected = selectLaunchRequest(input, overrides.repository ?? repository);
  if (!selected) return null;
  if (selected.blocked) return hookReply({ app: 'Rebalance', outcome: 'blocked', messages: [selected.blocked] });
  let phase = 'workspace';
  try {
    const root = await realpath(overrides.repository ?? repository);
    const cwd = await realpath(selected.cwd);
    const child = relative(root, cwd);
    if (child === '..' || child.startsWith('../') || child.startsWith('..\\') || isAbsolute(child)) return null;
    // Capture before a potentially slow npm ci; a stop issued during bootstrap
    // must still win when the launcher reaches its conditional start.
    phase = 'stop-state';
    const expectedStop = await (overrides.readStopToken ?? readStopToken)(root);
    phase = 'dependencies';
    await (overrides.ensureDependencies ?? ensureDependencies)(root);
    phase = 'launch';
    return hookReply(await (overrides.runLaunch ?? runLaunch)(root, selected.requestId, expectedStop));
  } catch {
    return hookFailure(phase);
  }
}

async function main() {
  let raw = '';
  let input;
  try {
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 1_048_576) throw new Error('Hook input too large');
    }
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify(hookFailure('input')) + '\n');
    return;
  }
  const response = await handlePrompt(input);
  if (response) process.stdout.write(JSON.stringify(response) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Codex consumes structured additionalContext from successful hook exits.
  // Handled failures therefore return public JSON at exit 0; application
  // failure/unknown state is carried by outcome and status, not the exit code.
  await main();
}
