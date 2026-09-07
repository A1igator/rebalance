import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { withdrawCodexNotification } from '../src/codex-queue.js';

const threadId = '00000000-0000-4000-8000-000000000001';
const queueId = 'owned-queue-1';
const init = { id: 1, result: { userAgent: 'fixture', codexHome: '/fixture/codex', platformFamily: 'unix', platformOs: 'macos' } };
const errorText = 'Codex notification withdrawal could not be verified. Retain its delivery barrier; do not resend.';
class ProcessFixture extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  messages: unknown[] = []; kills: string[] = [];
  constructor() {
    super(); this.stdin.on('data', data => { this.messages.push(JSON.parse(data.toString())); });
  }
  kill(signal: string) { this.kills.push(signal); this.emit('close', null, signal); return true; }
  respond(value: unknown) { this.stdout.write(JSON.stringify(value) + '\n'); }
  close(code: number | null = 0, signal: string | null = null) { this.emit('close', code, signal); }
}
function fixture() {
  const child = new ProcessFixture();
  const timers: { ms: number; callback: () => void; cancelled: boolean }[] = [];
  const calls: { command: string; args: readonly string[] }[] = [];
  const promise = withdrawCodexNotification('codex', threadId, queueId, {
    spawn: (command, args) => { calls.push({ command, args }); return child as unknown as ChildProcessWithoutNullStreams; },
    after: (ms, callback) => { const timer = { ms, callback, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
  });
  void promise.catch(() => {});
  return { child, calls, timers, promise };
}
async function rejected(promise: Promise<unknown>) {
  await assert.rejects(promise, error => error instanceof Error && error.message === errorText);
}

test('withdrawal performs only the ordered experimental handshake and exact owned-ID delete', async () => {
  const f = fixture();
  assert.deepEqual(f.calls, [{ command: 'codex', args: ['app-server', '--listen', 'stdio://'] }]);
  assert.deepEqual(f.child.messages, [{ id: 1, method: 'initialize', params: {
    clientInfo: { name: 'rebalance-notifications', version: '0.1.0' }, capabilities: { experimentalApi: true },
  } }]);
  f.child.respond({ method: 'fixture/startup', params: {} });
  const bytes = Buffer.from(JSON.stringify({ ...init, result: { ...init.result, userAgent: 'fixture-é' } }) + '\n');
  for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
  assert.deepEqual(f.child.messages.slice(1), [
    { method: 'initialized', params: {} },
    { id: 2, method: 'thread/queue/delete', params: { threadId, queuedSubmissionId: queueId } },
  ]);
  f.child.respond({ id: 2, result: { deleted: true } });
  assert.equal(f.child.stdin.writableEnded, true);
  f.child.close();
  assert.equal(await f.promise, 'deleted');
  assert.deepEqual(f.child.kills, []); assert.equal(f.timers[0]?.cancelled, true);
});

test('an absent owned queue ID returns absent without retrying or adding a prompt', async () => {
  const f = fixture(); f.child.respond(init); f.child.respond({ id: 2, result: { deleted: false } }); f.child.close();
  assert.equal(await f.promise, 'absent'); assert.equal(f.child.messages.length, 3); assert.equal(f.calls.length, 1);
});

test('malformed, mismatched and error responses reject with fixed sanitized output', async t => {
  for (const [name, value] of Object.entries({
    'wrong ID': { id: 3, result: { deleted: true } }, 'string ID': { id: '2', result: { deleted: true } },
    'native error': { id: 2, error: { code: 1, message: 'fixture-private-native-detail' } },
    'missing result': { id: 2 }, 'null result': { id: 2, result: null },
    'string boolean': { id: 2, result: { deleted: 'true' } }, 'missing boolean': { id: 2, result: {} },
    'extra result': { id: 2, result: { deleted: true, unverified: true } },
    'mixed result and error': { id: 2, result: { deleted: true }, error: {} },
    'unexpected request': { id: 9, method: 'thread/start', params: {} },
    'invalid envelope': ['fixture-private-native-detail'], 'wrong JSON-RPC': { jsonrpc: '1.0', id: 2, result: { deleted: true } },
  })) await t.test(name, async () => {
    const f = fixture(); f.child.respond(init); f.child.respond(value); await rejected(f.promise);
    assert.deepEqual(f.child.kills, ['SIGKILL']); assert.equal(f.child.messages.length, 3); assert.equal(f.timers[0]?.cancelled, true);
  });
});

test('invalid initialization never sends a delete', async t => {
  for (const value of [{ id: 1, result: {} }, { id: 2, result: init.result }, { id: 1, error: { message: 'private initialization detail' } }]) {
    await t.test(JSON.stringify(value), async () => {
      const f = fixture(); f.child.respond(value); await rejected(f.promise); assert.equal(f.child.messages.length, 1);
    });
  }
});

test('output is bounded in bytes and malformed JSON or trailing data cannot become success', async t => {
  for (const kind of ['stdout limit', 'stderr limit', 'malformed JSON', 'trailing fragment', 'second result']) await t.test(kind, async () => {
    const f = fixture(); f.child.respond(init);
    if (kind === 'stdout limit') f.child.stdout.write(Buffer.alloc(65_537, 120));
    else if (kind === 'stderr limit') f.child.stderr.write(Buffer.alloc(16_385, 120));
    else if (kind === 'malformed JSON') f.child.stdout.write('fixture-private-raw-output\n');
    else {
      f.child.respond({ id: 2, result: { deleted: true } });
      if (kind === 'trailing fragment') { f.child.stdout.write('{"private":"unfinished'); f.child.close(); }
      else f.child.respond({ id: null, result: { deleted: true } });
    }
    await rejected(f.promise); assert.deepEqual(f.child.kills, ['SIGKILL']);
  });
});

test('one ten-second deadline bounds initialization, deletion and shutdown without a second request', async t => {
  for (const phase of ['initialize', 'delete', 'shutdown']) await t.test(phase, async () => {
    const f = fixture();
    if (phase !== 'initialize') f.child.respond(init);
    if (phase === 'shutdown') f.child.respond({ id: 2, result: { deleted: true } });
    assert.equal(f.timers.length, 1); assert.equal(f.timers[0]?.ms, 10_000);
    f.timers[0]!.callback(); await rejected(f.promise);
    assert.equal(f.child.stdin.destroyed, true); assert.deepEqual(f.child.kills, ['SIGKILL']);
    assert.equal(f.calls.length, 1); assert.equal(f.child.messages.length, phase === 'initialize' ? 1 : 3);
  });
});

test('spawn failures, pipe errors and unsuccessful exits stay sanitized', async t => {
  await rejected(withdrawCodexNotification('codex', threadId, queueId, { spawn: () => { throw new Error('private executable path'); } }));
  for (const phase of ['spawn error', 'stdin error', 'stdout error', 'stderr error', 'early close', 'nonzero exit', 'signal']) await t.test(phase, async () => {
    const f = fixture();
    if (phase === 'spawn error') f.child.emit('error', new Error('private spawn detail'));
    else if (phase.endsWith(' error')) f.child[phase.split(' ')[0] as 'stdin' | 'stdout' | 'stderr'].emit('error', new Error('private pipe detail'));
    else if (phase === 'early close') f.child.close();
    else { f.child.respond(init); f.child.respond({ id: 2, result: { deleted: true } }); f.child.close(phase === 'signal' ? null : 1, phase === 'signal' ? 'SIGTERM' : null); }
    await rejected(f.promise);
  });
});

test('invalid identifiers or executable reject before spawning', async () => {
  let calls = 0;
  for (const args of [
    ['codex --remote', threadId, queueId], ['/bad\ncommand', threadId, queueId], ['codex', 'not-a-uuid', queueId],
    ['codex', threadId, 'id;native-command'], ['codex', threadId, 'x'.repeat(161)],
  ]) await rejected(withdrawCodexNotification(args[0]!, args[1]!, args[2]!, { spawn: () => { calls++; throw new Error(); } }));
  assert.equal(calls, 0);
});

test('a real local fixture subprocess verifies stdio framing and shutdown without any native queue access', async () => {
  const script = `
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(1), ['app-server', '--listen', 'stdio://']);
    const lines = require('node:readline').createInterface({input:process.stdin});
    let step=0;
    lines.on('line', line => {
      const value=JSON.parse(line);
      if(step===0){
        assert.equal(value.method,'initialize'); assert.equal(value.params.capabilities.experimentalApi,true);
        process.stdout.write(JSON.stringify(${JSON.stringify(init)})+'\\n');
      }else if(step===1){assert.deepEqual(value,{method:'initialized',params:{}});}
      else if(step===2){
        assert.deepEqual(value,{id:2,method:'thread/queue/delete',params:{threadId:${JSON.stringify(threadId)},queuedSubmissionId:${JSON.stringify(queueId)}}});
        process.stdout.write('{"id":2,"result":{"deleted":true}}\\n');
      }else{assert.fail('Unexpected command');}
      step++;
    });
    lines.on('close',()=>{assert.equal(step,3);process.exit(0);});
  `;
  const result = await withdrawCodexNotification('/fixture/codex', threadId, queueId, {
    spawn: (command, args) => {
      assert.equal(command, '/fixture/codex');
      return spawn(process.execPath, ['-e', script, '--', ...args], { stdio: 'pipe', shell: false });
    },
  });
  assert.equal(result, 'deleted');
});
