import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

// Production graph, request journal, dispatch and receipt handling with only
// the chain and device signer replaced by public, offline fixtures.
const script = `
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const [base, scenario] = process.argv.slice(1);
const path = name => new URL(name + '.ts', base).href;
let affordable = false;
globalThis.fetch = url => {
  if(scenario!=='automatic-fees') throw new Error('Network forbidden in Ledger runtime fixture');
  assert.equal(url,'https://api.coinbase.com/v2/prices/ETH-USD/spot');
  return Promise.resolve(new Response(JSON.stringify({data:{base:'ETH',currency:'USD',amount:affordable?'100':'9000'}})));
};
delete process.env.REBALANCE_PRIVATE_KEY;
const account = privateKeyToAccount('0x' + '1'.padStart(64, '0'));
const { LedgerSigningError } = await import(path('ledger-signing'));
let signatures = 0, sends = 0, snapshots = 0, quotes = 0, approvalDone = false, swapDone = false;
let configModule, storage, runtime;
let now = Date.now(); mock.method(Date, 'now', () => now);
mock.module(path('signers'), { namedExports: { loadSigner: async config => {
  assert.equal(config.mode, 'ledger');
  return { address: account.address, signTransaction: async tx => {
    signatures++;
    assert.equal((await request.readLedgerRequest()).state, 'consumed');
    assert.equal(await storage.readJson(configModule.DATA + '/config.lock'), null,
      'settings edits must remain available while the Ledger prompt is active');
    assert.equal(tx.chainId, 4663);
    if (['rejected','unavailable','timeout','unsupported','discovery-error-restart'].includes(scenario)) {
      throw new LedgerSigningError(scenario==='discovery-error-restart'?'unavailable':scenario, {phase:'sign',elapsedMs:10,step:'signer.eth.steps.buildContexts',errorTag:'SendCommandTimeoutError'});
    }
    if (['reconnect-retry','explicit-retry'].includes(scenario) && signatures===1) throw new LedgerSigningError('rejected');
    if (scenario === 'stopped-during-sign') await storage.atomicWriteJson(runtime.STOP_PATH, { requestedAt: 'fixture-stop' });
    if (scenario === 'expired-during-sign') now += 121000;
    return account.signTransaction(tx);
  } };
} } });
configModule = await import(path('config')); storage = await import(path('storage'));
runtime = await import(path('runtime'));
const request = await import(path('ledger-request'));
const { evaluatePortfolio } = await import(path('core'));
const { events, acknowledgeEvent } = await import(path('events'));
const targets = { USDG: 2000, AAPL: 2000, NVDA: 2000, MSFT: 2000, AMD: 2000 };
const config = configModule.validateConfig({ version:1, wallet:account.address, mode:'ledger', chainId:4663,
  targets, rpcUrl:'http://blocked-fixture.invalid', driftThresholdBps:500, slippageBps:50,
  deadlineSeconds:120, pollSeconds:5, rebalanceIntervalSeconds:3600,
  ...(scenario==='automatic-fees'?{rebalanceFeeTargetUsdE8:'200000000'}:{}) });
await storage.atomicWriteJson(configModule.CONFIG_PATH, config);
const release = await storage.acquireLock(configModule.DATA, 'run.lock');
const blockHash = '0x' + 'a1'.repeat(32);
const receipts = new Map();
const chain = {
 publicClient: {
  getChainId:async()=>4663, getTransactionCount:async()=>sends,
  estimateGas:async()=>21000n, getGasPrice:async()=>scenario==='automatic-fees'?1000000000n:1n, getBalance:async()=>10n**18n,
  sendRawTransaction:async({serializedTransaction})=>{
   // Inspect synchronously: the short send boundary ends before its response.
   const lock=JSON.parse(readFileSync(configModule.DATA+'/config.lock','utf8'));
   assert.equal(lock.pid,process.pid,'the selected runner owns the settings boundary when invoking send');
   sends++;
   if(scenario==='unknown-send') throw new Error('offline ambiguous response');
   const hash=keccak256(serializedTransaction), pending=await storage.readJson(configModule.PENDING_PATH);
   assert.equal(pending.hash,hash); assert.equal(pending.status,'prepared');
   receipts.set(hash,{transactionHash:hash,from:account.address,status:'success',blockNumber:100n,blockHash,kind:pending.kind});
   return hash;
  },
  getTransactionReceipt:async({hash})=>{
   const receipt=receipts.get(hash); if(!receipt) throw new TransactionReceiptNotFoundError({hash});
   if(receipt.kind==='approval') approvalDone=true; else swapDone=true;
   return receipt;
  },
  getBlock:async()=>({hash:blockHash}), getBlockNumber:async()=>102n,
 },
 snapshot:async()=>{
  snapshots++;
  const portfolio=evaluatePortfolio(Object.keys(targets).map(id=>({id,symbol:id,decimals:6,
    balance:swapDone?20000000n:id==='USDG'?100000000n:0n, priceUsdE8:100000000n,targetBps:targets[id]})));
  return {portfolio,nativeBalance:10n**18n,blockNumber:102n,valuationNote:'Offline fixture'};
 },
 quote:async()=>{quotes++; if(scenario==='quote-failed') throw new Error('Quote fixture failed'); if(scenario==='config-changed') await storage.atomicWriteJson(configModule.CONFIG_PATH,{...config,slippageBps:75}); return {amountOut:1n,minimumOut:1n,fee:500,blockNumber:102n};},
 transaction:async()=>({to:account.address,data:approvalDone?'0x02':'0x01',value:0n,kind:approvalDone?'swap':'approval'}),
 quoteBatch:async plan=>({quotes:await Promise.all(plan.trades.map(trade=>chain.quote(trade))),blockNumber:102n}),
 transactionBatch:async(plan,batch)=>({...await chain.transaction(plan.trades[0],batch.quotes[0]),swapCount:plan.trades.length,approvalCount:approvalDone?0:1}),
};
let ledger=new request.LedgerExecution();
const presence={connected:scenario!=='disconnected',revision:1};
const automaticScenarios=['automatic-sequence','automatic-fees','disconnected','automatic-read-only','reconnect-retry','explicit-retry','cooling-down','pending-barrier'];
try {
 if(!automaticScenarios.includes(scenario)) await request.requestLedgerRebalance(randomUUID());
 if(scenario==='cooling-down') await storage.atomicWriteJson(runtime.CYCLE_PATH,{wallet:account.address,
   startedAt:now-600000,activeUntil:now-1,nextEligibleAt:now+3000000,swapConfirmed:true});
 if(scenario==='pending-barrier') await storage.atomicWriteJson(configModule.PENDING_PATH,{chainId:4663,wallet:account.address,
   hash:'0x'+'a2'.repeat(32),nonce:0,kind:'swap',createdAt:new Date(now).toISOString(),status:'unknown'});
 if(['read-only-intent','automatic-read-only'].includes(scenario)) {
  const state=await runtime.tick(false,()=>chain,ledger,undefined,presence);
  assert.equal(state.operation.status,'needs-rebalance');
  assert.equal((await request.readLedgerRequest())?.state,scenario==='read-only-intent'?'requested':undefined);
 } else if(scenario==='restart') {
  await ledger.prepare(config); ledger=new request.LedgerExecution();
  const state=await runtime.tick(true,()=>chain,ledger,undefined,presence);
  assert.equal((await request.readLedgerRequest()).state,'finished'); assert.equal(state.ledgerPrompt.suspended,true);
 } else {
  if(scenario==='automatic-fees') {
   const waiting=await runtime.tick(true,()=>chain,ledger,undefined,presence);
   assert.equal(waiting.operation.status,'fee-target'); assert.equal(signatures,0);
   assert.equal(await request.readLedgerRequest(),null); assert.deepEqual(await events(),[]);
   affordable=true;
  }
  const first=await runtime.tick(true,()=>chain,ledger,undefined,presence);
  assert.ok(first.operation || first.error,JSON.stringify({error:first.error,graph:first.graph,request:first.ledgerRequest,signatures}));
  if(['sequence','automatic-sequence','automatic-fees'].includes(scenario)) {
   assert.equal(first.operation.status,'pending'); assert.equal(signatures,1); assert.equal(ledger.active,true);
   assert.equal(first.ledgerPrompt.connected,true);
   const firstId=(await request.readLedgerRequest()).id;
   const second=await runtime.tick(true,()=>chain,ledger,undefined,presence);
   assert.equal(second.operation.kind,'swap'); assert.equal(signatures,2); assert.equal(sends,2);
   const third=await runtime.tick(true,()=>chain,ledger,undefined,presence);
   assert.equal(third.operation.status,'confirmed'); assert.equal(third.proposal,null);
   assert.equal((await request.readLedgerRequest()).outcome,'on-target');
   assert.equal((await events()).filter(e=>e.type==='rebalance-completed').length,1);
   assert.equal((await events()).filter(e=>e.type==='ledger-rebalance-needed').length,0);
   assert.equal(await storage.readJson(configModule.PENDING_PATH),null);
   assert.ok(snapshots>=3 && quotes>=2);
   await runtime.tick(true,()=>chain,ledger,undefined,presence); assert.equal(signatures,2);
   if(scenario==='automatic-sequence') {
    swapDone=false;
    const cooling=await runtime.tick(true,()=>chain,ledger,undefined,presence);
    assert.equal(cooling.operation.status,'cooling-down'); assert.equal(signatures,2);
    now+=3600000;
    await runtime.tick(true,()=>chain,ledger,undefined,presence);
    assert.equal(signatures,3); assert.equal(sends,3);
    assert.notEqual((await request.readLedgerRequest()).id,firstId);
   }
  } else if(scenario==='unknown-send') {
   assert.equal(first.operation.status,'unresolved'); assert.equal(ledger.active,false);
   assert.equal((await request.readLedgerRequest()).outcome,'unresolved');
   now+=60000; await runtime.tick(true,()=>chain,ledger,undefined,presence);
   assert.equal(signatures,1); assert.equal(sends,1);
   assert.ok(await storage.readJson(configModule.PENDING_PATH));
   assert.equal(await storage.readJson(configModule.DATA+'/recovery.json'),null);
  } else if(['reconnect-retry','explicit-retry'].includes(scenario)) {
   assert.equal(first.operation.status,'ledger-rejected'); assert.equal(first.ledgerPrompt.suspended,true);
   const firstId=(await request.readLedgerRequest()).id;
   ledger=new request.LedgerExecution();
   await runtime.tick(true,()=>chain,ledger,undefined,presence); assert.equal(signatures,1);
   if(scenario==='reconnect-retry') {
    presence.connected=false; presence.revision++;
    await runtime.tick(true,()=>chain,ledger,undefined,presence); assert.equal(signatures,1);
    presence.connected=true; presence.revision++;
   } else await request.requestLedgerRebalance(randomUUID());
   const resumed=await runtime.tick(true,()=>chain,ledger,undefined,presence);
   assert.equal(resumed.operation.status,'pending'); assert.equal(signatures,2); assert.equal(sends,1);
   assert.equal(resumed.ledgerPrompt.suspended,false);
   assert.notEqual((await request.readLedgerRequest()).id,firstId);
   assert.ok(snapshots>=3 && quotes>=3, 'retry rebuilds with new observations and quotes');
  } else if(['disconnected','cooling-down','pending-barrier'].includes(scenario)) {
   assert.equal(first.operation.status,scenario==='disconnected'?'waiting-ledger':scenario==='cooling-down'?'cooling-down':'unresolved');
   assert.equal(await request.readLedgerRequest(),null); assert.equal(signatures,0);
   assert.equal((await events()).filter(e=>e.type==='ledger-rebalance-needed').length,0);
   if(scenario==='pending-barrier') assert.equal(snapshots,0, 'pending receipts remain ahead of automatic request creation');
  } else {
   assert.equal(ledger.active,false); assert.equal((await request.readLedgerRequest()).state,'finished');
   if(['rejected','unavailable','timeout','unsupported','discovery-error-restart'].includes(scenario)) {
    assert.equal(first.operation.status,'ledger-'+(scenario==='discovery-error-restart'?'unavailable':scenario)); assert.equal(first.ledgerPrompt.suspended,true);
    const firstMessage=first.operation.message;
    if(scenario==='discovery-error-restart') {
      presence.connected=false; presence.observed=false; presence.revision++;
      const unavailable=await runtime.tick(true,()=>chain,ledger,undefined,presence);
      assert.equal(unavailable.ledgerPrompt.suspended,true);
      presence.connected=true; presence.observed=true; presence.revision++;
    }
    ledger=new request.LedgerExecution();
    const repeated=await runtime.tick(true,()=>chain,ledger,undefined,presence);
    assert.equal(signatures,1); assert.equal(repeated.ledgerPrompt.suspended,true);
    assert.equal(repeated.operation.message,firstMessage);
    assert.match(repeated.operation.message,/signer.eth.steps.buildContexts/);
    assert.equal((await events()).filter(e=>e.type==='ledger-rebalance-needed').length,0);
   } else if(scenario!=='config-changed') {
    const before=signatures; await runtime.tick(true,()=>chain,ledger,undefined,presence); assert.equal(signatures,before);
   }
  }
 }
 if(['rejected','unavailable','timeout','unsupported','discovery-error-restart','stopped-during-sign','expired-during-sign'].includes(scenario)) assert.equal(signatures,1);
 if(!['sequence','automatic-sequence','automatic-fees','unknown-send','reconnect-retry','explicit-retry','pending-barrier'].includes(scenario)) {
  assert.equal(sends,0); assert.equal(await storage.readJson(configModule.PENDING_PATH),null);
 }
 if(['disconnected','read-only-intent','automatic-read-only','restart','config-changed','quote-failed','cooling-down','pending-barrier'].includes(scenario)) assert.equal(signatures,0);
 console.log(JSON.stringify({scenario,signatures,sends}));
} finally { await ledger.finish('fixture-ended'); await release(); }
`;

for (const scenario of ['sequence', 'automatic-sequence', 'automatic-fees', 'disconnected', 'read-only-intent', 'automatic-read-only',
  'restart', 'config-changed', 'rejected', 'discovery-error-restart', 'unavailable', 'timeout', 'unsupported', 'reconnect-retry', 'explicit-retry',
  'quote-failed', 'stopped-during-sign', 'expired-during-sign', 'unknown-send', 'cooling-down', 'pending-barrier']) {
  test(`Ledger runtime: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rebalance-ledger-runtime-'));
    try {
      const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx',
        '--input-type=module', '-e', script, '--', new URL('../src/', import.meta.url).href, scenario], {
        env: { ...process.env, REBALANCE_DATA_DIR: directory, REBALANCE_ROOT_DIR: directory, REBALANCE_PROFILE_WALLET: '' }, timeout: 20_000,
      }).catch(error => { throw new Error(String(error.stderr || error.message).slice(-5000)); });
      assert.equal(JSON.parse(result.stdout).scenario, scenario);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
