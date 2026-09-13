import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectionPath, resolveProfile, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { previewSharedCode, type SharePreviewDependencies } from '../src/share-preview.js';
import { atomicWriteJson, readJson } from '../src/storage.js';
import { ViewError } from '../src/view-error.js';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const code = 'rebalance:v1 NVDA=23.75,USDG=5,MSFT=23.75,AAPL=23.75,AMD=23.75 drift=2.5 interval=600';
const canonical = 'rebalance:v1 USDG=5,AAPL=23.75,AMD=23.75,MSFT=23.75,NVDA=23.75 drift=2.5 interval=600';
const targets = {USDG:500,AAPL:2375,AMD:2375,MSFT:2375,NVDA:2375};
const session = 'share-preview-fixture';
async function fixture(t: TestContext, count = 2) {
 const root = await mkdtemp(join(tmpdir(), 'rebalance-share-preview-'));
 t.after(() => rm(root,{recursive:true,force:true}));
 const profiles: RoutedProfile[] = Array.from({length:count},(_,i) => {
  const wallet = `0x${String(i+1).padStart(40,'0')}`, directory = `wallets/${wallet}`;
  return {wallet,chainId:4663,directory,dataDir:join(root,directory),rootDir:root,chartPort:4664+i};
 });
 await atomicWriteJson(join(root,'portfolios.json'),{version:1,profiles:profiles.map(({wallet,chainId,directory,chartPort})=>({wallet,chainId,directory,chartPort}))});
 for (const [i,p] of profiles.entries()) await atomicWriteJson(join(p.dataDir,'config.json'),{
  version:1,chainId:4663,wallet:p.wallet,mode:'ledger',rpcUrl:'https://fixture.invalid/private-service-path',
  targets:i===0?{USDG:2000,TSLA:2000,AAPL:2000,NVDA:2000,AMZN:2000}:targets,
  driftThresholdBps:500,slippageBps:50,deadlineSeconds:120,pollSeconds:30,rebalanceIntervalSeconds:3600,
 });
 let viewCalls=0;
 const deps: Partial<SharePreviewDependencies> = {view:async(r,s,w)=>{
  viewCalls++; assert.equal(r,root); assert.equal(s,session); assert.equal(w,undefined);
  return {state:'ready',url:`http://127.0.0.1:4664/#view=${'a'.repeat(64)}`,connected:true,tradingChanged:false};
 }};
 const connect=(index:number)=>atomicWriteJson(connectionPath(root,session),{version:1,chainId:4663,wallet:profiles[index]!.wallet});
 const snapshot=async()=>Promise.all(profiles.map(p=>readFile(join(p.dataDir,'config.json'),'utf8')));
 return {root,profiles,deps,connect,snapshot,get viewCalls(){return viewCalls;}};
}

