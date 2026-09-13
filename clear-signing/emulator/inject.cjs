// Development-only synthetic Speculos review. Never import the application.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { execFileSync } = require('node:child_process');
const { values: options } = parseArgs({ options: { 'work-dir': { type: 'string' }, 'container-id': { type: 'string' }, 'speculos-url': { type: 'string' }, fixture: { type: 'string', default: 'approval' }, 'manual-review': { type: 'boolean', default: false }, 'matching-context': { type: 'boolean', default: false } } });
const tempRoot = fs.realpathSync('/tmp');
if (!options['work-dir'] || !path.isAbsolute(options['work-dir'])) throw new Error('Explicit absolute /tmp work directory is required');
const work = fs.realpathSync(options['work-dir']);
if (work === tempRoot || path.relative(tempRoot, work).startsWith('..')) throw new Error('Use an explicit isolated directory inside /tmp');
const containerId = options['container-id'];
if (!/^[0-9a-f]{64}$/.test(containerId || '')) throw new Error('Exact owned Speculos container ID is required');
const emulatorUrl = options['speculos-url'];
const emulator = new URL(emulatorUrl);
if (emulator.protocol !== 'http:' || emulator.hostname !== '127.0.0.1' || !emulator.port || emulator.pathname !== '/' || emulator.search || emulator.hash || emulator.username || emulator.password) throw new Error('Use an explicit loopback Speculos API URL');
const inspected = JSON.parse(execFileSync('docker', ['inspect', containerId], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024*1024 }))[0];
const mappings = Object.entries(inspected.NetworkSettings?.Ports || {}).flatMap(([port, bindings]) => (bindings || []).map(binding=>({port,...binding})));
if (inspected.HostConfig?.Privileged || inspected.HostConfig?.CapAdd?.length || inspected.HostConfig?.DeviceRequests?.length || ['host'].includes(inspected.HostConfig?.NetworkMode) || mappings.length !== 1 || mappings[0].port !== '5000/tcp' || mappings[0].HostIp !== '127.0.0.1' || mappings[0].HostPort !== emulator.port || inspected.Config?.Image !== 'ghcr.io/ledgerhq/speculos@sha256:6ed9eefd51cddd862b746719af4cd7a3265fe43d0588c388359753cab8d46d11' || !inspected.Config?.Cmd?.includes('nanox') || inspected.Config?.Labels?.['rebalance.emulator'] !== 'public-test-only' || inspected.HostConfig?.Devices?.length || inspected.Mounts?.length || !inspected.NetworkSettings?.Ports?.['5000/tcp']?.some(p => p.HostIp === '127.0.0.1' && p.HostPort === emulator.port)) throw new Error('Container must be an owned emulator with no mounts/devices and a loopback-only API');
const expectedCommand = ['--display', 'headless', '--api-port', '5000', '--model', 'nanox', '/speculos/rebalance-app.elf'];
if (JSON.stringify(inspected.Config?.Cmd) !== JSON.stringify(expectedCommand) || (inspected.Config?.Env || []).some(entry => /seed|mnemonic|private.?key/i.test(entry.split('=')[0]))) throw new Error('Only the pinned public-default-seed emulator command is supported');
const fixtureCases = { approval:'approval',swap:'swap',router:'router',batch:'batch',
  'router-missing-call':'router','router-extra-call':'router','batch-missing-call':'batch','batch-extra-call':'batch' };
