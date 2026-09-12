import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePrompt, selectLaunchRequest } from './rebalance-hook.mjs';
import { openCompanionView } from './companion-view.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sessionID = /^ses_[A-Za-z0-9]{1,128}$/;
const messageID = /^msg_[A-Za-z0-9]{1,128}$/;

/** Internal plugin envelope, not a native OpenCode hook payload.
 * The plugin links command.execute.before to chat.message with a one-use opaque
 * marker, verifies the root session, and supplies output.message.id. Neither
 * hook input.messageID nor prompt text is launch authority on its own.
 * Native hooks: https://github.com/anomalyco/opencode/blob/v1.18.30/packages/plugin/src/index.ts
 * Dispatch: https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/prompt.ts
 * IDs: https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/id/id.ts
 */
export function selectOpenCodeLaunchRequest(input, root = repository) {
  if (!input || input.hook_event_name !== 'OpenCodeCommand' ||
      input.command !== 'rebalance' || typeof input.arguments !== 'string' ||
      input.arguments.trim() !== '' || input.direct_user_command !== true) return null;
  if (input.agent !== 'build' || input.permission_mode === 'plan') {
    return { blocked: 'Rebalance launch requires the root OpenCode Build agent; Plan mode and other agents do not launch.' };
  }
  if (input.parent_session_id !== null) {
    return { blocked: 'Rebalance launch requires a verified root OpenCode session; nothing was started.' };
  }
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) ||
      typeof input.session_id !== 'string' || !sessionID.test(input.session_id) ||
      typeof input.message_id !== 'string' || !messageID.test(input.message_id)) {
    return { blocked: 'Rebalance launch needs an absolute project directory and native OpenCode session/message identity; nothing was started.' };
  }
  const normalized = {
    hook_event_name: 'UserPromptSubmit', prompt: '$rebalance', permission_mode: 'default',
    cwd: input.cwd, session_id: `opencode:${input.session_id}`, turn_id: input.message_id,
  };
  return { ...selectLaunchRequest(normalized, root), normalized };
}

function reply(result) {
  return { hookSpecificOutput: {
    hookEventName: 'chat.message',
    additionalContext: 'The deterministic Rebalance command handler already handled this invocation. '
      + 'Report the public result below; do not repeat launch or start, or repeat recovery. An outcome is not a trade receipt.\n'
      + JSON.stringify(result),
  } };
}

export async function handleOpenCodePrompt(input, overrides = {}) {
  const selected = selectOpenCodeLaunchRequest(input, overrides.repository ?? repository);
  if (!selected) return null;
  if (selected.blocked) return reply({ app: 'Rebalance', outcome: 'blocked', messages: [selected.blocked] });
  // Shared handling retains workspace checking, pinned wallet routing, stop
  // capture before bootstrap, launcher request dedup and unknown-start output.
  const result = await handlePrompt(selected.normalized, {
    openView: openCompanionView, ...overrides, repository: overrides.repository ?? repository,
  });
  return result === null ? null : { ...result, hookSpecificOutput: {
    ...result.hookSpecificOutput, hookEventName: 'chat.message',
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
      status: null, messages: ['The Rebalance OpenCode adapter could not read its event input; no startup was attempted.'] })) + '\n');
    return;
  }
  const result = await handleOpenCodePrompt(input);
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
