import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePrompt, selectShareImportRequest } from './rebalance-hook.mjs';
import { openCompanionView } from './companion-view.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Internal import-only envelope supplied by the native plugin after user,
 * message identity and root-session verification. No slash marker is needed for
 * a read-only preview; this envelope can never become a launch request. */
export function selectOpenCodeShareImportRequest(input, root = repository) {
  if (!input || input.hook_event_name !== 'OpenCodeShareImport' || input.direct_user_message !== true) return null;
  const normalized = {
    hook_event_name: 'UserPromptSubmit', prompt: input.prompt, cwd: input.cwd,
    permission_mode: input.permission_mode,
    session_id: typeof input.session_id === 'string' ? `opencode:${input.session_id}` : undefined,
    turn_id: input.message_id,
  };
  const selected = selectShareImportRequest(normalized, root);
  if (!selected) return null;
  if (input.agent !== 'build' || input.parent_session_id !== null ||
      typeof input.session_id !== 'string' || !/^ses_[A-Za-z0-9]{1,128}$/.test(input.session_id) ||
      typeof input.message_id !== 'string' || !/^msg_[A-Za-z0-9]{1,128}$/.test(input.message_id)) {
    return { blocked: 'Strategy preview requires a verified root OpenCode Build session and native message identity; nothing was applied.' };
  }
  return { ...selected, normalized };
}

export async function handleOpenCodeSharePrompt(input, overrides = {}) {
  const root = overrides.repository ?? repository;
  const selected = selectOpenCodeShareImportRequest(input, root);
  if (!selected) return null;
  if (selected.blocked) return blockedReply(selected.blocked);
  const result = await handlePrompt(selected.normalized, { openView: openCompanionView, ...overrides, repository: root });
  return result === null ? null : { ...result, hookSpecificOutput: {
    ...result.hookSpecificOutput, hookEventName: 'chat.message',
  } };
}

function blockedReply(message) {
  return { hookSpecificOutput: {
    hookEventName: 'chat.message',
    additionalContext: 'The local strategy import preview was blocked. Do not apply targets or launch.\n'
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
    process.stdout.write(JSON.stringify(blockedReply('The strategy preview input could not be read; nothing was applied.')) + '\n');
    return;
  }
  const result = await handleOpenCodeSharePrompt(input);
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