if (!Object.hasOwn(fixtureCases,options.fixture)) throw new Error('Unknown synthetic fixture');
const fixtureName=fixtureCases[options.fixture];
if (options.fixture !== fixtureName && (!options['matching-context'] || options['manual-review'])) throw new Error('Fixed negative cases require matching context and automatic test mode');
const http = require('node:http');
const { createRequire } = require('node:module');
const req = createRequire(path.join(work, 'package.json'));
const { DeviceManagementKitBuilder, DeviceModelId } = req('@ledgerhq/device-management-kit');
const { SignerEthBuilder } = req('@ledgerhq/device-signer-kit-ethereum');
const { ContextModuleBuilder, ContextModuleChainID } = req('@ledgerhq/context-module');
const { speculosTransportFactory, speculosIdentifier } = req('@ledgerhq/device-transport-kit-speculos');
const { firstValueFrom, timeout } = req('rxjs');
const { assertScreens } = require('./assert-screens.cjs');
const { assertExpectedRefusal } = require('./assert-refusal.cjs');
const { serializeTransaction, hexToBytes } = createRequire(path.join(__dirname, '../../package.json'))('viem');
const contextFile=options['matching-context'] ? 'matching-test-context.json' : 'compiled-test-context.json';
const contextPath=path.join(work,contextFile);
if (!fs.lstatSync(contextPath).isFile()) throw new Error('Context must be a regular file in the isolated work directory');
const contextData = JSON.parse(fs.readFileSync(contextPath));
if (options['matching-context']) {
  const marker=contextData.matchingContext;
  if (marker?.version!==1 || marker.routerCallCount!==4 || marker.accountCallCount!==5 || marker.guardType!=='abi-array-length-must-be-v1') throw new Error('Matching context must declare the supported fixed-count guard profile');
}
const out = fs.mkdtempSync(path.join(work, 'injection-result-'));
const originalFetch = globalThis.fetch;
let metadataUrl;
let refuseFurtherSigning = false;
let signerAddress;
const runAbort = new AbortController();
const reviewTimeout = options['manual-review'] ? 600000 : 240000;
const requests = [];
const server = http.createServer((request, response) => {
  const url = new URL(request.url, metadataUrl);
  requests.push({ path:url.pathname, output:url.searchParams.get('output') });
  let data = [];
  const address = (url.searchParams.get('contract_address') || url.searchParams.get('contracts') || '').toLowerCase();
  if (url.pathname === '/cal/v1/dapps' || (url.pathname === '/cal/v1/tokens' && url.searchParams.get('output') === 'descriptors_calldata')) {
    const key=`${url.searchParams.get('chain_id')}:${address}`;
    data = contextData.descriptors[key] || [];
    console.log(JSON.stringify({descriptorKey:key,found:data.length>0}));
  } else if (url.pathname === '/cal/v1/certificates') {
    const key = ['target_device','public_key_id','public_key_usage'].map(k => url.searchParams.get(k)?.toLowerCase()).join(':');
    data = contextData.certificates[key] || [];
    console.log(JSON.stringify({certificateKey:key,found:data.length>0}));
  } else if (url.pathname === '/cal/v1/networks') data = contextData.networks?.[url.searchParams.get('chain_id')] || [];
  else if (url.pathname === '/cal/v1/tokens') data = contextData.tokens[address] || [];
  response.writeHead(200, { 'Content-Type':'application/json' });
  response.end(JSON.stringify(data));
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  metadataUrl = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (![metadataUrl,emulatorUrl].includes(parsed.origin)) throw new Error('External network is forbidden in the emulator harness');
    if(parsed.pathname === '/apdu') {
      const attempted=JSON.parse(init.body || '{}').data || '';
      if (/^e004[0-9a-f]{2}00/i.test(attempted) || (refuseFurtherSigning && /^e004/i.test(attempted))) {
        requests.push({apduHeader:attempted.slice(0,10),blocked:'basic-signing-command'});
        throw new Error('Basic/blind-signing APDUs are forbidden in these generic-context fixtures');
      }
    }
    const apduWait = parsed.pathname === '/apdu' && /^e004[0-9a-f]{2}02/i.test(JSON.parse(init.body || '{}').data || '');
    const result=await originalFetch(url, { ...init, redirect:'error', signal:AbortSignal.any([runAbort.signal, AbortSignal.timeout(apduWait ? reviewTimeout : 45000)]) });
    if(parsed.pathname==='/apdu') {
      const sent=JSON.parse(init.body || '{}');
      const received=await result.clone().json();
      const apdu=sent.data || sent.apdu || '';
      const responseHex = String(received.data || '');
      if (/^e002/i.test(apdu) && responseHex.endsWith('9000')) {
        // getAddress response from this public-default-seed emulator only.
        const data = Buffer.from(responseHex.slice(0,-4), 'hex');
        const offset = 1 + data[0], length = data[offset];
        const candidate = data.subarray(offset + 1, offset + 1 + length).toString('ascii');
        if (/^[0-9a-f]{40}$/i.test(candidate)) signerAddress = `0x${candidate}`;
      }
      const record={apduHeader:apdu.slice(0,10),statusWord:responseHex.slice(-4)};
      requests.push(record);console.log(JSON.stringify(record));
    }
    return result;
  };
  const readyDeadline=Date.now()+30000;
  while(true) {
    try { await originalFetch(`${emulatorUrl}/events?currentscreenonly=true`,{signal:AbortSignal.timeout(1500)}).then(r=>{if(!r.ok) throw new Error('not ready');return r.json();}); break; }
    catch { if(Date.now()>=readyDeadline) throw new Error('Speculos startup deadline expired'); await sleep(500); }
  }
  const dmk = new DeviceManagementKitBuilder().addTransport(speculosTransportFactory(emulatorUrl, true, DeviceModelId.NANO_X)).build();
  let sessionId, cancel;
  const events = [], steps = [];
  let status = 'running', errorCode, timer, fixture, interrupted;
  const stop = () => { if (status === 'running') { status = 'interrupted'; refuseFurtherSigning = true; runAbort.abort(); cancel?.(); interrupted?.(); } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const device = await firstValueFrom(dmk.startDiscovering({ transport:speculosIdentifier }).pipe(timeout(15000)));
    sessionId = await dmk.connect({ device, sessionRefresherOptions:{isRefresherDisabled:true} });
    const context = new ContextModuleBuilder({ originToken:'test-origin-token' })
      .setChain(ContextModuleChainID.Ethereum)
      .setCalConfig({ url:`${metadataUrl}/cal/v1`, mode:'test', branch:'main' })
      .setMetadataServiceConfig({ url:metadataUrl })
      .setWeb3ChecksConfig({ url:metadataUrl })
      .build();
    const signer = new SignerEthBuilder({ dmk, sessionId }).withContextModule({
      getContexts:context.getContexts.bind(context), getFieldContext:context.getFieldContext.bind(context),
      getTypedDataFilters:context.getTypedDataFilters.bind(context), report:async()=>{}, signReport:async()=>{},
    }).build();
    fixture = await import(require('node:url').pathToFileURL(path.join(__dirname, '../fixtures.mjs')).href);
    const routerParams=options.fixture==='router-missing-call' ? fixture.swapParams.slice(0,3) : options.fixture==='router-extra-call' ? [...fixture.swapParams,fixture.swapParams[0]] : fixture.swapParams;
    const accountCalls=options.fixture==='batch-missing-call' ? fixture.calls.slice(0,4) : options.fixture==='batch-extra-call' ? [...fixture.calls,fixture.calls[0]] : fixture.calls;
    const tx = fixtureName === 'approval' ? fixture.direct(fixture.approval('USDG',8000000n)) : fixtureName === 'swap' ? fixture.direct({ target:fixture.router, value:0n, data:fixture.swapData(fixture.swapParams[0]) }) : fixtureName === 'router' ? fixture.direct(fixture.routerCall(routerParams)) : { ...fixture.batch(accountCalls), to:fixture.implementation };
    // Direct implementation binding tests its descriptors. It does not emulate
    // EIP-7702 proxy discovery or assert an account delegation exists.
    const unsigned = serializeTransaction({chainId:4663, type:'legacy', to:tx.to, value:0n,
      data:tx.data, nonce:0, gas:1000000n, gasPrice:1n});
    const action = signer.signTransaction("44'/60'/0'/0/0",hexToBytes(unsigned),{skipOpenApp:true});
    cancel = action.cancel;
    let settled;
    const complete = new Promise(resolve => { settled=resolve; interrupted=resolve;
      timer=setTimeout(()=>{if(status==='running') {status=options['manual-review'] ? 'manual-review-expired' : 'timeout';refuseFurtherSigning=true;runAbort.abort();action.cancel();}resolve();},reviewTimeout);
      action.observable.subscribe({next:state=>{
        const step=state.intermediateValue?.step;
        if(step && steps.at(-1)!==step) { steps.push(step); console.log(JSON.stringify({step})); }
        if(status==='running' && step?.endsWith('.blindSignTransactionFallback')) {status='blind-signing-refused';refuseFurtherSigning=true;queueMicrotask(()=>action.cancel());resolve();}
        if(state.status==='completed' && status==='running') {status='signature-completed';resolve();}
        if(state.status==='error' && status==='running') {status='device-error';errorCode=state.error?.errorCode || state.error?.name;resolve();}
      },error:()=>{if(status==='running') status='observable-error';resolve();},complete:()=>{if(status==='running') status='action-ended-without-result';resolve();}});
    });
    let previous='';
    while(status==='running') {
      const body = await fetch(`${emulatorUrl}/events?currentscreenonly=true`).then(r=>r.json());
      const text = (body.events || []).map(e=>e.text).filter(Boolean).join(' | ');
      if(text && text!==previous) {
        previous=text;events.push(text);console.log(JSON.stringify({screen:text}));
        const png=await fetch(`${emulatorUrl}/screenshot`).then(r=>r.arrayBuffer());
        fs.writeFileSync(`${out}/screen-${String(events.length).padStart(3,'0')}.png`,Buffer.from(png));
      }
      if(status==='running' && /blind signing|cannot be trusted/i.test(text)) {status='blind-warning-refused';refuseFurtherSigning=true;action.cancel();settled();break;}
      if(status==='running' && !options['manual-review'] && steps.some(step=>step.endsWith('signTransaction'))) {
        const terminal = text.replace(/\s*\|\s*/g, ' ').trim();
        const button = /^(Accept and send|Accept|Sign transaction|Confirm)$/i.test(terminal) ? 'both' : 'right';
        await fetch(`${emulatorUrl}/button/${button}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'press-and-release'})});
      }
      await sleep(450);
    }
    await complete;
  } catch (error) {
    if (status === 'running') { status = 'harness-error'; errorCode = error.name; }
    console.log(JSON.stringify({ status, phase: steps.at(-1) || 'setup', error: error.message }));
  } finally {
    clearTimeout(timer);refuseFurtherSigning=true;runAbort.abort();cancel?.();
    try { if(sessionId) await dmk.disconnect({sessionId});await dmk.close(); }
    catch(error) { if(status==='running') {status='cleanup-error';errorCode=error.name;} }
    server.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    const signatureCompleted = status === 'signature-completed';
    const screenAssertions = assertScreens({events,fixture,fixtureName,signerAddress});
    const emulatorScreenAssertionsPassed = screenAssertions.passed;
    const expectedRefusal=assertExpectedRefusal({fixtureCase:options.fixture,status,steps,events,requests,signatureCompleted});
    const success = expectedRefusal.expected ? expectedRefusal.passed : signatureCompleted && emulatorScreenAssertionsPassed;
    process.exitCode = success ? 0 : 1;
    fs.writeFileSync(`${out}/result.json`,JSON.stringify({status,errorCode,signatureCompleted,emulatorScreenAssertionsPassed,screenAssertions,expectedRefusal,matchingContext:Boolean(options['matching-context']),signerAddress,manualReview:options['manual-review'],steps,events,requests,fixture:options.fixture,scope:'Synthetic Nano X descriptor test only; batch targets implementation directly; not EIP-7702 proxy or production approval'},null,2),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({status,errorCode,signatureCompleted,emulatorScreenAssertionsPassed,expectedRefusal,matchingContext:Boolean(options['matching-context']),screens:events.length,resultDirectory:out}));
  }
}
main().catch(error=>{console.log(JSON.stringify({fatal:error.message}));server.close();process.exitCode=1;});
