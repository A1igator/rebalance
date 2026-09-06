import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePrompt, selectLaunchRequest } from './rebalance-hook.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UserPromptExpansion is the direct user slash-skill path, not a model Skill call.
 * Native prompt_id (Claude Code >=2.1.196) is the stable request identity.
 * Source: https://code.claude.com/docs/en/hooks#userpromptexpansion
 * Source: https://code.claude.com/docs/en/hooks#common-input-fields
 */
export function selectClaudeLaunchRequest(input, root = repository) {
  if (!input || input.hook_event_name !== 'UserPromptExpansion' ||
      input.expansion_type !== 'slash_command' || input.command_name !== 'rebalance' ||
      typeof input.command_args !== 'string' || input.command_args.trim() !== '' ||
      typeof input.prompt !== 'string' || input.prompt.trim() !== '/rebalance' ||
      input.agent_id !== undefined) return null;
  if (input.permission_mode === 'plan') return { blocked: 'Rebalance launch was not run in Plan mode.' };
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) ||
      typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 2048 ||
      typeof input.prompt_id !== 'string' || !UUID.test(input.prompt_id)) {
    return { blocked: 'Rebalance launch needs an absolute project directory and native session_id/prompt_id. Claude Code 2.1.196 or later is required; nothing was started.' };
  }
  // Adapt documented Claude fields to the shared handler's internal identity slot.
  // No native turn_id is assumed, and no transcript or environment content is read.
  const normalized = {
    hook_event_name: 'UserPromptSubmit', prompt: '$rebalance',
    permission_mode: input.permission_mode, cwd: input.cwd,
    session_id: `claude:${input.session_id}`, turn_id: input.prompt_id.toLowerCase(),
  };
  return { ...selectLaunchRequest(normalized, root), normalized };
}

function reply(result) {
  return { hookSpecificOutput: {
    hookEventName: 'UserPromptExpansion',
    additionalContext: 'The deterministic Rebalance command handler already handled this invocation. '
      + 'Report the public result below; do not repeat launch or start, or repeat recovery. An outcome is not a trade receipt.\n'
      + JSON.stringify(result),
  } };
}

export async function handleClaudePrompt(input, overrides = {}) {
  const selected = selectClaudeLaunchRequest(input, overrides.repository ?? repository);
  if (!selected) return null;
  if (selected.blocked) return reply({ app: 'Rebalance', outcome: 'blocked', messages: [selected.blocked] });
  // Shared implementation retains canonical workspace checking, pre-bootstrap stop
  // capture, locked dependency installation, launcher dedup and unknown-start output.
  const result = await handlePrompt(selected.normalized, { ...overrides, repository: overrides.repository ?? repository });
  return result === null ? null : { ...result, hookSpecificOutput: {
    ...result.hookSpecificOutput, hookEventName: 'UserPromptExpansion',
  } };
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
    process.stdout.write(JSON.stringify(reply({ app: 'Rebalance', outcome: 'blocked', phase: 'input',
      status: null, messages: ['The Rebalance Claude hook could not read its event input; no startup was attempted.'] })) + '\n');
    return;
  }
  const result = await handleClaudePrompt(input);
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
