import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePrompt, selectShareImportRequest } from './rebalance-hook.mjs';
import { openCompanionView } from './companion-view.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Pasted-code configuration import. Native UserPromptSubmit/prompt_id contract:
 * https://code.claude.com/docs/en/hooks#userpromptsubmit
 * Never adapt slash commands, model Skill calls or subagent input to launch. */
export function selectClaudeShareImportRequest(input, root = repository) {
  if (!input || input.hook_event_name !== 'UserPromptSubmit' || input.agent_id !== undefined) return null;
  const normalized = {
    hook_event_name: 'UserPromptSubmit', prompt: input.prompt,
    cwd: input.cwd, permission_mode: input.permission_mode,
    session_id: typeof input.session_id === 'string' ? `claude:${input.session_id}` : undefined,
    turn_id: typeof input.prompt_id === 'string' ? input.prompt_id.toLowerCase() : undefined,
  };
  const selected = selectShareImportRequest(normalized, root);
  if (!selected) return null;
  if (typeof input.prompt_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.prompt_id) ||
      typeof input.session_id !== 'string' || !input.session_id) {
    return { blocked: 'Strategy import requires native Claude session and prompt identity; nothing was applied.' };
  }
  return { ...selected, normalized };
}

export async function handleClaudeSharePrompt(input, overrides = {}) {
  const root = overrides.repository ?? repository;
  const selected = selectClaudeShareImportRequest(input, root);
  if (!selected) return null;
  if (selected.blocked) return blockedReply(selected.blocked);
  return handlePrompt(selected.normalized, { openView: openCompanionView, ...overrides, repository: root });
}

function blockedReply(message) {
  return { hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: 'The local strategy import was blocked. Do not apply targets or launch.\n'
      + JSON.stringify({ app: 'Rebalance', operation: 'share-import', outcome: 'blocked', applied: false, messages: [message] }),
  } };
}

async function main() {
  let raw = '', input;
  try {
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 1_048_576) throw new Error('Hook input too large');
    }
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify(blockedReply('The strategy import input could not be read; nothing was applied.')) + '\n');
    return;
  }
  const result = await handleClaudeSharePrompt(input);
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
