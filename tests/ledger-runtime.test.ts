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
globalThis.fetch = () => { throw new Error('Network forbidden in Ledger runtime fixture'); };
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
    if (scenario === 'rejected') throw new LedgerSigningError('rejected');
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
  deadlineSeconds:120, pollSeconds:5, rebalanceIntervalSeconds:3600 });
await storage.atomicWriteJson(configModule.CONFIG_PATH, config);
const release = await storage.acquireLock(configModule.DATA, 'run.lock');
const blockHash = '0x' + 'a1'.repeat(32);
const receipts = new Map();
const chain = {
 publicClient: {
  getChainId:async()=>4663, getTransactionCount:async()=>sends,
  estimateGas:async()=>21000n, getGasPrice:async()=>1n, getBalance:async()=>10n**18n,
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
 quote:async()=>{quotes++; if(scenario==='quote-failed') throw new Error('Quote fixture failed'); return {amountOut:1n,minimumOut:1n,fee:500,blockNumber:102n};},
 transaction:async()=>({to:account.address,data:approvalDone?'0x02':'0x01',value:0n,kind:approvalDone?'swap':'approval'}),
};
let ledger=new request.LedgerExecution();
const presence={connected:true,revision:1};
try {
 if(scenario!=='no-intent' && scenario!=='ledger-alert-dedupe') await request.requestLedgerRebalance(randomUUID());
 if(scenario==='read-only-intent') {
  const state=await runtime.tick(false,()=>chain,ledger,undefined,presence);
  assert.equal(state.operation.status,'needs-rebalance'); assert.equal((await request.readLedgerRequest()).state,'requested');
 } else if(scenario==='restart') {
  await ledger.prepare(config); ledger=new request.LedgerExecution();
  await runtime.tick(true,()=>chain,ledger,undefined,presence);
  assert.equal((await request.readLedgerRequest()).state,'finished');
 } else if(scenario==='config-changed') {
  await storage.atomicWriteJson(configModule.CONFIG_PATH,{...config,slippageBps:75});
  await runtime.tick(true,()=>chain,ledger,undefined,presence);
  assert.equal((await request.readLedgerRequest()).state,'finished');
 } else if(scenario==='ledger-alert-dedupe') {
  // Presence is a hint only; disconnected drift does not call any signer.
  await runtime.tick(true,()=>chain,ledger,undefined,{connected:false,revision:0});
  assert.equal((await events()).filter(e=>e.type==='ledger-rebalance-needed').length,0);
  await runtime.tick(true,()=>chain,ledger,undefined,presence);
  const notice=(await events()).find(e=>e.type==='ledger-rebalance-needed'); assert.ok(notice);
  await acknowledgeEvent(notice.id);
  await runtime.tick(true,()=>chain,ledger,undefined,presence);
  assert.equal((await events()).filter(e=>e.type==='ledger-rebalance-needed').length,0);
 } else {
  const first=await runtime.tick(true,()=>chain,ledger,undefined,presence);
  if(scenario==='sequence') {
   assert.equal(first.operation.status,'pending'); assert.equal(signatures,1); assert.equal(ledger.active,true);
   const second=await runtime.tick(true,()=>chain,ledger,undefined,presence);
   assert.equal(second.operation.kind,'swap'); assert.equal(signatures,2); assert.equal(sends,2);
   const third=await runtime.tick(true,()=>chain,ledger,undefined,presence);
   assert.equal(third.operation.status,'confirmed'); assert.equal(third.proposal,null);
   assert.equal((await request.readLedgerRequest()).outcome,'on-target');
   assert.equal((await events()).filter(e=>e.type==='rebalance-completed').length,1);
   assert.equal(await storage.readJson(configModule.PENDING_PATH),null);
   assert.ok(snapshots>=3 && quotes>=2);
   await runtime.tick(true,()=>chain,ledger,undefined,presence); assert.equal(signatures,2);
  } else if(scenario==='unknown-send') {
   assert.equal(first.operation.status,'unresolved'); assert.equal(ledger.active,false);
   assert.equal((await request.readLedgerRequest()).outcome,'unresolved');
   now+=60000; await runtime.tick(true,()=>chain,ledger,undefined,presence);
   assert.equal(signatures,1); assert.equal(sends,1);
   assert.ok(await storage.readJson(configModule.PENDING_PATH));
   assert.equal(await storage.readJson(configModule.DATA+'/recovery.json'),null);
  } else if(scenario!=='no-intent') {
   assert.equal(ledger.active,false); assert.equal((await request.readLedgerRequest()).state,'finished');
   if(scenario==='rejected') {
    assert.equal(first.operation.status,'ledger-rejected'); assert.equal(first.error,null);
    assert.equal((await events()).filter(e=>e.type==='ledger-rebalance-needed').length,0);
   }
   const before=signatures; await runtime.tick(true,()=>chain,ledger,undefined,presence); assert.equal(signatures,before);
   if(scenario==='rejected') assert.equal((await events()).filter(e=>e.type==='ledger-rebalance-needed').length,0);
  }
 }
 if(['rejected','stopped-during-sign','expired-during-sign'].includes(scenario)) assert.equal(signatures,1,
   'the scenario must reach signing before its guard or device outcome prevents sending');
 if(!['sequence','unknown-send'].includes(scenario)) { assert.equal(sends,0); assert.equal(await storage.readJson(configModule.PENDING_PATH),null); }
 if(['no-intent','read-only-intent','restart','config-changed','quote-failed','ledger-alert-dedupe'].includes(scenario)) assert.equal(signatures,0);
 console.log(JSON.stringify({scenario,signatures,sends}));
} finally { await ledger.finish('fixture-ended'); await release(); }
`;

for (const scenario of ['sequence', 'no-intent', 'read-only-intent', 'restart', 'config-changed', 'rejected',
  'quote-failed', 'stopped-during-sign', 'expired-during-sign', 'unknown-send', 'ledger-alert-dedupe']) {
  test(`Ledger runtime: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rebalance-ledger-runtime-'));
    try {
      const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx',
        '--input-type=module', '-e', script, '--', new URL('../src/', import.meta.url).href, scenario], {
        env: { ...process.env, REBALANCE_DATA_DIR: directory, REBALANCE_ROOT_DIR: directory, REBALANCE_PROFILE_WALLET: '' }, timeout: 20_000,
      });
      assert.equal(JSON.parse(result.stdout).scenario, scenario);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
