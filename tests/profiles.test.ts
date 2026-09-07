import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { addPortfolio, connectPortfolio, portfolios } from '../src/profiles.js';
import { atomicWriteJson, readJson } from '../src/storage.js';
import { connectionPath, readProfiles, resolveProfile, sessionIdentity } from '../scripts/profile-routing.mjs';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const one = '0x0000000000000000000000000000000000000001';
const two = '0x0000000000000000000000000000000000000002';
const targets = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const config = (wallet = one, mode = 'private-key') => ({ version: 1, chainId: 4663, wallet, mode,
 rpcUrl: 'http://profile-fixture.invalid', targets, driftThresholdBps: 500, slippageBps: 50,
 deadlineSeconds: 120, pollSeconds: 5, rebalanceIntervalSeconds: 3600 });
async function fixture(t: TestContext) {
 const root = await mkdtemp(join(tmpdir(), 'rebalance-profiles-'));
 t.after(() => rm(root, {recursive:true,force:true,maxRetries:3}));
 await atomicWriteJson(join(root,'config.json'), config());
 const env: NodeJS.ProcessEnv = { ...process.env, REBALANCE_DATA_DIR: root };
 for (const name of ['REBALANCE_ROOT_DIR','REBALANCE_PROFILE_PINNED','REBALANCE_PROFILE_WALLET','REBALANCE_CHART_PORT','REBALANCE_SESSION_ID','CODEX_THREAD_ID','REBALANCE_PRIVATE_KEY']) delete env[name];
 const command = (args: string[], extra: NodeJS.ProcessEnv = {}) => run(process.execPath, ['--import','tsx',cli,...args], {cwd:repository,env:{...env,...extra},timeout:12000});
 return {root,command,env};
}
async function until(condition: () => Promise<boolean>, message: string) {
 const deadline = Date.now()+7000;
 while (Date.now()<deadline) {if(await condition())return; await delay(20);}
 assert.fail(message);
}

test('registration adopts legacy data in place and gives a different wallet independent targets and state', async t => {
 const {root} = await fixture(t);
 const legacy = {'pending.json':{hash:'fixture',nonce:9}, 'cycle.json':{startedAt:42}, 'recovery.json':{original:'fixture'},'stop.json':{stopped:true},'run.lock':{pid:process.pid}};
 for(const [file,value]of Object.entries(legacy)) await atomicWriteJson(join(root,file),value);
 const before = await Promise.all(Object.keys(legacy).map(file=>readFile(join(root,file),'utf8')));
 const split = {USDG:1000,AAPL:3000,NVDA:2000,MSFT:2000,AMD:2000};
 const profile = await addPortfolio(root,{...config(two,'privy'), targets:split});
 const listed = await readProfiles(root);
 assert.equal(listed.length,2); assert.equal(listed[0]!.dataDir,root); assert.equal(listed[0]!.chartPort,4663);
 assert.equal(profile.dataDir,join(root,'wallets',two)); assert.equal(profile.chartPort,4664);
 assert.deepEqual((await readJson<any>(join(profile.dataDir,'config.json'))).targets,split);
 for (const file of Object.keys(legacy)) assert.equal(await readJson(join(profile.dataDir,file)),null);
 assert.deepEqual(await Promise.all(Object.keys(legacy).map(file=>readFile(join(root,file),'utf8'))),before);
 assert.equal(await readJson(join(profile.dataDir,'private-key')),null);
 await assert.rejects(addPortfolio(root,config(one,'privy')),/already has/);
 await assert.rejects(addPortfolio(root,config(two,'ledger')),/already has/);
});

test('two chat attachments and explicit command scope never mutate either portfolio', async t=>{
 const {root,command}=await fixture(t); const profile=await addPortfolio(root,config(two,'privy'));
 const first=await readFile(join(root,'config.json'),'utf8'); const second=await readFile(join(profile.dataDir,'config.json'),'utf8');
 await connectPortfolio(root,'chat-a',one); await connectPortfolio(root,'chat-b',two);
 assert.equal((await resolveProfile(root,{sessionId:'chat-a'})).wallet,one);
 assert.equal((await resolveProfile(root,{sessionId:'chat-b'})).wallet,two);
 await connectPortfolio(root,'chat-a',two);
 assert.equal((await resolveProfile(root,{sessionId:'chat-a'})).wallet,two);
 assert.equal((await resolveProfile(root,{sessionId:'chat-b'})).wallet,two);
 assert.equal((await resolveProfile(root,{sessionId:'chat-a',wallet:one})).wallet,one);
 assert.equal(await readFile(join(root,'config.json'),'utf8'),first); assert.equal(await readFile(join(profile.dataDir,'config.json'),'utf8'),second);
 assert.equal(JSON.parse((await command(['status','--session','chat-a'])).stdout).wallet,two);
 assert.equal(JSON.parse((await command(['status','--session','chat-a','--profile',one])).stdout).wallet,one);
 await assert.rejects(command(['status']), error=>/Choose this conversation/.test((error as any).stderr));
 await assert.rejects(command(['configure','--profile',one,'--wallet',two]),error=>/belongs to one wallet/.test((error as any).stderr));
});

