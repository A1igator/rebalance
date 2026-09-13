import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectionPath, resolveProfile, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { withAllocation } from '../src/allocation-management.js';
import { validateConfig, type Config } from '../src/config.js';
import { ConfigLockBusyError } from '../src/config-lock.js';
import { receiveSharedCode, type ShareReceiveDependencies } from '../src/share-receive.js';
import { atomicWriteJson, readJson } from '../src/storage.js';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const code = 'rebalance:v1 NVDA=23.75,USDG=5,MSFT=23.75,AAPL=23.75,AMD=23.75 drift=2.5 interval=600';
const canonical = 'rebalance:v1 USDG=5,AAPL=23.75,AMD=23.75,MSFT=23.75,NVDA=23.75 drift=2.5 interval=600';
const targets = {USDG:500,AAPL:2375,AMD:2375,MSFT:2375,NVDA:2375};
const session = 'share-receive-fixture';
const request = 'a'.repeat(64);
async function fixture(t: TestContext, count = 2) {
 const root = await mkdtemp(join(tmpdir(), 'rebalance-share-receive-'));
 t.after(() => rm(root,{recursive:true,force:true}));
 const profiles: RoutedProfile[] = Array.from({length:count},(_,i) => {
  const wallet = `0x${String(i+1).padStart(40,'0')}`, directory = `wallets/${wallet}`;
  return {wallet,chainId:4663,directory,dataDir:join(root,directory),rootDir:root,chartPort:4664+i};
 });
 const registry={version:1,profiles:profiles.map(({wallet,chainId,directory,chartPort})=>({wallet,chainId,directory,chartPort}))};
 await atomicWriteJson(join(root,'portfolios.json'),registry);
 for (const p of profiles) await atomicWriteJson(join(p.dataDir,'config.json'),{
  version:1,chainId:4663,wallet:p.wallet,mode:'ledger',rpcUrl:'https://fixture.invalid/private-service-path',
  targets:{USDG:2000,TSLA:2000,AAPL:2000,NVDA:2000,AMZN:2000},
  driftThresholdBps:500,slippageBps:65,deadlineSeconds:120,pollSeconds:30,rebalanceIntervalSeconds:3600,
  rebalanceFeeTargetUsdE8:'5000000',
 });
 let viewCalls=0;
 const deps: Partial<ShareReceiveDependencies> = {view:async(r,s,w)=>{
  viewCalls++; assert.equal(r,root); assert.equal(s,session); assert.equal(w,undefined);
  return {state:'ready',url:`http://127.0.0.1:4664/#view=${'b'.repeat(64)}`,connected:true,tradingChanged:false};
 }};
 const connect=(index:number)=>atomicWriteJson(connectionPath(root,session),{version:1,chainId:4663,wallet:profiles[index]!.wallet});
 const snapshot=async()=>Promise.all(profiles.map(p=>readFile(join(p.dataDir,'config.json'),'utf8')));
 const configPath=(index=0)=>join(profiles[index]!.dataDir,'config.json');
 const config=async(index=0)=>validateConfig(await readJson(configPath(index)));
 const receive=(extra:Partial<ShareReceiveDependencies>={},id=request,input=code,wallet?:string)=>
  receiveSharedCode(root,session,input,id,wallet,{...deps,...extra});
 return {root,profiles,registry,deps,connect,snapshot,configPath,config,receive,
  journalPath:join(root,'share-receive',`${request}.json`),get viewCalls(){return viewCalls;}};
}

