import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
const { handlePrompt, selectShareImportRequest, sharedCodeFromPrompt, runShareReceive } = await import(new URL('../scripts/rebalance-hook.mjs', import.meta.url).href);
const code = 'rebalance:v1 USDG=5,AAPL=23.75,AMD=23.75,MSFT=23.75,NVDA=23.75 drift=5 interval=3600';
const result = {app:'Rebalance',operation:'share-import',outcome:'applied',applied:true,code,
  shared:{targets:{USDG:500,AAPL:2375,AMD:2375,MSFT:2375,NVDA:2375},driftThresholdBps:500,rebalanceIntervalSeconds:3600},
  targetChanges:[],settingChanges:[],untrackedAssets:[]};
const ambient = (text:string) => ['<in-app-browser-context source="ambient-ui-state">',
  "This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.",
  '# In app browser:', '- The user has the in-app browser open with 2 tabs.', '- Current URL: https://example.com/unrelated',
  '</in-app-browser-context>', '', '## My request:', text].join('\n');
const publicResult = (reply:any) => JSON.parse(reply.hookSpecificOutput.additionalContext.split('\n').slice(1).join('\n'));
async function fixture(t:TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'rebalance-share-hook-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const input = {hook_event_name:'UserPromptSubmit',permission_mode:'default',session_id:'share-fixture',turn_id:'share-turn',cwd:root,prompt:code};
  const forbidden = () => assert.fail('pasted strategy must never enter financial startup, recovery or bootstrap');
  return {root,input,overrides:{repository:root,runLaunch:forbidden,runRestore:forbidden,runRecovery:forbidden,
    ensureDependencies:forbidden,captureAppEntryInputs:forbidden,readStopToken:forbidden}};
}

test('only whole native pasted strategies dispatch, retaining the native identity through ambient wrapping', async t => {
  const f=await fixture(t);
  for (const prompt of [code,ambient(code),'  '+code+'  ']) {
    const selected=selectShareImportRequest({...f.input,prompt},f.root);
    assert.equal(selected.code,code);assert.equal(selected.sessionId,f.input.session_id);
    assert.equal(selected.requestId,selectShareImportRequest(f.input,f.root).requestId);
    let calls=0;
    const reply=await handlePrompt({...f.input,prompt},{...f.overrides,runShareReceive:async(root:string,request:any)=>{
      calls++;assert.equal(root,f.root);assert.equal(request.code,code);assert.equal(request.sessionId,f.input.session_id);return result;
    }});
    assert.deepEqual(publicResult(reply),result);assert.equal(calls,1);
    assert.match(reply.hookSpecificOutput.additionalContext,/without asking to choose or apply again/);
  }
  assert.deepEqual(await readdir(f.root),[]);
});

test('quoted examples, commands, notifications and foreign events do not import; missing identity and Plan block', async t => {
  const f=await fixture(t);const forbidden=()=>assert.fail('not a native pasted-strategy request');
  for(const prompt of ['`'+code+'`','```\n'+code+'\n```','> '+code,'Example: '+code,'Please import '+code,'$rebalance share',
    'Rebalance notification-only task. '+code,ambient('Example: '+code)]) {
    assert.equal(sharedCodeFromPrompt(prompt,f.root),null);
    assert.equal(await handlePrompt({...f.input,prompt},{...f.overrides,runShareReceive:forbidden}),null);
  }
  assert.equal(await handlePrompt({...f.input,hook_event_name:'PostToolUse'},{...f.overrides,runShareReceive:forbidden}),null);
  for(const extra of [{permission_mode:'plan'},{session_id:''},{turn_id:''},{cwd:'relative'}]) {
    assert.equal(publicResult(await handlePrompt({...f.input,...extra},{...f.overrides,runShareReceive:forbidden})).outcome,'blocked');
  }
});

test('missing selection presents only the returned selector and failed preview exposes no input or subprocess payload', async t => {
  const f=await fixture(t);let opens=0;
  const view={state:'ready',url:'http://127.0.0.1:4663/#view='+'a'.repeat(64),connected:true};
  const unselected={app:'Rebalance',operation:'share-import',outcome:'select-portfolio',code,shared:result.shared,applied:false,view};
  const reply=await handlePrompt(f.input,{...f.overrides,runShareReceive:async()=>unselected,openView:async(request:any)=>{
    assert.equal(request.url,view.url);assert.equal(request.sessionId,f.input.session_id);opens++;return{opened:true,host:'fixture'};
  }});
  assert.equal(opens,1);const displayed=publicResult(reply);assert.equal(displayed.outcome,'select-portfolio');
  assert.equal('targetChanges' in displayed,false);assert.equal(displayed.applied,false);
  const failed=publicResult(await handlePrompt({...f.input,prompt:code+' fixture-private-payload'},{...f.overrides,
    runShareReceive:async()=>{throw new Error('fixture-private-payload');},openView:()=>assert.fail('no view after failed parsing'),
  }));
  assert.equal(failed.outcome,'unknown');assert.equal(failed.applied,null);assert.doesNotMatch(JSON.stringify(failed),/fixture-private/);
  assert.deepEqual(await readdir(f.root),[]);
});

test('native import calls a fixed CLI with stable request identity with code as one argument and overrides inherited worker scope', async t => {
  const f=await fixture(t);const previous=process.env.REBALANCE_PROFILE_PINNED;process.env.REBALANCE_PROFILE_PINNED='1';
  t.after(()=>{if(previous===undefined)delete process.env.REBALANCE_PROFILE_PINNED;else process.env.REBALANCE_PROFILE_PINNED=previous;});
  const raw=code+' --apply; echo fixture';
  const value=await runShareReceive(f.root,{sessionId:f.input.session_id,code:raw,requestId:'a'.repeat(64)},async(binary:string,args:string[],options:any)=>{
    assert.equal(binary,process.execPath);
    assert.deepEqual(args,['--import','tsx',join(f.root,'src/cli.ts'),'share','receive',raw,'--session',f.input.session_id,'--request-id','a'.repeat(64)]);
    assert.equal(options.env.REBALANCE_SESSION_ID,f.input.session_id);assert.equal(options.env.REBALANCE_PROFILE_PINNED,undefined);
    assert.equal(options.shell,undefined);return{stdout:JSON.stringify(result)};
  });
  assert.deepEqual(value,result);
  for(const stdout of ['not json',JSON.stringify({...result,applied:false}),JSON.stringify({app:'Rebalance',outcome:'armed'})]) {
    await assert.rejects(runShareReceive(f.root,{sessionId:f.input.session_id,code},async()=>({stdout})));
  }
});