test('targets, stop markers, events and acknowledgements remain wallet scoped after chat switches', async t=>{
 const {root,command}=await fixture(t); const profile=await addPortfolio(root,config(two,'privy'));
 await connectPortfolio(root,'chat',one);
 await command(['targets','set','USDG','10','--session','chat']);
 await connectPortfolio(root,'chat',two);
 assert.equal((await readJson<any>(join(root,'config.json'))).targets.USDG,1000);
 assert.equal((await readJson<any>(join(profile.dataDir,'config.json'))).targets.USDG,500);
 await command(['stop','--session','chat']);
 assert.equal(await readJson(join(root,'stop.json')),null); assert.ok(await readJson(join(profile.dataDir,'stop.json')));
 const event={id:'same-id',type:'rebalance-attention',message:'fixture',createdAt:'2026-09-07T00:00:00Z'};
 for(const dir of [root,profile.dataDir])await atomicWriteJson(join(dir,'events.json'),[event]);
 await command(['events','ack','same-id','--profile',one,'--session','chat']);
 assert.equal((JSON.parse((await command(['events','--profile',one])).stdout)).length,0);
 assert.equal((JSON.parse((await command(['events','--profile',two])).stdout)).length,1);
});

test('pinned worker selection ignores later chat changes and rejects explicit retargeting',async t=>{
 const {root,command}=await fixture(t); await addPortfolio(root,config(two,'privy'));
 await connectPortfolio(root,'chat',two);
 const pinned={REBALANCE_ROOT_DIR:root,REBALANCE_PROFILE_PINNED:'1',REBALANCE_PROFILE_WALLET:one,REBALANCE_SESSION_ID:'chat'};
 assert.equal(JSON.parse((await command(['status'],pinned)).stdout).wallet,one);
 await assert.rejects(command(['status','--profile',two],pinned),error=>/pinned wallet worker/.test((error as any).stderr));
 await atomicWriteJson(join(root,'config.json'),config(two));
 await assert.rejects(command(['status'],pinned),error=>/pinned portfolio/.test((error as any).stderr));
});

test('registry corruption, unknown connections, duplicate identities and symlinked data cannot redirect a wallet',async t=>{
 const {root}=await fixture(t);
 await assert.rejects(resolveProfile(root,{wallet:two}),/no portfolio/);
 await atomicWriteJson(connectionPath(root,'chat'),{version:1,chainId:4663,wallet:two});
 await assert.rejects(resolveProfile(root,{sessionId:'chat'}),/no portfolio/);
 await mkdir(join(root,'wallets'));
 const other=await mkdtemp(join(tmpdir(),'rebalance-profile-outside-'));t.after(()=>rm(other,{recursive:true,force:true}));
 await symlink(other,join(root,'wallets',two));
 await assert.rejects(addPortfolio(root,config(two,'privy')),/real local directory/);
 await rm(join(root,'wallets',two));
 await atomicWriteJson(join(root,'portfolios.json'),{version:1,profiles:[{wallet:one,chainId:4663,directory:'../outside',chartPort:4663}]});
 await assert.rejects(readProfiles(root),/Invalid or duplicate/);
 assert.equal(sessionIdentity(undefined,{}),undefined);
 assert.equal(sessionIdentity('claude:fixture',{}),'claude:fixture');
});

test('two deterministic background workers retain independent locks and stopping one leaves the other running', {timeout:20000}, async t=>{
 const {root,command}=await fixture(t); const profile=await addPortfolio(root,config(two,'privy'));
 const preload=join(root,'offline.mjs');
 await writeFile(preload,`globalThis.fetch=async()=>{throw new Error('Isolated fixture transport unavailable');};`);
 const extra={NODE_OPTIONS:`--import=${preload}`};
 const pids:number[]=[];
 t.after(async()=>{for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{} await delay(100);});
 for(const wallet of [one,two]) {
  const result=JSON.parse((await command(['start','--background','--profile',wallet],extra)).stdout);pids.push(result.pid);
 }
 await until(async()=>{
  const entries=await portfolios(root);return entries.length===2&&entries.every(entry=>entry.running);
 },'both isolated runners must be alive');
 await connectPortfolio(root,'chat',two);
 await command(['stop','--profile',one]);
 await until(async()=>!(await readJson(join(root,'run.lock'))),'first runner must stop');
 assert.ok(await readJson(join(profile.dataDir,'run.lock')));
 assert.equal(await readJson(join(profile.dataDir,'stop.json')),null);
 process.kill(pids[1]!,0);
 for(const dir of [root,profile.dataDir]) {
  assert.equal(await readJson(join(dir,'pending.json')),null);
  assert.equal(await readJson(join(dir,'private-key')),null);
 }
 await command(['stop','--profile',two]);
 await until(async()=>!(await readJson(join(profile.dataDir,'run.lock'))),'second runner must stop separately');
});


