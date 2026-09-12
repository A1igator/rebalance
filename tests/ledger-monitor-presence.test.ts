import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

// Production monitor wiring, with only native discovery, wake feeds and the
// scheduling driver replaced. No graph execution, device connection or RPC.
const script = `
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
const [base] = process.argv.slice(1);
const path = name => new URL(name + '.ts', base).href;
globalThis.fetch = () => assert.fail('No network in discovery recovery fixture');
let now = Date.now(); mock.method(Date, 'now', () => now);
const onboarding = await import(path('ledger-onboarding'));
let listeners=0, closed=0;
const callbacks=[];
mock.module(path('ledger-onboarding'), { namedExports: { ...onboarding,
  watchLedgerPresence: (changed, _options, unavailable) => {
    listeners++; callbacks.push({changed,unavailable}); changed(false,false); changed(true,true);
    return async () => { closed++; };
  },
  withLedgerDevice: () => assert.fail('No hardware in discovery recovery fixture'),
} });
mock.module(path('wake'), { namedExports: { createWakeSource: () => ({ close:async()=>{} }) } });
const request = await import(path('ledger-request'));
const configModule = await import(path('config'));
const storage = await import(path('storage'));
const config = configModule.validateConfig({version:1,chainId:4663,wallet:'0x0000000000000000000000000000000000000001',
 mode:'ledger',rpcUrl:'http://blocked-fixture.invalid',targets:{USDG:2000,AAPL:2000,NVDA:2000,MSFT:2000,AMD:2000},
 driftThresholdBps:500,slippageBps:50,deadlineSeconds:120,pollSeconds:5});
await storage.atomicWriteJson(configModule.CONFIG_PATH,config);
const release = await storage.acquireLock(configModule.DATA,'run.lock');
const original = new request.LedgerExecution();
await request.requestLedgerRebalance(); await original.prepare(config); await original.finish('rejected');
const checkSuspension = async () => assert.deepEqual(await request.readLedgerPromptState(),{suspended:true,outcome:'rejected'});
mock.module(path('monitor'), { namedExports: { driveMonitor:async deps => {
 await deps.read();
 const wake = deps.source({dataDir:configModule.DATA,signal:deps.signal,onWake(){}});
 await deps.read(); assert.equal(listeners,1); await checkSuspension();
 callbacks[0].changed(false,false); callbacks[0].unavailable();
 await deps.read(); assert.equal(listeners,1);
 now+=4999; await deps.read(); assert.equal(listeners,1,'no busy restart loop');
 now+=1; await deps.read(); await deps.read();
 assert.equal(listeners,2); assert.equal(closed,1,'the failed listener closes before replacement');
 await checkSuspension();
 // A failed durable presence update cannot poison every later observation or
 // turn an unrecorded disconnect into restart/retry authority.
 const file=configModule.DATA+'/ledger-request.json', journal=await readFile(file,'utf8');
 await writeFile(file,'invalid public fixture journal');
 callbacks[1].changed(false,true);
 await assert.rejects(deps.read());
 await writeFile(file,journal);
 callbacks[1].changed(true,true);
 await deps.read(); await checkSuspension();
 await wake.close();
} } });
try {
 const { monitor } = await import(path('runtime'));
 await monitor(new AbortController().signal);
 assert.equal(listeners,2); assert.equal(closed,2); await checkSuspension();
 console.log('passed');
} finally { await release(); }
`;

test('monitor restarts terminated discovery after bounded backoff without resetting failure suspension', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-ledger-presence-monitor-'));
  try {
    const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx',
      '--input-type=module', '-e', script, '--', new URL('../src/', import.meta.url).href], {
      env: { ...process.env, REBALANCE_DATA_DIR: directory, REBALANCE_ROOT_DIR: directory, REBALANCE_PROFILE_WALLET: '' },
      timeout: 20_000,
    }).catch(error => { throw new Error(String(error.stderr || error.message).slice(-5000)); });
    assert.equal(result.stdout.trim(), 'passed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