test('receive applies included settings to captured wallet, preserving unrelated config and all execution files', async t => {
 const f=await fixture(t);await f.connect(0);const before=await f.config(),other=(await f.snapshot())[1];
 const files=['run.lock','stop.json','cycle.json','pending.json','runner-preference.json','ledger-request.json'];
 for(const file of files)await atomicWriteJson(join(f.profiles[0]!.dataDir,file),{fixture:file});
 const result=await f.receive();
 assert.equal(result.outcome,'applied');if(result.outcome!=='applied')assert.fail();
 assert.equal(result.applied,true);assert.equal(result.wallet,f.profiles[0]!.wallet);assert.equal(result.chainId,4663);
 assert.equal(result.code,canonical);assert.deepEqual(result.shared,{targets,driftThresholdBps:250,rebalanceIntervalSeconds:600});
 assert.deepEqual([...result.untrackedAssets].sort(),['AMZN','TSLA']);assert.match(result.note!,/stay in the wallet/);
 const appliedConfig = await f.config();
 assert.match(appliedConfig.rebalanceRequestId!,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 assert.deepEqual(appliedConfig,{...before,targets,driftThresholdBps:250,rebalanceIntervalSeconds:600,rebalanceRequestId:appliedConfig.rebalanceRequestId});
 assert.equal((await f.snapshot())[1],other);assert.equal(f.viewCalls,0);
 for(const file of files)assert.deepEqual(await readJson(join(f.profiles[0]!.dataDir,file)),{fixture:file});
 const journal=await readFile(f.journalPath,'utf8');
 assert.doesNotMatch(JSON.stringify(result)+journal,/private-service-path|rpcUrl|slippage|rebalanceFeeTarget|ledger|run.lock/);
});

test('manual imported targets clear managed allocation while absent settings retain current values',async t=>{
 const f=await fixture(t);await f.connect(0);const before=await f.config();
 const managed=withAllocation(before,{version:1,objective:'user-risk',horizonMonths:60,stepBps:500,benchmarkReturnBps:0,
  assets:Object.fromEntries(Object.keys(before.targets).map((id,i)=>[id,{riskScore:40,expectedReturnBps:500*(i+1),minBps:2000,maxBps:2000}]))});
 await atomicWriteJson(f.configPath(),managed);
 const result=await f.receive({},request,code.split(' drift=')[0]!);
 assert.equal(result.outcome,'applied');if(result.outcome!=='applied')assert.fail();
 assert.equal(result.settingsApplied,false);assert.deepEqual(result.settingChanges,[]);
 assert.equal(result.shared.driftThresholdBps,null);assert.equal(result.shared.rebalanceIntervalSeconds,null);
 const next=await f.config();assert.equal(next.allocation,undefined);
 assert.match(next.rebalanceRequestId!,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 assert.deepEqual(next,{...before,targets,rebalanceRequestId:next.rebalanceRequestId});
});

test('unattached even single-wallet portfolios never apply; selecting later cannot consume the old request',async t=>{
 for(const count of [0,1,2])await t.test(`${count} wallets`,async t=>{
  const f=await fixture(t,count);const before=await f.snapshot();
  const result=await f.receive({resolve:async()=>assert.fail('unattached import must not resolve a wallet'),config:async()=>assert.fail()});
  assert.equal(result.outcome,'select-portfolio');assert.equal(result.applied,false);assert.equal(f.viewCalls,1);
  assert.equal('targetChanges' in result,false);assert.deepEqual(await f.snapshot(),before);
  if(count){await f.connect(0);const replay=await f.receive();assert.equal(replay.outcome,'select-portfolio');assert.equal(replay.replayed,true);
   assert.deepEqual(await f.snapshot(),before);assert.equal((await f.receive({},'b'.repeat(64))).outcome,'applied');}
 });
});

test('applied duplicate returns original receipt after configuration and selection changes without reapplying',async t=>{
 const f=await fixture(t);await f.connect(0);const first=await f.receive();assert.equal(first.outcome,'applied');
 await atomicWriteJson(f.configPath(),{...await f.config(),driftThresholdBps:900});await f.connect(1);const before=await f.snapshot();
 const replay=await f.receive({connection:async()=>assert.fail('replay cannot follow attachment'),config:async()=>assert.fail('receipt only')});
 assert.deepEqual(replay,{...first,replayed:true});assert.deepEqual(await f.snapshot(),before);
 const mismatch=await f.receive({},request,code.replace('drift=2.5','drift=3'));
 assert.equal(mismatch.outcome,'unknown');assert.equal(mismatch.applied,null);assert.deepEqual(await f.snapshot(),before);
});

test('selection is fixed before asynchronous resolution even if the chat switches portfolios',async t=>{
 const f=await fixture(t);await f.connect(0);const other=(await f.snapshot())[1];
 const result=await f.receive({resolve:async(root,options)=>{assert.deepEqual(options,{wallet:f.profiles[0]!.wallet});await f.connect(1);return resolveProfile(root,options);}});
 assert.equal(result.outcome,'applied');assert.equal('wallet' in result&&result.wallet,f.profiles[0]!.wallet);assert.equal((await f.snapshot())[1],other);
});

test('known prewrite lock refusal is terminal across configuration edits and selection changes',async t=>{
 const f=await fixture(t);await f.connect(0);
 const first=await f.receive({configLock:async()=>{throw new ConfigLockBusyError();}});assert.equal(first.outcome,'blocked');assert.equal(first.applied,false);
 await atomicWriteJson(f.configPath(),{...await f.config(),driftThresholdBps:950});await f.connect(1);const before=await f.snapshot();
 const replay=await f.receive({configLock:async()=>assert.fail('blocked request may not retry config lock')});
 assert.deepEqual(replay,{...first,replayed:true});assert.deepEqual(await f.snapshot(),before);
});

test('stale registry and malformed connection/config failures remain terminal after repair',async t=>{
 for(const broken of ['registry','connection','config'] as const)await t.test(broken,async t=>{
  const f=await fixture(t);await f.connect(0);const original=await f.config();
  if(broken==='registry')await atomicWriteJson(join(f.root,'portfolios.json'),{version:1,profiles:[]});
  if(broken==='connection')await atomicWriteJson(connectionPath(f.root,session),{version:99,wallet:f.profiles[0]!.wallet});
  if(broken==='config')await atomicWriteJson(f.configPath(),{...original,wallet:f.profiles[1]!.wallet});
  const first=await f.receive();assert.equal(first.outcome,'blocked');assert.equal(first.applied,false);
  await atomicWriteJson(join(f.root,'portfolios.json'),f.registry);await atomicWriteJson(f.configPath(),original);await f.connect(1);
  const before=await f.snapshot();const replay=await f.receive();assert.equal(replay.outcome,'blocked');assert.equal('replayed' in replay&&replay.replayed,true);assert.deepEqual(await f.snapshot(),before);
 });
});

test('uncertain config or receipt commit returns unknown and never reapplies, including after wallet switch',async t=>{
 for(const failure of ['config-before','config-after','receipt-before','receipt-after'] as const)await t.test(failure,async t=>{
  const f=await fixture(t);await f.connect(0);let configWrites=0;
  const write:typeof atomicWriteJson=async(path,value)=>{
   if(path===f.configPath()){
    configWrites++;if(failure==='config-before')throw new Error('fixture-private-io-error');
    await atomicWriteJson(path,value);if(failure==='config-after')throw new Error('fixture-private-io-error');return;
   }
   if((value as {state?:string}).state==='applied'){
    if(failure==='receipt-before')throw new Error('fixture-private-io-error');
    await atomicWriteJson(path,value);if(failure==='receipt-after')throw new Error('fixture-private-io-error');return;
   }
   await atomicWriteJson(path,value);
  };
  const result=await f.receive({write});assert.equal(result.outcome,'unknown');assert.equal(result.applied,null);assert.equal(configWrites,1);
  assert.doesNotMatch(JSON.stringify(result),/fixture-private/);
  await atomicWriteJson(f.configPath(),{...await f.config(),driftThresholdBps:950});await f.connect(1);const before=await f.snapshot();
  const replay=await f.receive({write:async()=>assert.fail('uncertain or completed request must not write')});
  assert.equal(replay.outcome,failure==='receipt-after'?'applied':'unknown');assert.equal(replay.replayed,true);assert.deepEqual(await f.snapshot(),before);
 });
});

test('interrupted started request and malformed receipt fail closed before reading selection',async t=>{
 for(const failure of ['started','malformed'] as const)await t.test(failure,async t=>{
  const f=await fixture(t);await f.connect(0);const before=await f.snapshot();
  // Persist first native claim, then simulate the process disappearing before routing.
  await f.receive({connection:async()=>{throw new Error('simulated interruption');},write:async(path,value)=>{
   if((value as {state?:string}).state==='blocked')throw new Error('cannot finish terminal receipt');await atomicWriteJson(path,value);
  }});
  if(failure==='malformed')await writeFile(f.journalPath,'{"privatePayload":"fixture-private"');
  await f.connect(1);const result=await f.receive({connection:async()=>assert.fail('do not reroute'),write:async()=>assert.fail('do not overwrite barrier')});
  assert.equal(result.outcome,'unknown');assert.equal(result.applied,null);assert.deepEqual(await f.snapshot(),before);assert.doesNotMatch(JSON.stringify(result),/fixture-private/);
 });
});

test('invalid code and identity reject before routing, locks, config or journal IO',async t=>{
 const f=await fixture(t);const before=(await readdir(f.root)).sort();
 const fail=async()=>assert.fail('invalid request must not touch local state');
 const deps={connection:fail,resolve:fail,config:fail,view:fail,read:fail,write:fail,requestLock:fail,configLock:fail};
 for(const input of ['fixture-private-input',code+' --apply',code+' wallet=secret',code+' drift=5']){
  const result=await f.receive(deps,request,input);assert.equal(result.outcome,'blocked');assert.equal(result.applied,false);assert.doesNotMatch(JSON.stringify(result),/fixture-private-input|secret/);
 }
 for(const [id,s] of [[undefined,session],['bad',session],[request,undefined]] as const){
  const result=await receiveSharedCode(f.root,s,code,id,undefined,deps);assert.equal(result.outcome,'blocked');
 }
 assert.deepEqual((await readdir(f.root)).sort(),before);
});

test('simultaneous deliveries cannot both write configuration',async t=>{
 const f=await fixture(t);await f.connect(0);let release!:()=>void,entered!:()=>void,configWrites=0;
 const waiting=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 const pending=f.receive({config:async profile=>{entered();await waiting;return readJson(join(profile.dataDir,'config.json'));},
  write:async(path,value)=>{if(path===f.configPath())configWrites++;await atomicWriteJson(path,value);}});
 await started;const duplicate=await f.receive();assert.equal(duplicate.outcome,'unknown');release();assert.equal((await pending).outcome,'applied');
 assert.equal(configWrites,1);assert.equal((await f.receive()).outcome,'applied');
});

test('explicit CLI scope does not change attachment and pinned receive rejects mismatched directories before any config write',async t=>{
 const f=await fixture(t);await f.connect(0);
 const preload=join(f.root,'execution-boundary.mjs');
 await writeFile(preload,`
  import {registerHooks,syncBuiltinESMExports} from 'node:module';
  import http from 'node:http'; import child from 'node:child_process';
  http.get=()=>{throw new Error('unexpected network access');};
  child.execFile=()=>{throw new Error('unexpected child dispatch');}; syncBuiltinESMExports();
  registerHooks({load(url,context,nextLoad){
   if(['commands','runtime','chain','signers','launch','app-launch','graph'].some(name=>url.endsWith('/src/'+name+'.ts')))throw new Error('Unexpected execution module');
   return nextLoad(url,context);
  }});
 `);
 const env:NodeJS.ProcessEnv={...process.env,REBALANCE_ROOT_DIR:f.root,REBALANCE_DATA_DIR:f.root,NODE_OPTIONS:`--import=${preload}`};
 for(const name of ['REBALANCE_PROFILE_PINNED','REBALANCE_PROFILE_WALLET','REBALANCE_CHART_PORT','REBALANCE_SESSION_ID','CODEX_THREAD_ID','CLAUDE_CODE_SESSION_ID','REBALANCE_PRIVATE_KEY'])delete env[name];
 const command=(args:string[],extra:NodeJS.ProcessEnv={})=>execute(process.execPath,['--import','tsx',cli,...args],{cwd:repository,env:{...env,...extra},timeout:10_000});
 const args=['share','receive',code,'--session',session,'--request-id',request];
 const before=await f.snapshot();const first=JSON.parse((await command([...args,'--profile',f.profiles[1]!.wallet!])).stdout);
 assert.equal(first.outcome,'applied');assert.equal(first.wallet,f.profiles[1]!.wallet);assert.equal((await f.snapshot())[0],before[0]);
 assert.equal((await readJson<{wallet:string}>(connectionPath(f.root,session)))!.wallet,f.profiles[0]!.wallet);
 const pinned={REBALANCE_PROFILE_PINNED:'1',REBALANCE_PROFILE_WALLET:f.profiles[0]!.wallet!,REBALANCE_DATA_DIR:f.profiles[0]!.dataDir};
 await assert.rejects(command([...args,'--profile',f.profiles[1]!.wallet!],pinned));
 const pinnedArgs=args.map(arg=>arg===request?'c'.repeat(64):arg);
 const mismatch=JSON.parse((await command(pinnedArgs,{...pinned,REBALANCE_DATA_DIR:f.profiles[1]!.dataDir})).stdout);
 assert.equal(mismatch.outcome,'blocked');assert.equal((await f.snapshot())[0],before[0]);
 await assert.rejects(command([...args,'--apply']));await assert.rejects(command([...args,'--settings']));
 await assert.rejects(command(args.filter(arg=>arg!==request&&arg!=='--request-id')));
});


test('native share intent is committed after its applying barrier and dedupe never mints again', async t => {
 const f=await fixture(t);await f.connect(0);
 const seen:string[]=[];
 const write:typeof atomicWriteJson=async(path,value)=>{
  if(path===f.configPath()){
   const pending=await readJson<{state:string}>(f.journalPath);
   assert.equal(pending?.state,'applying','the journal barrier must exist before the request-bearing config commit');
   const id=(value as Config).rebalanceRequestId!;
   assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);seen.push(id);
  }
  await atomicWriteJson(path,value);
 };
 assert.equal((await f.receive({write})).outcome,'applied');
 const first=await f.config(),firstBytes=await readFile(f.configPath(),'utf8');
 assert.equal(seen.length,1);assert.equal(first.rebalanceRequestId,seen[0]);
 const replay=await f.receive({write});assert.equal('replayed' in replay&&replay.replayed,true);
 assert.equal(seen.length,1);assert.equal(await readFile(f.configPath(),'utf8'),firstBytes);
 const next=await f.receive({},'b'.repeat(64));assert.equal(next.outcome,'applied');
 const second=await f.config();assert.deepEqual(second.targets,first.targets);
 assert.notEqual(second.rebalanceRequestId,first.rebalanceRequestId,'a new native request with the same code is fresh explicit intent');
 const before=await readFile(f.configPath(),'utf8');
 const oldReplay=await f.receive({write});assert.equal('replayed' in oldReplay&&oldReplay.replayed,true);
 assert.equal(await readFile(f.configPath(),'utf8'),before,'replaying the older request must not replace the newer marker');
});