test('a broken wallet does not block status, stop or notification commands for another wallet', async t => {
 const {root,command}=await fixture(t); const profile=await addPortfolio(root,config(two,'privy'));
 await writeFile(join(profile.dataDir,'config.json'),'corrupt');
 assert.equal(JSON.parse((await command(['status','--profile',one])).stdout).wallet,one);
 const listed=JSON.parse((await command(['wallet','list'])).stdout).portfolios;
 assert.equal(listed[0].wallet,one); assert.ok(listed[1].error);
 await command(['stop','--profile',one]); assert.ok(await readJson(join(root,'stop.json')));
 await command(['stop','--profile',two]); assert.ok(await readJson(join(profile.dataDir,'stop.json')));
 const event={id:'source-id',type:'rebalance-attention',message:'fixture',createdAt:'2026-09-07T00:00:00Z'};
 await atomicWriteJson(join(root,'events.json'),[event]);
 await command(['events','ack','source-id','--profile',one]);
 assert.equal(JSON.parse((await command(['events','--profile',one])).stdout).length,0);
});

test('wallet creation never puts a fresh unrelated key into an existing Privy portfolio',async t=>{
 const {root,command}=await fixture(t); const profile=await addPortfolio(root,config(two,'privy'));
 await assert.rejects(command(['wallet','create','--profile',two]),error=>/already has a wallet/.test((error as any).stderr));
 assert.equal(await readJson(join(profile.dataDir,'private-key')),null);
});


test('a missing registered config cannot be replaced with another wallet or a fresh raw key',async t=>{
 const {root,command}=await fixture(t);const profile=await addPortfolio(root,config(two,'privy'));
 await rm(join(profile.dataDir,'config.json'));
 await assert.rejects(command(['configure','--profile',two,'--wallet',one,'--mode','private-key','--targets','USDG=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75']),error=>/pinned portfolio/.test((error as any).stderr));
 await assert.rejects(command(['wallet','create','--profile',two]),error=>/already has a wallet/.test((error as any).stderr));
 for(const file of ['config.json','private-key','wallet.json']) assert.equal(await readJson(join(profile.dataDir,file)),null);
});

test('launch all setup-only retains prior results and continues after a wallet child fails', async t => {
 const {root,command}=await fixture(t);
 const three='0x0000000000000000000000000000000000000003';
 const second=await addPortfolio(root,config(two,'privy'));
 const third=await addPortfolio(root,config(three,'ledger'));
 const profiles=[{wallet:one,dataDir:root,chartPort:4663},second,third];
 for(const profile of profiles)await atomicWriteJson(join(profile.dataDir,'stop.json'),{wallet:profile.wallet,stopped:true});
 const before=await Promise.all(profiles.map(profile=>readFile(join(profile.dataDir,'stop.json'),'utf8')));
 const preload=join(root,'setup-only-children.mjs');
 // Exercise the real CLI fan-out and child-result parser. Fixture children exit
 // before application imports, so no RPC, signer, chart or runner can start.
 await writeFile(preload,`
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
globalThis.fetch=async()=>{throw new Error('No fixture network allowed');};
if(process.env.REBALANCE_PROFILE_PINNED==='1') {
  assert.deepEqual(process.argv.slice(2),['launch','--setup-only']);
  const wallet=process.env.REBALANCE_PROFILE_WALLET;
  writeFileSync(resolve(process.env.REBALANCE_DATA_DIR,'setup-fixture-attempt.json'),JSON.stringify({wallet,args:process.argv.slice(2)}));
  const failed=wallet==='${two}';
  const output=failed?'fixture child returned malformed output':JSON.stringify({app:'Rebalance',requested:'setup-only',outcome:'ready',status:{wallet,armed:false},chart:{state:'ready',url:'http://127.0.0.1:'+process.env.REBALANCE_CHART_PORT}});
  await new Promise(done=>process.stdout.write(output,done));
  process.exit(failed?1:0);
}
`);
 const result=JSON.parse((await command(['launch','--all','--setup-only'],{NODE_OPTIONS:`--import=${preload}`})).stdout);
 assert.equal(result.app,'Rebalance');
 assert.deepEqual(result.portfolios.map((entry:{wallet:string})=>entry.wallet),[one,two,three]);
 assert.deepEqual(result.portfolios.map((entry:{result:{outcome:string}})=>entry.result.outcome),['ready','unknown','ready']);
 assert.equal(result.portfolios[0].result.status.wallet,one);
 assert.equal(result.portfolios[2].result.status.wallet,three);
 assert.equal(result.portfolios[0].result.chart.url,'http://127.0.0.1:4663');
 assert.equal(result.portfolios[2].result.chart.url,'http://127.0.0.1:4665');
 assert.equal(result.portfolios[1].result.status,null);
 assert.match(result.portfolios[1].result.message,/Inspect its status before retrying/);
 for(const profile of profiles) {
  assert.deepEqual(await readJson(join(profile.dataDir,'setup-fixture-attempt.json')),{wallet:profile.wallet,args:['launch','--setup-only']});
  for(const file of ['run.lock','chart.lock','pending.json','private-key'])assert.equal(await readJson(join(profile.dataDir,file)),null);
 }
 assert.deepEqual(await Promise.all(profiles.map(profile=>readFile(join(profile.dataDir,'stop.json'),'utf8'))),before);
});
