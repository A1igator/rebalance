import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { assertCaliburDeployment, buildCaliburSelfTransaction, buildCaliburSetupTransaction, CALIBUR_ABI, CALIBUR_ADDRESS, CALIBUR_DELEGATION_CODE,
  CALIBUR_RUNTIME_CODE_HASH, CALIBUR_RUNTIME_CODE_SIZE, encodeCaliburBatch, inspectCaliburAccountCode, type CaliburCall } from '../src/calibur.js';

const evidence = JSON.parse(await readFile(new URL('../docs/evidence/calibur-deployment.json', import.meta.url), 'utf8'));
const wallet = '0x1000000000000000000000000000000000000001' as Address;
const other = '0x1000000000000000000000000000000000000002' as Address;
const stockA = '0x2000000000000000000000000000000000000001' as Address;
const usdg = '0x2000000000000000000000000000000000000002' as Address;
const stockB = '0x2000000000000000000000000000000000000003' as Address;
const stockC = '0x2000000000000000000000000000000000000004' as Address;
const router = '0x3000000000000000000000000000000000000001' as Address;
const approveAbi = parseAbi(['function approve(address spender,uint256 amount) returns(bool)']);
const approval = (to: Address, amount: bigint): CaliburCall => ({ to, value: 0n,
  data: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [router, amount] }) });

test('Calibur implementation accepts only the independently reproduced canonical runtime', () => {
  assert.equal(evidence.runtimeBytes, CALIBUR_RUNTIME_CODE_SIZE);
  assert.equal(evidence.runtimeCodeHash, CALIBUR_RUNTIME_CODE_HASH);
  assert.equal(keccak256(evidence.runtimeBytecode), CALIBUR_RUNTIME_CODE_HASH);
  assert.equal(evidence.verification.byteForByteRuntimeMatch, true);
  assert.equal(evidence.verification.sourceFilesVerified, 66);
  assertCaliburDeployment(evidence.runtimeBytecode);
  const corrupt = `${evidence.runtimeBytecode.slice(0, -2)}${evidence.runtimeBytecode.endsWith('00') ? '01' : '00'}` as Hex;
  for (const code of [undefined, '0x', corrupt, evidence.runtimeBytecode.slice(0, -2), '0xzz']) {
    assert.throws(() => assertCaliburDeployment(code as Hex | undefined), /pinned runtime/);
  }
});

test('account adoption distinguishes empty code, exact Calibur delegation and every other code', () => {
  assert.equal(inspectCaliburAccountCode(undefined), 'undelegated');
  assert.equal(inspectCaliburAccountCode('0x'), 'undelegated');
  assert.equal(inspectCaliburAccountCode(CALIBUR_DELEGATION_CODE), 'calibur');
  assert.equal(inspectCaliburAccountCode(`0x${CALIBUR_DELEGATION_CODE.slice(2).toUpperCase()}`), 'calibur');
  for (const code of ['0x00', `0xef0100${'0'.repeat(40)}`, `0xef0100${other.slice(2)}`, `${CALIBUR_DELEGATION_CODE}00`,
    CALIBUR_DELEGATION_CODE.slice(0, -2), evidence.runtimeBytecode, '0xzz']) {
    assert.throws(() => inspectCaliburAccountCode(code as Hex), /unsupported account code/);
  }
});

test('root self-call preserves exact calls and enforces atomic failure behavior', () => {
  const calls = [approval(stockA, 100n), approval(usdg, 100n), { to: router, value: 0n, data: '0x12345678' as Hex }];
  const tx = buildCaliburSelfTransaction(wallet, calls);
  assert.equal(tx.to, getAddress(wallet)); assert.equal(tx.value, 0n);
  // Decode using the independently compiled CaliburEntry ABI, not the encoder declaration.
  const decoded = decodeFunctionData({ abi: evidence.abi, data: tx.data });
  assert.equal(decoded.functionName, 'execute');
  assert.deepEqual(decoded.args, [{ calls, revertOnFailure: true }]);
  const saved = tx.data;
  calls[0] = approval(stockA, 200n);
  assert.equal(tx.data, saved);
  assert.throws(() => buildCaliburSelfTransaction(CALIBUR_ADDRESS, calls), /portfolio wallet/);
});

test('standalone setup is an empty atomic self-call without relaxing rebalance bounds', () => {
  const setup = buildCaliburSetupTransaction(wallet);
  assert.equal(setup.to, getAddress(wallet)); assert.equal(setup.value, 0n);
  const decoded = decodeFunctionData({ abi: evidence.abi, data: setup.data });
  assert.equal(decoded.functionName, 'execute');
  assert.deepEqual(decoded.args, [{ calls: [], revertOnFailure: true }]);
  assert.throws(() => encodeCaliburBatch([]), /one to five/);
  assert.throws(() => buildCaliburSelfTransaction(wallet, []), /one to five/);
  for (const invalid of [CALIBUR_ADDRESS, `0x${'0'.repeat(40)}`, '0x123', undefined]) {
    assert.throws(() => buildCaliburSetupTransaction(invalid as Address), /portfolio wallet/);
  }
});

