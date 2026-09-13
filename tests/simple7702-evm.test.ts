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
import { encodeFunctionData, getContractAddress, keccak256, parseAbi, type Abi, type Address, type Hex } from 'viem';

const artifact = JSON.parse(await readFile(new URL('../src/artifacts/simple7702.json', import.meta.url), 'utf8'));
const wallet = '0x1000000000000000000000000000000000000001' as Address;
const other = '0x1000000000000000000000000000000000000002' as Address;
const stockA = '0x2000000000000000000000000000000000000001' as Address;
const usdg = '0x2000000000000000000000000000000000000002' as Address;
const stockB = '0x2000000000000000000000000000000000000003' as Address;
const stockC = '0x2000000000000000000000000000000000000004' as Address;
const router = '0x3000000000000000000000000000000000000001' as Address;
const delegationCode = `0xef0100${artifact.address.slice(2).toLowerCase()}`;
// Independent ABI from the embedded canonical upstream artifact. The production
// helper's validation/encoding tests are separate from this actual EVM proof.
const batchAbi = parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);
const approveAbi = parseAbi(['function approve(address spender,uint256 amount) returns(bool)']);
type Call = { to: Address; value: bigint; data: Hex };
const approval = (to: Address, amount: bigint): Call => ({ to, value: 0n,
  data: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [router, amount] }) });
const buildSelf = (address: Address, calls: Call[]) => ({ to: address, value: 0n,
  data: encodeFunctionData({ abi: batchAbi, functionName: 'executeBatch',
    args: [calls.map(call => ({ target: call.to, value: call.value, data: call.data }))] }) });

test('canonical Simple7702 artifact derives its whitelisted address without constructor arguments', () => {
  assert.equal(artifact.address, '0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9');
  assert.equal(artifact.factoryAddress, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
  assert.equal(artifact.salt, `0x${'00'.repeat(32)}`);
  assert.equal(artifact.deploymentCalldata, artifact.salt + artifact.initCode.slice(2));
  assert.equal(keccak256(artifact.initCode), artifact.initCodeHash);
  assert.equal(keccak256(artifact.runtimeBytecode), '0x82c1e6c0f83d22eef579344e8eff26baf24db4dabe5408d681b00d0512bc3ec4');
  assert.equal(keccak256(artifact.factoryRuntimeBytecode), '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989');
  assert.equal((artifact.runtimeBytecode.length - 2) / 2, 3639);
  assert.equal(getContractAddress({ from: artifact.factoryAddress, opcode: 'CREATE2', salt: artifact.salt, bytecode: artifact.initCode }).toLowerCase(), artifact.address.toLowerCase());
});

const anvilAvailable = spawnSync('anvil', ['--version'], { env: { PATH: process.env.PATH }, encoding: 'utf8' }).status === 0;
test('canonical Simple7702 CREATE2 deployment and self-call batch execute with complete atomic rollback',
  { timeout: 30_000, skip: !anvilAvailable && 'Install Foundry Anvil to run the isolated EVM proof' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'simple7702-evm-'));
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
    await rpc('anvil_setCode', [artifact.factoryAddress, artifact.factoryRuntimeBytecode]);
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
    assert.equal(await rpc('eth_getCode', [artifact.address, 'latest']), '0x');
    const deployed = await send(other, artifact.factoryAddress, artifact.deploymentCalldata);
    assert.equal(deployed.receipt.status, '0x1');
    assert.equal(await rpc('eth_getCode', [artifact.address, 'latest']), artifact.runtimeBytecode,
      'canonical CREATE2 initcode deploys the complete expected runtime');
    assert.equal((await send(other, artifact.factoryAddress, artifact.deploymentCalldata)).receipt.status, '0x0',
      'a repeated CREATE2 deployment cannot overwrite the implementation');
    assert.equal(await rpc('eth_getCode', [artifact.address, 'latest']), artifact.runtimeBytecode);
    await rpc('anvil_setCode', [wallet, delegationCode]);
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
    const setup = buildSelf(wallet, []);
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
    assert.equal(await rpc('eth_getCode', [wallet, 'latest']), delegationCode);
    // This proves the empty execution only. Installing a type-4 authorization
    // and paying its native gas are handled by the distinct setup dispatcher.
    const legs = [[stockA, usdg, 100n], [usdg, stockB, 40n], [usdg, stockC, 60n]] as const;
    const routerData = data(routerAbi, 'multicall', [2n ** 64n, legs.map(([tokenIn, tokenOut, amountIn]) => data(routerAbi, 'exactInputSingle', [{
      tokenIn, tokenOut, fee: 3000, recipient: wallet, amountIn, amountOutMinimum: amountIn, sqrtPriceLimitX96: 0n,
    }]))]);
    const tx = buildSelf(wallet, [approval(stockA, 100n), approval(usdg, 100n), { to: router, value: 0n, data: routerData }]);
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
    assert.equal(await rpc('eth_getCode', [wallet, 'latest']), delegationCode, 'the delegation persists; execution does not revoke it');
  });
