import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type CodexWithdrawal = 'deleted' | 'absent';
export type CodexQueueDependencies = {
  spawn: (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;
  after: (ms: number, callback: () => void) => () => void;
};
const defaults: CodexQueueDependencies = {
  spawn: (command, args) => spawn(command, [...args], { stdio: 'pipe', shell: false, windowsHide: true }),
  after: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
};
const failure = () => new Error('Codex notification withdrawal could not be verified. Retain its delivery barrier; do not resend.');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Best-effort deletion of one owned queue ID; never starts or resumes a thread.
 * A successful cross-process delete cannot exclude a concurrent Desktop dispatch.
 * The caller must persist its withdrawal/no-resend barrier before invoking this.
 */
export function withdrawCodexNotification(
  command: string, threadId: string, queueId: string,
  overrides: Partial<CodexQueueDependencies> = {},
): Promise<CodexWithdrawal> {
  if (typeof command !== 'string' || (command !== 'codex' && !isAbsolute(command)) || command.length > 1000 || /[\0\r\n]/.test(command) ||
      typeof threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId) ||
      typeof queueId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(queueId)) return Promise.reject(failure());
  const deps = { ...defaults, ...overrides };
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = deps.spawn(command, ['app-server', '--listen', 'stdio://']); }
    catch { reject(failure()); return; }
    let settled = false;
    let cancelDeadline = () => {};
    let phase: 'initialize' | 'delete' | 'done' = 'initialize';
    let outcome: CodexWithdrawal | undefined;
    let pending = '';
    let stdoutBytes = 0, stderrBytes = 0;
    const decoder = new StringDecoder('utf8');
    const fail = () => {
      if (settled) return;
      settled = true; cancelDeadline();
      // No second grace timer: even an unresponsive child is killed at ten seconds.
      child.stdin.destroy();
      try { child.kill('SIGKILL'); } catch { /* Never expose native process details. */ }
      reject(failure());
    };
    const send = (value: unknown) => {
      if (settled) return;
      try { child.stdin.write(JSON.stringify(value) + '\n', error => { if (error) fail(); }); }
      catch { fail(); }
    };
    const receive = (line: string) => {
      if (settled || !line.trim()) return;
      let value: unknown;
      try { value = JSON.parse(line); } catch { fail(); return; }
      if (!record(value) || (value.jsonrpc !== undefined && value.jsonrpc !== '2.0')) { fail(); return; }
      // Native startup notifications are allowed; requests and unrelated responses
      // are not part of this narrowly scoped connection.
      if (!('id' in value) && typeof value.method === 'string' && !('result' in value) && !('error' in value)) return;
      if (phase === 'done') { fail(); return; }
      const expected = phase === 'initialize' ? 1 : 2;
      if (value.id !== expected || 'method' in value || 'error' in value || !record(value.result)) { fail(); return; }
      const result = value.result;
      if (phase === 'initialize') {
        if (!['userAgent', 'codexHome', 'platformFamily', 'platformOs'].every(key => typeof result[key] === 'string')) { fail(); return; }
        phase = 'delete';
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'thread/queue/delete', params: { threadId, queuedSubmissionId: queueId } });
      } else {
        if (typeof result.deleted !== 'boolean' || Object.keys(result).length !== 1) { fail(); return; }
        outcome = result.deleted ? 'deleted' : 'absent';
        phase = 'done';
        try { child.stdin.end(); } catch { fail(); }
      }
    };
    child.once('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > 65_536) { fail(); return; }
      pending += decoder.write(chunk);
      for (let end = pending.indexOf('\n'); end >= 0 && !settled; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1); receive(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > 16_384) fail();
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      pending += decoder.end();
      if (code !== 0 || signal !== null || phase !== 'done' || !outcome || pending.trim()) { fail(); return; }
      settled = true; cancelDeadline(); resolve(outcome);
    });
    cancelDeadline = deps.after(10_000, fail);
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'rebalance-notifications', version: '0.1.0' }, capabilities: { experimentalApi: true },
    } });
  });
}
