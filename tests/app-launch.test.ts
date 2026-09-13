import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { restoreApp, type AppLaunchDependencies } from '../src/app-launch.js';
import { atomicWriteJson, readJson } from '../src/storage.js';
import { captureRunnerPreference, withRunnerControl, writeRunnerPreference } from '../src/runner-preference.js';
import { connectionPath, type RoutedProfile } from '../scripts/profile-routing.mjs';

async function fixture(t: TestContext) {
 const root=await mkdtemp(join(tmpdir(),'rebalance-app-entry-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const profiles:RoutedProfile[]=Array.from({length:3},(_,i)=>{
  const wallet=`0x${String(i+1).padStart(40,'0')}`; const directory=`wallets/${wallet}`;
  return {wallet,chainId:4663,directory,rootDir:root,dataDir:join(root,directory),chartPort:4664+i};
 });
 await atomicWriteJson(join(root,'portfolios.json'),{version:1,profiles:profiles.map(({wallet,chainId,directory,chartPort})=>({wallet,chainId,directory,chartPort}))});
 for(const p of profiles)await atomicWriteJson(join(p.dataDir,'config.json'),{version:1,chainId:4663,wallet:p.wallet,mode:'ledger',rpcUrl:'http://fixture.invalid',
  targets:{USDG:500,AAPL:2375,NVDA:2375,MSFT:2375,AMD:2375},driftThresholdBps:500,slippageBps:50,deadlineSeconds:120,pollSeconds:30,rebalanceIntervalSeconds:3600});
 const visits:string[]=[]; const id='fixture-entry';
 const deps:Partial<AppLaunchDependencies>={
  capture:(data,wallet,options)=>captureRunnerPreference(data,wallet,{...options,alive:()=>false}),
  view:async()=>({state:'ready',url:'http://127.0.0.1:4666/#view=fixture-only',connected:true,tradingChanged:false}),
  launch:async(p,request,generation,stop)=>{
   visits.push(p.wallet!);assert.match(request,/^restore:[a-f0-9]{64}$/);assert.equal(stop,'none');
   assert.equal((await readJson<{generation:string}>(join(p.dataDir,'runner-preference.json')))!.generation,generation);
   return {app:'Rebalance',outcome:'armed',status:{armed:true,wallet:p.wallet,chain:{id:4663},error:null}};
  },
 };
 const remember=(index:number,enabled:boolean)=>withRunnerControl(profiles[index]!.dataDir,
  ()=>writeRunnerPreference(profiles[index]!.dataDir,profiles[index]!.wallet!,enabled));
 return{root,profiles,deps,visits,id,remember,journal:join(root,'app-launch-requests',createHash('sha256').update(id).digest('hex')+'.json')};
}

test('app entry restores only remembered running portfolios and selection is independent',async t=>{
 const f=await fixture(t);await f.remember(0,true);await f.remember(1,false);
 await atomicWriteJson(connectionPath(f.root,'chat'),{version:1,chainId:4663,wallet:f.profiles[1]!.wallet});
 for(const file of ['pending.json','cycle.json','recovery.json'])await atomicWriteJson(join(f.profiles[0]!.dataDir,file),{fixture:file});
 const result=await restoreApp(f.root,'chat',{requestId:f.id},f.deps);
 assert.equal(result.outcome,'ready');assert.deepEqual(f.visits,[f.profiles[0]!.wallet]);
 assert.equal((await readJson<{wallet:string}>(connectionPath(f.root,'chat')))!.wallet,f.profiles[1]!.wallet);
 assert.deepEqual(result.portfolios.map(p=>p.result.outcome),['armed','not-requested','not-requested']);
 for(const file of ['pending.json','cycle.json','recovery.json'])assert.deepEqual(await readJson(join(f.profiles[0]!.dataDir,file)),{fixture:file});
});

test('empty entry opens selector without wallet creation or launching',async t=>{
 const f=await fixture(t);await atomicWriteJson(join(f.root,'portfolios.json'),{version:1,profiles:[]});
 const result=await restoreApp(f.root,'chat',{requestId:f.id},f.deps);
 assert.equal(result.outcome,'ready');assert.equal(result.view.state,'ready');assert.deepEqual(f.visits,[]);
 assert.equal(await readJson(join(f.root,'wallet.json')),null);
});

test('setup-only opens selector without reading or adopting running preferences',async t=>{
 const f=await fixture(t);await f.remember(0,true);
 const result=await restoreApp(f.root,'chat',{setupOnly:true,requestId:f.id},{...f.deps,capture:async()=>assert.fail('must not adopt or restore')});
 assert.equal(result.outcome,'select-portfolio');assert.deepEqual(f.visits,[]);assert.equal(await readJson(f.journal),null);
});