test('batch encoding rejects unbounded calls, native value and malformed calldata', () => {
  assert.throws(() => encodeCaliburBatch([]), /one to five/);
  assert.throws(() => encodeCaliburBatch(Array.from({ length: 6 }, () => approval(stockA, 1n))), /one to five/);
  const good = approval(stockA, 1n);
  for (const call of [{ ...good, value: 1n }, { ...good, value: -1n }, { ...good, value: 0 },
    { ...good, to: '0x0' }, { ...good, to: `0x${'0'.repeat(40)}` }, { ...good, data: '0x' },
    { ...good, data: '0x1234567' }, { ...good, data: '0xzz345678' }, { ...good, arbitrary: true }, null]) {
    assert.throws(() => encodeCaliburBatch([call as CaliburCall]), /Invalid Calibur call/);
  }
  assert.equal(decodeFunctionData({ abi: CALIBUR_ABI, data: encodeCaliburBatch(Array.from({ length: 5 }, () => good)) }).args?.[0].revertOnFailure, true);
});

const anvilAvailable = spawnSync('anvil', ['--version'], { env: { PATH: process.env.PATH }, encoding: 'utf8' }).status === 0;
test('canonical Calibur EVM setup is empty and an atomic rebalance rolls back after a late purchase fails',
  { timeout: 30_000, skip: !anvilAvailable && 'Install Foundry Anvil to run the isolated EVM proof' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'calibur-evm-'));
    const ipc = join(root, 'node.ipc');
    // No generated keys, fork URL, inherited wallet/Foundry settings or real app paths.
    const child = spawn('anvil', ['--accounts', '0', '--chain-id', '4663', '--hardfork', 'prague', '--steps-tracing', '--port', '0', '--host', '127.0.0.1', '--ipc', ipc, '--silent'],
      { cwd: root, env: { PATH: process.env.PATH, TMPDIR: root }, stdio: 'ignore' });
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    t.after(async () => { child.kill('SIGTERM'); await exited; await rm(root, { recursive: true, force: true }); });
    const deadline = Date.now() + 5000;
    while (!existsSync(ipc) && !spawnError && child.exitCode === null && Date.now() < deadline) await delay(20);
    assert.equal(spawnError, undefined); assert.ok(existsSync(ipc), 'isolated Anvil IPC is ready');
    let nextId = 0;
    function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
      return new Promise((resolve, reject) => {
        const socket = connect(ipc); let raw = '';
        socket.setTimeout(5000, () => socket.destroy(new Error(`Fixture RPC timed out: ${method}`)));
        socket.once('error', reject);
        socket.on('data', chunk => {
          raw += chunk.toString();
          let response: { result?: T; error?: { message: string } };
          try { response = JSON.parse(raw); } catch { return; }
          socket.destroy();
          if (response.error) reject(new Error(`${method}: ${response.error.message}`)); else resolve(response.result as T);
        });
        socket.once('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }) + '\n'));
      });
    }
    assert.equal(await rpc('eth_chainId', []), '0x1237');
    assert.deepEqual(await rpc('eth_accounts', []), []);
    const fixture = JSON.parse(await readFile(new URL('./fixtures/calibur-mocks.json', import.meta.url), 'utf8'));
    const source = await readFile(new URL('./fixtures/CaliburMocks.sol', import.meta.url), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), fixture.sourceSha256);
    const tokenAbi = fixture.contracts.CaliburMockToken.abi as Abi;
    const routerAbi = fixture.contracts.CaliburMockRouter.abi as Abi;
    await rpc('anvil_setCode', [CALIBUR_ADDRESS, evidence.runtimeBytecode]);
    await rpc('anvil_setCode', [wallet, CALIBUR_DELEGATION_CODE]);
    for (const token of [stockA, usdg, stockB, stockC]) await rpc('anvil_setCode', [token, fixture.contracts.CaliburMockToken.runtimeBytecode]);
    await rpc('anvil_setCode', [router, fixture.contracts.CaliburMockRouter.runtimeBytecode]);
    for (const account of [wallet, other]) { await rpc('anvil_setBalance', [account, '0xde0b6b3a7640000']); await rpc('anvil_impersonateAccount', [account]); }
    const data = (abi: Abi, functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi, functionName, args });
    const read = async (to: Address, abi: Abi, functionName: string, args: readonly unknown[]) => BigInt(await rpc<Hex>('eth_call', [{ to, data: data(abi, functionName, args) }, 'latest']));
    const send = async (from: Address, to: Address, input: Hex) => {
      const hash = await rpc<Hex>('eth_sendTransaction', [{ from, to, data: input, gas: '0x1e8480' }]);
      let receipt = await rpc<{ status: Hex; logs: unknown[] } | null>('eth_getTransactionReceipt', [hash]);
      const until = Date.now() + 3000;
      while (!receipt && Date.now() < until) { await delay(10); receipt = await rpc('eth_getTransactionReceipt', [hash]); }
      assert.ok(receipt); return { hash, receipt };
    };
    for (const [token, owner] of [[stockA, wallet], [usdg, router], [stockB, router], [stockC, router]] as const) {
      assert.equal((await send(other, token, data(tokenAbi, 'mint', [owner, 100n]))).receipt.status, '0x1');
    }
    const capture = async () => {
      const result: bigint[] = [];
      for (const token of [stockA, usdg, stockB, stockC]) {
        result.push(await read(token, tokenAbi, 'balanceOf', [wallet]), await read(token, tokenAbi, 'balanceOf', [router]),
          await read(token, tokenAbi, 'allowance', [wallet, router]));
      }
      result.push(await read(router, routerAbi, 'completedSteps', []));
      return result;
    };
    const initial = await capture();
    const setup = buildCaliburSetupTransaction(wallet);
    const setupResult = await send(wallet, setup.to, setup.data);
    assert.equal(setupResult.receipt.status, '0x1');
    assert.deepEqual(setupResult.receipt.logs, []);
    assert.deepEqual(await capture(), initial, 'empty setup changes no token balance, allowance or router state');
    const setupTrace = await rpc<{ structLogs: { op: string }[] }>('debug_traceTransaction', [setupResult.hash, {
      disableMemory: true, disableStack: true, disableStorage: true,
    }]);
    assert.ok(setupTrace.structLogs.length > 0, 'canonical account code was executed');
    assert.ok(!setupTrace.structLogs.some(step => ['SSTORE', 'TSTORE', 'CALL', 'CALLCODE', 'DELEGATECALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(step.op)),
      'empty canonical setup executes no storage writes, external calls or contract creation');
    assert.equal(await rpc('eth_getCode', [wallet, 'latest']), CALIBUR_DELEGATION_CODE);
    // This proves the empty execution only. Installing a type-4 authorization
    // and paying its native gas are handled by the distinct setup dispatcher.
    const legs = [[stockA, usdg, 100n], [usdg, stockB, 40n], [usdg, stockC, 60n]] as const;
    const routerData = data(routerAbi, 'multicall', [2n ** 64n, legs.map(([tokenIn, tokenOut, amountIn]) => data(routerAbi, 'exactInputSingle', [{
      tokenIn, tokenOut, fee: 3000, recipient: wallet, amountIn, amountOutMinimum: amountIn, sqrtPriceLimitX96: 0n,
    }]))]);
    const tx = buildCaliburSelfTransaction(wallet, [approval(stockA, 100n), approval(usdg, 100n), { to: router, value: 0n, data: routerData }]);
    assert.equal((await send(other, router, data(routerAbi, 'setFailOutput', [stockC]))).receipt.status, '0x1');
    const failed = await send(wallet, tx.to, tx.data);
    assert.equal(failed.receipt.status, '0x0'); assert.deepEqual(failed.receipt.logs, []);
    assert.deepEqual(await capture(), initial, 'approvals, sale, earlier purchase and router storage all rolled back');
    type Trace = { to?: string; input?: string; error?: string; calls?: Trace[] };
    const trace = await rpc<Trace>('debug_traceTransaction', [failed.hash, { tracer: 'callTracer' }]);
    const calls: Trace[] = [];
    const visit = (node: Trace) => { calls.push(node); for (const inner of node.calls ?? []) visit(inner); }; visit(trace);
    const earlierPurchaseTransfer = data(tokenAbi, 'transfer', [wallet, 40n]);
    assert.ok(calls.some(call => call.to?.toLowerCase() === stockB && call.input === earlierPurchaseTransfer && !call.error),
      'the trace proves the earlier purchase executed successfully before the final purchase failure');
    assert.ok(calls.some(call => call.to?.toLowerCase() === stockA && call.input === approval(stockA, 100n).data && !call.error),
      'the exact approval executed before rollback');
    assert.equal((await send(other, wallet, tx.data)).receipt.status, '0x0', 'a different caller cannot use root execution');
    assert.deepEqual(await capture(), initial);
    assert.equal((await send(other, router, data(routerAbi, 'setFailOutput', ['0x0000000000000000000000000000000000000000']))).receipt.status, '0x1');
    const succeeded = await send(wallet, tx.to, tx.data);
    assert.equal(succeeded.receipt.status, '0x1');
    assert.deepEqual(await capture(), [0n, 100n, 0n, 0n, 100n, 0n, 40n, 60n, 0n, 60n, 40n, 0n, 3n]);
    assert.equal(await rpc('eth_getCode', [wallet, 'latest']), CALIBUR_DELEGATION_CODE, 'the delegation persists; execution does not revoke it');
  });