test('pasted share code previews only the selected portfolio and never mutates configuration or execution state', async t => {
 const f=await fixture(t); await f.connect(0); const before=await f.snapshot();
 const markerFiles=['run.lock','stop.json','cycle.json','pending.json','runner-preference.json'];
 for(const file of markerFiles)await atomicWriteJson(join(f.profiles[0]!.dataDir,file),{fixture:file});
 const result=await previewSharedCode(f.root,session,code,undefined,f.deps);
 assert.equal(result.outcome,'preview'); if(result.outcome!=='preview')assert.fail();
 assert.equal(result.app,'Rebalance'); assert.equal(result.operation,'share-import'); assert.equal(result.applied,false); assert.equal(result.code,canonical);
 assert.deepEqual(result.shared,{targets,driftThresholdBps:250,rebalanceIntervalSeconds:600});
 assert.ok(result.targetChanges.some(change=>change.asset==='USDG'&&change.currentBps===2000&&change.sharedBps===500));
 assert.deepEqual(result.untrackedAssets,['TSLA','AMZN']);
 assert.deepEqual(result.settingChanges,[{setting:'driftThresholdBps',current:500,shared:250},{setting:'rebalanceIntervalSeconds',current:3600,shared:600}]);
 assert.deepEqual(await f.snapshot(),before); assert.equal(f.viewCalls,0);
 for(const file of markerFiles)assert.deepEqual(await readJson(join(f.profiles[0]!.dataDir,file)),{fixture:file});
 assert.doesNotMatch(JSON.stringify(result),/0x|private-service-path|ledger|rpcUrl|#view/);
});

test('no selected portfolio returns decoded strategy and a selector without pretending a comparison happened', async t => {
 for(const count of [0,2])await t.test(`${count} wallets`,async t=>{
  const f=await fixture(t,count); const before=await f.snapshot();
  const result=await previewSharedCode(f.root,session,code,undefined,{...f.deps,
   config:async()=>assert.fail('no configuration comparison without a selected portfolio'),
   resolve:async()=>assert.fail('no guess among portfolios'),
  });
  assert.equal(result.outcome,'select-portfolio'); assert.equal(result.applied,false); assert.equal(result.code,canonical);
  assert.deepEqual(result.shared,{targets,driftThresholdBps:250,rebalanceIntervalSeconds:600});
  for(const key of ['targetChanges','settingChanges','untrackedAssets'])assert.equal(key in result,false);
  assert.equal(f.viewCalls,1); assert.equal(await readJson(connectionPath(f.root,session)),null);
  assert.deepEqual(await f.snapshot(),before);
  assert.deepEqual((await readdir(f.root)).sort(),count?['portfolios.json','wallets']:['portfolios.json']);
 });
});

test('legacy omitted settings remain omitted in the canonical code and are not proposed as changes',async t=>{
 const f=await fixture(t,1);
 for(const suffix of ['', ' drift=0', ' interval=600']){
  const input=code.split(' drift=')[0]!+suffix;
  const result=await previewSharedCode(f.root,session,input,undefined,f.deps);
  assert.equal(result.outcome,'preview'); if(result.outcome!=='preview')assert.fail();
  assert.equal(result.code,canonical.split(' drift=')[0]!+suffix);
  assert.equal(result.shared.driftThresholdBps,suffix===' drift=0'?0:null);
  assert.equal(result.shared.rebalanceIntervalSeconds,suffix===' interval=600'?600:null);
  assert.equal(result.settingChanges.length,suffix?1:0);
 }
 assert.equal(f.viewCalls,0);
});

test('invalid input is rejected before routing, configuration reads, or view preparation and its contents stay private',async t=>{
 const f=await fixture(t);
 const fail=async()=>assert.fail('invalid input must fail before touching local state');
 const deps={profiles:fail,connection:fail,resolve:fail,config:fail,view:fail};
 for(const input of ['fixture-private-input',code+' wallet=fixture-secret',code+' --apply',code+' drift=3']){
  await assert.rejects(previewSharedCode(f.root,session,input,undefined,deps),error=>{
   assert.equal((error as Error).message,'Invalid strategy share code; no changes were made.'); return true;
  });
 }
});

test('selection is pinned before async config work even when the conversation changes wallets',async t=>{
 const f=await fixture(t);await f.connect(0);
 const result=await previewSharedCode(f.root,session,code,undefined,{...f.deps,
  resolve:async(root,options)=>{
   assert.deepEqual(options,{wallet:f.profiles[0]!.wallet});await f.connect(1);
   return resolveProfile(root,options);
  },
 });
 assert.equal(result.outcome,'preview');if(result.outcome!=='preview')assert.fail();
 assert.equal(result.targetChanges.find(change=>change.asset==='USDG')?.currentBps,2000);
 assert.equal((await readJson<{wallet:string}>(connectionPath(f.root,session)))!.wallet,f.profiles[1]!.wallet);
 assert.equal(f.viewCalls,0);
});

test('an explicit portfolio overrides attachment without changing it',async t=>{
 const f=await fixture(t);await f.connect(0);
 const result=await previewSharedCode(f.root,session,code,f.profiles[1]!.wallet!,f.deps);
 assert.equal(result.outcome,'preview');if(result.outcome!=='preview')assert.fail();assert.deepEqual(result.targetChanges,[]);
 assert.equal((await readJson<{wallet:string}>(connectionPath(f.root,session)))!.wallet,f.profiles[0]!.wallet);
});

test('bad routing and mismatched or malformed configurations fail with fixed safe messages',async t=>{
 const f=await fixture(t);await f.connect(0);
 const expected={message:'Share preview could not read the selected portfolio; no changes were made.'};
 await assert.rejects(previewSharedCode(f.root,session,code,undefined,{...f.deps,profiles:async()=>{throw new Error('fixture-private-provider-payload');}}),expected);
 await assert.rejects(previewSharedCode(f.root,session,code,undefined,{...f.deps,connection:async()=>({version:7,wallet:f.profiles[0]!.wallet})}),expected);
 await assert.rejects(previewSharedCode(f.root,session,code,`0x${'f'.repeat(40)}`,f.deps),expected);
 const original=JSON.parse((await f.snapshot())[0]!);
 for(const changed of [{...original,wallet:f.profiles[1]!.wallet},{...original,chainId:1},{...original,rpcUrl:'fixture-secret-url'}]){
  await assert.rejects(previewSharedCode(f.root,session,code,undefined,{...f.deps,config:async()=>changed}),expected);
 }
 assert.equal(f.viewCalls,0);
});

test('selector errors retain only the allowlisted view reason with no financial fallback',async t=>{
 const f=await fixture(t);
 for(const error of [new ViewError('local-access-denied'),new Error('fixture-private-view-failure')]){
  const result=await previewSharedCode(f.root,session,code,undefined,{...f.deps,view:async()=>{throw error;}});
  assert.equal(result.outcome,'select-portfolio');if(result.outcome!=='select-portfolio')assert.fail();
  assert.equal(result.view.state,'unavailable');
  assert.doesNotMatch(JSON.stringify(result),/fixture-private/);
  if(error instanceof ViewError)assert.deepEqual(result.view,{state:'unavailable',code:'local-access-denied',message:'This process cannot access the local chart listener.'});
 }
});

test('CLI preview stays read-only, preserves pinned identity, and rejects apply flags',async t=>{
 const f=await fixture(t);await f.connect(0);const before=await f.snapshot();
 const preload=join(f.root,'read-only-boundary.mjs');
 await writeFile(preload,`
  import {registerHooks,syncBuiltinESMExports} from 'node:module';
  import http from 'node:http'; import child from 'node:child_process';
  http.get=()=>{throw new Error('unexpected network access');};
  child.execFile=()=>{throw new Error('unexpected child dispatch');};
  syncBuiltinESMExports();
  registerHooks({load(url,context,nextLoad){
   if(['commands','runtime','chain','signers','launch','app-launch','graph'].some(name=>url.endsWith('/src/'+name+'.ts')))throw new Error('Unexpected execution module');
   return nextLoad(url,context);
  }});
 `);
 const env:NodeJS.ProcessEnv={...process.env,REBALANCE_ROOT_DIR:f.root,REBALANCE_DATA_DIR:f.root,NODE_OPTIONS:`--import=${preload}`};
 for(const name of ['REBALANCE_PROFILE_PINNED','REBALANCE_PROFILE_WALLET','REBALANCE_CHART_PORT','REBALANCE_SESSION_ID','CODEX_THREAD_ID','CLAUDE_CODE_SESSION_ID','REBALANCE_PRIVATE_KEY'])delete env[name];
 const command=(args:string[],extra:NodeJS.ProcessEnv={})=>execute(process.execPath,['--import','tsx',cli,...args],{cwd:repository,env:{...env,...extra},timeout:10_000});
 const args=['share','preview',code,'--session',session];
 const selected=JSON.parse((await command(args)).stdout);
 assert.equal(selected.outcome,'preview');assert.equal(selected.applied,false);assert.ok(selected.targetChanges.length>0);
 const pinned={REBALANCE_PROFILE_PINNED:'1',REBALANCE_PROFILE_WALLET:f.profiles[1]!.wallet!,REBALANCE_DATA_DIR:f.profiles[1]!.dataDir};
 assert.deepEqual(JSON.parse((await command(args,pinned)).stdout).targetChanges,[]);
 await assert.rejects(command([...args,'--profile',f.profiles[0]!.wallet!],pinned));
 await assert.rejects(command(args,{...pinned,REBALANCE_DATA_DIR:f.profiles[0]!.dataDir}));
 await assert.rejects(command(args,{...pinned,REBALANCE_PROFILE_WALLET:''}));
 await assert.rejects(command([...args,'--apply']));await assert.rejects(command([...args,'--settings']));
 assert.deepEqual(await f.snapshot(),before);
});
