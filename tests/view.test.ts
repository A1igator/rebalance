import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { atomicWriteJson, readJson } from '../src/storage.js';
import { ensurePortfolioChart, prepareView, type ViewDependencies } from '../src/view.js';
import { portfolios } from '../src/profiles.js';
import { connectionPath, type RoutedProfile } from '../scripts/profile-routing.mjs';
const wallet = '0x0000000000000000000000000000000000000001';
const config = { version:1, chainId:4663, wallet, mode:'private-key', targets:{USDG:500,AAPL:2375,NVDA:2375,MSFT:2375,AMD:2375},
 rpcUrl:'http://fixture.invalid', driftThresholdBps:500,slippageBps:50,deadlineSeconds:120,pollSeconds:30,rebalanceIntervalSeconds:3600 };
async function fixture(t: TestContext) {
 const root=await mkdtemp(join(tmpdir(),'rebalance-view-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const profile:RoutedProfile={rootDir:root,dataDir:root,directory:'.',wallet:null,chainId:4663,chartPort:4663};
 let started=0, ready=false;
 const deps:ViewDependencies={probe:async()=>ready?'ready':'absent',alive:()=>true,pause:async()=>{},
  spawnChart:async p=>{started++;assert.equal(p.dataDir,root);await atomicWriteJson(join(root,'chart.lock'),{pid:123});ready=true;}};
 return {root,profile,deps,get started(){return started;},setReady(){ready=true;}};
}
test('empty registry view boots only a chart and links the exact conversation without creating a wallet',async t=>{
 const f=await fixture(t);const first=await prepareView(f.root,'fixture-chat',undefined,f.deps);
 assert.equal(f.started,1);assert.equal(first.tradingChanged,false);assert.match(first.url,/^http:\/\/127\.0\.0\.1:4663\/#view=[a-f0-9]{64}$/);
 assert.equal(await readJson(connectionPath(f.root,'fixture-chat')),null);
 const second=await prepareView(f.root,'another-chat',undefined,f.deps);assert.notEqual(second.url,first.url);assert.equal(f.started,1);
 for(const file of ['wallet.json','private-key','config.json','run.lock','stop.json','cycle.json','pending.json']) assert.equal(await readJson(join(f.root,file)),null);
 assert.equal((await readdir(join(f.root,'views'))).length,2);
});
test('opening the grid preserves an existing portfolio and all execution markers',async t=>{
 const f=await fixture(t);await atomicWriteJson(join(f.root,'config.json'),config);
 const markers=['run.lock','stop.json','cycle.json','pending.json','recovery.json'];
 for(const file of markers)await atomicWriteJson(join(f.root,file),{fixture:file});
 const before=await Promise.all(markers.map(file=>readFile(join(f.root,file),'utf8')));
 const result=await prepareView(f.root,'fixture-chat',wallet,f.deps);
 assert.match(result.url,/4663\/chart#view=/);assert.equal(f.started,1);
 assert.deepEqual(await Promise.all(markers.map(file=>readFile(join(f.root,file),'utf8'))),before);
 assert.deepEqual(await readJson(join(f.root,'config.json')),config);
});
test('a ready foreign listener or unavailable port is never replaced or trusted',async t=>{
 const f=await fixture(t);f.setReady();await assert.rejects(ensurePortfolioChart(f.profile,f.deps),/not owned/);assert.equal(f.started,0);
 await assert.rejects(ensurePortfolioChart(f.profile,{...f.deps,probe:async()=> 'unavailable'}),/unavailable/);assert.equal(f.started,0);
});
test('an existing starting chart is never duplicated and startup timeout leaves ownership intact',async t=>{
 const f=await fixture(t);await atomicWriteJson(join(f.root,'chart.lock'),{pid:123});
 await assert.rejects(ensurePortfolioChart(f.profile,f.deps),/not yet verified/);assert.equal(f.started,0);
 assert.deepEqual(await readJson(join(f.root,'chart.lock')),{pid:123});
});
test('an uncertain chart spawn is not retried in the same attempt',async t=>{
 const f=await fixture(t);let calls=0;
 await assert.rejects(ensurePortfolioChart(f.profile,{...f.deps,spawnChart:async()=>{calls++;throw new Error('fixture lost spawn result');}}));assert.equal(calls,1);
});
test('malformed per-wallet execution metadata produces an unavailable card instead of hiding all portfolios',async t=>{
 const f=await fixture(t);await atomicWriteJson(join(f.root,'config.json'),config);
 await atomicWriteJson(join(f.root,'run.lock'),{pid:-1});
 assert.match((await portfolios(f.root))[0]!.error!,/unavailable/);
 await rm(join(f.root,'run.lock'));await atomicWriteJson(join(f.root,'stop.json'),false);
 assert.equal((await portfolios(f.root))[0]!.allocationObjective,'manual');
});