test('replay never expands its frozen set or restarts after a later Stop',async t=>{
 const f=await fixture(t);await f.remember(0,true);
 await restoreApp(f.root,'chat',{requestId:f.id},f.deps);const saved=await readFile(f.journal,'utf8');
 await f.remember(1,true);await f.remember(0,false);
 await atomicWriteJson(join(f.profiles[0]!.dataDir,'stop.json'),{requestId:'newer-stop'});
 const replay=await restoreApp(f.root,'chat',{requestId:f.id},f.deps);
 assert.equal(replay.outcome,'already-handled');assert.deepEqual(f.visits,[f.profiles[0]!.wallet]);assert.equal(await readFile(f.journal,'utf8'),saved);
 await restoreApp(f.root,'chat',{requestId:'new-entry'},f.deps);
 assert.deepEqual(f.visits,[f.profiles[0]!.wallet,f.profiles[1]!.wallet]);
});

test('Stop and changed preference between snapshot and launch both prevent restoration',async t=>{
 const f=await fixture(t);await f.remember(0,true);await f.remember(1,true);
 const result=await restoreApp(f.root,'chat',{requestId:f.id},{...f.deps,view:async(...args)=>{
  assert.ok(await readJson(f.journal),'journal must precede the view');
  await atomicWriteJson(join(f.profiles[0]!.dataDir,'stop.json'),{requestId:'newer-stop'});
  await f.remember(1,false);await f.remember(1,true);
  return f.deps.view!(...args);
 }});
 assert.equal(result.outcome,'ready');assert.deepEqual(f.visits,[]);
});

test('independent startups overlap and a failure does not stop another portfolio',async t=>{
 const f=await fixture(t);await f.remember(0,true);await f.remember(1,true);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
 const result=await restoreApp(f.root,'chat',{requestId:f.id},{...f.deps,launch:async(p,...args)=>{
  if(p.wallet===f.profiles[0]!.wallet){await gate;throw new Error('fixture-provider-secret');}
  release();return f.deps.launch!(p,...args);
 }});
 assert.equal(result.outcome,'starting');assert.equal(result.portfolios[0]!.result.outcome,'unknown');
 assert.equal(result.portfolios[1]!.result.status?.armed,true);assert.doesNotMatch(JSON.stringify(result),/fixture-provider-secret/);
});

test('unavailable selector does not duplicate or block eligible background startup',async t=>{
 const f=await fixture(t);await f.remember(0,true);
 const result=await restoreApp(f.root,'chat',{requestId:f.id},{...f.deps,view:async()=>{throw new Error('fixture-view');}});
 assert.equal(result.outcome,'partial');assert.equal(result.view.state,'unavailable');assert.equal(f.visits.length,1);
});

test('malformed preference stays stopped and does not hide healthy portfolios',async t=>{
 const f=await fixture(t);await f.remember(0,true);
 await atomicWriteJson(join(f.profiles[1]!.dataDir,'runner-preference.json'),{enabled:true,generation:randomUUID()});
 const result=await restoreApp(f.root,'chat',{requestId:f.id},f.deps);
 assert.equal(result.outcome,'partial');assert.deepEqual(f.visits,[f.profiles[0]!.wallet]);assert.equal(result.portfolios[1]!.result.outcome,'blocked');
});

test('a request cannot be replayed under another conversation identity',async t=>{
 const f=await fixture(t);await restoreApp(f.root,'chat',{requestId:f.id},f.deps);
 await assert.rejects(restoreApp(f.root,'other-chat',{requestId:f.id},f.deps),/Invalid app entry record/);
});


test('contradictory armed output stays unknown instead of claiming readiness', async t => {
 const f=await fixture(t);await f.remember(0,true);
 const result=await restoreApp(f.root,'chat',{requestId:f.id},{...f.deps,launch:async p=>({
  app:'Rebalance',outcome:'armed',status:{armed:false,wallet:p.wallet,chain:{id:4663}}
 })});
 assert.equal(result.outcome,'starting');assert.equal(result.portfolios[0]!.result.outcome,'unknown');
});

test('a null app receipt is corruption rather than fresh startup authority', async t => {
 const f=await fixture(t);await f.remember(0,true);await atomicWriteJson(f.journal,null);
 await assert.rejects(restoreApp(f.root,'chat',{requestId:f.id},f.deps),/Invalid app entry record/);
 assert.deepEqual(f.visits,[]);assert.equal(await readFile(f.journal,'utf8'),'null\n');
});
