import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

// Exercise the real planner, graph, request journal, dispatch and receipt/cycle
// handling. The signer is an offline public test vector; every chain method is
// injected and network access is forbidden. This is not hardware or EVM evidence.
const script = `
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const [base, scenario] = process.argv.slice(1);
const path = name => new URL(name + '.ts', base).href;
globalThis.fetch = () => { throw new Error('Network forbidden in batch runtime fixture'); };
delete process.env.REBALANCE_PRIVATE_KEY;
const account = privateKeyToAccount('0x' + '1'.padStart(64, '0'));
let signatures = 0, sends = 0, snapshots = 0, quotes = 0, preparations = 0;
let approved = false, swapped = false;
let configModule, storage, runtime, config;
mock.module(path('signers'), { namedExports: { loadSigner: async selected => {
  assert.equal(selected.mode, 'ledger');
  assert.equal(selected.wallet, account.address);
  return { address: account.address, signTransaction: async tx => {
    signatures++;
    assert.equal((await request.readLedgerRequest()).state, 'consumed');
    assert.equal(await storage.readJson(configModule.DATA + '/config.lock'), null);
    if (tx.data === '0x02' && scenario === 'stop-during-swap-sign') {
      await storage.atomicWriteJson(runtime.STOP_PATH, { requestId: 'batch-fixture-stop' });
    }
    if (tx.data === '0x02' && scenario === 'config-during-swap-sign') {
      await storage.atomicWriteJson(configModule.CONFIG_PATH, { ...config, slippageBps: 75 });
    }
    return account.signTransaction(tx);
  } };
} } });
configModule = await import(path('config'));
storage = await import(path('storage'));
runtime = await import(path('runtime'));
const request = await import(path('ledger-request'));
const { evaluatePortfolio } = await import(path('core'));
const { events } = await import(path('events'));
const targets = { USDG: 2000, AAPL: 2000, NVDA: 2000, MSFT: 2000, AMD: 2000 };
config = configModule.validateConfig({ version: 1, wallet: account.address, mode: 'ledger', chainId: 4663,
  rpcUrl: 'http://batch-runtime-fixture.invalid', targets, driftThresholdBps: 500,
  slippageBps: 50, deadlineSeconds: 120, pollSeconds: 5, rebalanceIntervalSeconds: 3600 });
await storage.atomicWriteJson(configModule.CONFIG_PATH, config);
const release = await storage.acquireLock(configModule.DATA, 'run.lock');
const ledger = new request.LedgerExecution();
const presence = { connected: true, revision: 1 };
const blockHash = '0x' + 'a1'.repeat(32);
const sent = [], mined = new Set(), receipts = new Map();
const chain = {
  publicClient: {
    getChainId: async () => 4663, getTransactionCount: async () => sends,
    estimateGas: async () => 21000n, getGasPrice: async () => 1n, getBalance: async () => 10n ** 18n,
    sendRawTransaction: async ({ serializedTransaction }) => {
      assert.equal(JSON.parse(readFileSync(configModule.DATA + '/config.lock', 'utf8')).pid, process.pid);
      const hash = keccak256(serializedTransaction);
      const pending = await storage.readJson(configModule.PENDING_PATH);
      assert.equal(pending.hash, hash); assert.equal(pending.status, 'prepared');
      sends++; sent.push({ hash, kind: pending.kind });
      receipts.set(hash, { transactionHash: hash, from: account.address, blockNumber: 100n, blockHash,
        status: pending.kind === 'swap' && scenario === 'reverted-batch' ? 'reverted' : 'success', kind: pending.kind });
      return hash;
    },
    getTransactionReceipt: async ({ hash }) => {
      if (!mined.has(hash)) throw new TransactionReceiptNotFoundError({ hash });
      const receipt = receipts.get(hash);
      if (receipt.status === 'success') {
        if (receipt.kind === 'approval') approved = true; else swapped = true;
      }
      return receipt;
    },
    getBlock: async () => ({ hash: blockHash }), getBlockNumber: async () => 102n,
  },
  snapshot: async () => {
    snapshots++;
    return { portfolio: evaluatePortfolio(Object.keys(targets).map(id => ({ id, symbol: id, decimals: 6,
      balance: swapped ? 20000000n : id === 'USDG' ? 100000000n : 0n,
      priceUsdE8: 100000000n, targetBps: targets[id] }))),
      nativeBalance: 10n ** 18n, blockNumber: 102n, valuationNote: 'Offline batch fixture' };
  },
  quote: async () => { throw new Error('Batch runtime must not quote one legacy trade'); },
  transaction: async () => { throw new Error('Batch runtime must not prepare one legacy trade'); },
  quoteBatch: async (plan, context) => {
    assert.deepEqual(context, { driftThresholdBps: 500 });
    quotes++;
    assert.equal(plan.trades.length, 4, 'the initial all-cash plan includes all four stock buys');
    assert.deepEqual(new Set(plan.trades.map(trade => trade.buyAssetId)), new Set(['AAPL', 'NVDA', 'MSFT', 'AMD']));
    for (const trade of plan.trades) { assert.equal(trade.sellAssetId, 'USDG'); assert.equal(trade.amountIn, 20000000n); }
    assert.equal(plan.trades.reduce((sum, trade) => sum + trade.amountIn, 0n), 80000000n);
    return { plan, quotes: plan.trades.map(() => ({ amountOut: 20000000n, minimumOut: 19900000n, fee: 500, blockNumber: 102n })), blockNumber: 102n };
  },
  transactionBatch: async (plan, batch, context) => {
    assert.deepEqual(context, { driftThresholdBps: 500 });
    preparations++;
    assert.equal(batch.quotes.length, plan.trades.length); assert.equal(batch.blockNumber, 102n);
    // Chain builder/ABI atomicity is covered independently. This fixture reports
    // one aggregate approval followed by one four-leg swap to the real runtime.
    return { plan, to: account.address, data: approved ? '0x02' : '0x01', value: 0n,
      kind: approved ? 'swap' : 'approval', swapCount: plan.trades.length, approvalCount: approved ? 0 : 1 };
  },
};
const traverse = () => runtime.tick(true, () => chain, ledger, undefined, presence);
try {
  const first = await traverse();
  assert.equal(first.error, null); assert.equal(first.operation.status, 'pending');
  assert.equal(first.operation.kind, 'approval'); assert.equal(first.proposal.trades.length, 4);
  assert.equal(sends, 1); assert.equal(signatures, 1); assert.equal(snapshots, 1); assert.equal(preparations, 1);
  const initialCycle = await storage.readJson(runtime.CYCLE_PATH);
  assert.equal(initialCycle.swapConfirmed, false);
  const approvalHash = sent[0].hash;
  const waitingForApproval = await traverse();
  assert.equal(waitingForApproval.operation.status, 'pending');
  assert.equal(snapshots, 1); assert.equal(quotes, 1); assert.equal(signatures, 1); assert.equal(sends, 1);
  assert.equal((await storage.readJson(configModule.PENDING_PATH)).hash, approvalHash);
  mined.add(approvalHash);
  const second = await traverse();
  if (scenario === 'stop-during-swap-sign' || scenario === 'config-during-swap-sign') {
    assert.equal(signatures, 2, 'control change must occur after the batch reaches signing');
    assert.equal(sends, 1, 'a late control change discards the signed but unbroadcast batch');
    assert.equal(await storage.readJson(configModule.PENDING_PATH), null);
    assert.equal(swapped, false); assert.equal(ledger.active, false);
    assert.equal((await storage.readJson(runtime.CYCLE_PATH)).swapConfirmed, false);
    assert.equal((await events()).filter(event => event.type === 'rebalance-completed').length, 0);
    if (scenario === 'config-during-swap-sign') {
      assert.equal(second.operation.status, 'configuration-changed');
      assert.equal((await storage.readJson(configModule.CONFIG_PATH)).slippageBps, 75);
    } else assert.equal((await storage.readJson(runtime.STOP_PATH)).requestId, 'batch-fixture-stop');
  } else {
    assert.equal(second.error, null); assert.equal(second.operation.kind, 'swap');
    assert.equal(second.operation.status, 'pending'); assert.equal(signatures, 2); assert.equal(sends, 2);
    assert.equal(snapshots, 2); assert.equal(quotes, 2); assert.equal(preparations, 2);
    assert.deepEqual(sent.map(transaction => transaction.kind), ['approval', 'swap']);
    assert.equal(new Set(sent.map(transaction => transaction.hash)).size, 2);
    assert.equal((await events()).filter(event => event.type === 'rebalance-completed').length, 0);
    const swapHash = sent[1].hash;
    const pending = await storage.readJson(configModule.PENDING_PATH);
    assert.equal(pending.hash, swapHash);
    const waitingForSwap = await traverse();
    assert.equal(waitingForSwap.operation.status, 'pending');
    assert.equal(signatures, 2); assert.equal(sends, 2); assert.equal(snapshots, 2);
    mined.add(swapHash);
    const settled = await traverse();
    if (scenario === 'reverted-batch') {
      assert.equal(settled.operation.status, 'reverted'); assert.equal(swapped, false);
      assert.equal(settled.proposal, undefined); assert.equal(snapshots, 2);
      assert.deepEqual(await storage.readJson(configModule.PENDING_PATH), pending);
      assert.equal((await storage.readJson(runtime.CYCLE_PATH)).swapConfirmed, false);
      assert.equal(ledger.active, false);
      await traverse();
      assert.equal(sends, 2); assert.equal(signatures, 2); assert.equal(snapshots, 2);
      assert.equal(await storage.readJson(configModule.DATA + '/recovery.json'), null);
      assert.equal((await events()).filter(event => event.type === 'rebalance-completed').length, 0);
    } else {
      assert.equal(settled.operation.status, 'confirmed'); assert.equal(settled.proposal, null);
      assert.equal(settled.operation.hash, swapHash); assert.equal(snapshots, 3);
      assert.equal(await storage.readJson(configModule.PENDING_PATH), null);
      const cycle = await storage.readJson(runtime.CYCLE_PATH);
      assert.equal(cycle.startedAt, initialCycle.startedAt); assert.equal(cycle.nextEligibleAt, initialCycle.nextEligibleAt);
      assert.equal(cycle.swapConfirmed, true); assert.ok(cycle.activeUntil <= initialCycle.activeUntil);
      const completion = (await events()).filter(event => event.type === 'rebalance-completed');
      assert.equal(completion.length, 1); assert.equal(completion[0].hash, swapHash);
      assert.equal((await request.readLedgerRequest()).outcome, 'on-target');
      swapped = false;
      const cooling = await traverse();
      assert.equal(cooling.operation.status, 'cooling-down');
      assert.equal(signatures, 2); assert.equal(sends, 2); assert.equal(quotes, 2);
    }
  }
  console.log(JSON.stringify({ scenario, signatures, sends }));
} finally { await ledger.finish('fixture-ended'); await release(); }
`;

for (const scenario of ['complete-batch', 'reverted-batch', 'stop-during-swap-sign', 'config-during-swap-sign']) {
  test(`batch runtime: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rebalance-batch-runtime-'));
    try {
      const result = await promisify(execFile)(process.execPath,
        ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', script, '--',
          new URL('../src/', import.meta.url).href, scenario], {
          env: { ...process.env, REBALANCE_DATA_DIR: directory, REBALANCE_ROOT_DIR: directory, REBALANCE_PROFILE_WALLET: '' },
          timeout: 20_000,
        }).catch(error => { throw new Error(String(error.stderr || error.message).slice(-5000)); });
      assert.deepEqual(JSON.parse(result.stdout), { scenario, signatures: 2, sends: scenario.includes('during-swap-sign') ? 1 : 2 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

// This fixture runs the real chain adapter, planner, runtime and Ledger request
// lifetime against local RPC responses. The mined-state model tests application
// receipt handling; it is not evidence of EVM rollback or live Ledger execution.
const mixedScript = `
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, maxUint256,
  parseAbi, parseTransaction, toHex, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const [base, scenario] = process.argv.slice(1);
const path = name => new URL(name + '.ts', base).href;
delete process.env.REBALANCE_PRIVATE_KEY;
const account = privateKeyToAccount('0x' + '1'.padStart(64, '0'));
let signatures = 0;
mock.module(path('signers'), { namedExports: { loadSigner: async config => {
  assert.equal(config.mode, 'ledger'); assert.equal(config.wallet, account.address);
  return { address: account.address, signTransaction: async tx => {
    signatures++; assert.equal((await request.readLedgerRequest()).state, 'consumed');
    return account.signTransaction(tx);
  } };
} } });
const configModule = await import(path('config'));
const storage = await import(path('storage'));
const runtime = await import(path('runtime'));
const request = await import(path('ledger-request'));
const { createChain, ASSETS, ROUTER, QUOTER } = await import(path('chain'));
const { events } = await import(path('events'));
const targets = { USDG: 2000, AAPL: 2000, NVDA: 2000, MSFT: 2000, AMD: 2000 };
const config = configModule.validateConfig({ version: 1, chainId: 4663, wallet: account.address, mode: 'ledger',
  rpcUrl: 'http://mixed-batch-fixture.invalid', targets, driftThresholdBps: 500, slippageBps: 50,
  deadlineSeconds: 120, pollSeconds: 5, rebalanceIntervalSeconds: 3600 });
await storage.atomicWriteJson(configModule.CONFIG_PATH, config);
const release = await storage.acquireLock(configModule.DATA, 'run.lock');
const ledger = new request.LedgerExecution();
const stockUnit = 10n ** 18n, cashUnit = 10n ** 6n, scale = stockUnit / cashUnit;
const balances = { USDG: 20n * cashUnit, AAPL: 40n * stockUnit, NVDA: 40n * stockUnit, MSFT: 0n, AMD: 0n };
const initialBalances = structuredClone(balances);
const allowances = Object.fromEntries(['AAPL', 'NVDA', 'USDG'].map(id =>
  [id, scenario === 'mixed-preapproved' ? maxUint256 : 0n]));
const sent = [], payloads = new Map();
let snapshots = 0, quotes = 0, preparations = 0, rpcReads = 0, head = 100n, saleRateBps = 10000n;
let initialBuyInput, finalBuyInput, finalReserve, fixtureFailure;
const blockHash = number => '0x' + number.toString(16).padStart(64, '0');
const FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const ZERO = '0x' + '0'.repeat(40);
const stocks = ['AAPL', 'NVDA', 'MSFT', 'AMD'];
const stockPools = Object.fromEntries(stocks.map((id, i) => [id, '0x' + (i + 10).toString(16).padStart(40, '0')]));
const idAt = address => Object.keys(targets).find(id => getAddress(ASSETS[id].address) === getAddress(address));
const RPC_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function factory() view returns (address)', 'function oraclePaused() view returns (bool)',
  'function uiMultiplier() view returns (uint256)', 'function WETH9() view returns (address)',
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256,uint160,uint32,uint256)',
]);
const TRANSACTION_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
]);
const encoded = (type, value) => encodeAbiParameters([{ type }], [value]);
globalThis.fetch = async (input, options) => {
  assert.equal(String(input), config.rpcUrl + '/', 'only the offline RPC fixture may be used');
  const call = JSON.parse(options.body); assert.equal(Array.isArray(call), false); rpcReads++;
  const { method, params } = call;
  let result;
  if (method === 'eth_chainId') result = toHex(4663);
  else if (method === 'eth_getBlockByNumber') {
    assert.deepEqual(params, ['latest', false]);
    result = { number: toHex(head), timestamp: toHex(BigInt(Math.floor(Date.now() / 1000))), hash: blockHash(head), transactions: [] };
  } else {
    assert.equal(params.at(-1), toHex(head), 'all state and quotes must use the selected fresh block');
    if (method === 'eth_getCode') result = '0x6000';
    else if (method === 'eth_getBalance') { assert.equal(getAddress(params[0]), account.address); result = toHex(stockUnit); }
    else if (method === 'eth_call') {
      const decoded = decodeFunctionData({ abi: RPC_ABI, data: params[0].data });
      const asset = idAt(params[0].to);
      switch (decoded.functionName) {
        case 'symbol': result = encoded('string', ASSETS[asset].symbol); break;
        case 'decimals': result = encoded('uint8', ASSETS[asset].decimals); break;
        case 'balanceOf': assert.equal(decoded.args[0], account.address); result = encoded('uint256', balances[asset]); break;
        case 'allowance': assert.deepEqual(decoded.args, [account.address, ROUTER]); result = encoded('uint256', allowances[asset] ?? 0n); break;
        case 'factory': result = encoded('address', FACTORY); break;
        case 'WETH9': result = encoded('address', WETH); break;
        case 'oraclePaused': result = encoded('bool', false); break;
        case 'uiMultiplier': result = encoded('uint256', stockUnit); break;
        case 'getPool': {
          assert.equal(getAddress(params[0].to), FACTORY);
          assert.equal(decoded.args[1], ASSETS.USDG.address);
          result = encoded('address', decoded.args[2] === 500 ? stockPools[idAt(decoded.args[0])] : ZERO); break;
        }
        case 'quoteExactInputSingle': {
          assert.equal(getAddress(params[0].to), QUOTER);
          const { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96 } = decoded.args[0];
          assert.equal(fee, 500); assert.equal(sqrtPriceLimitX96, 0n);
          const selling = idAt(tokenIn) !== 'USDG';
          assert.equal(idAt(selling ? tokenOut : tokenIn), 'USDG');
          // The 0.01 stock sample still values holdings at $1. Larger sale quotes
          // can deteriorate between quote and final transaction preparation.
          const amountOut = selling ? amountIn / scale * (amountIn > stockUnit / 100n ? saleRateBps : 10000n) / 10000n : amountIn * scale;
          result = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }], [amountOut, 1n, 0, 90000n]);
          break;
        }
        default: assert.fail('Unrecognized fixture contract call');
      }
    } else assert.fail('Unexpected RPC method; there is no external transport: ' + method);
  }
  assert.notEqual(result, undefined);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }), { headers: { 'Content-Type': 'application/json' } });
};
const chain = createChain(config);
const original = { snapshot: chain.snapshot, quoteBatch: chain.quoteBatch, transactionBatch: chain.transactionBatch };
Object.assign(chain.publicClient, {
  getChainId: async () => 4663, getTransactionCount: async () => sent.length,
  estimateGas: async () => 21000n, getGasPrice: async () => 1n, getBalance: async () => stockUnit,
  sendRawTransaction: async ({ serializedTransaction }) => {
    const tx = parseTransaction(serializedTransaction), payload = payloads.get(tx.data); assert.ok(payload);
    const hash = keccak256(serializedTransaction), pending = await storage.readJson(configModule.PENDING_PATH);
    assert.equal(pending.hash, hash); assert.equal(pending.status, 'prepared');
    sent.push({ ...payload, hash, blockNumber: head + 1n, mined: false, status: 'success' });
    return hash;
  },
  getTransactionReceipt: async ({ hash }) => {
    const item = sent.find(transaction => transaction.hash === hash);
    if (!item?.mined) throw new TransactionReceiptNotFoundError({ hash });
    return { transactionHash: hash, from: account.address, status: item.status,
      blockNumber: item.blockNumber, blockHash: blockHash(item.blockNumber) };
  },
  getBlockNumber: async () => head,
});
const rpcGetBlock = chain.publicClient.getBlock;
chain.publicClient.getBlock = args => args.blockNumber === undefined ? rpcGetBlock(args) : Promise.resolve({ hash: blockHash(args.blockNumber) });
const moveOnTarget = () => { for (const id of Object.keys(targets)) balances[id] = 20n * (id === 'USDG' ? cashUnit : stockUnit); };
const assertCombined = batch => {
  assert.equal(batch.plan.trades.length, 4);
  assert.deepEqual(batch.plan.trades.map(trade => [trade.sellAssetId, trade.buyAssetId]),
    [['AAPL', 'USDG'], ['NVDA', 'USDG'], ['USDG', 'AMD'], ['USDG', 'MSFT']]);
  assert.equal(batch.quotes.length, 4); assert.equal(batch.blockNumber, head);
  const minimumCash = balances.USDG + batch.quotes[0].minimumOut + batch.quotes[1].minimumOut;
  const stockCashValue = (balances.AAPL + balances.NVDA - batch.plan.trades[0].amountIn - batch.plan.trades[1].amountIn) / scale;
  const reserve = ((stockCashValue + minimumCash) * 2000n + 9999n) / 10000n;
  const purchases = batch.plan.trades.slice(2).reduce((sum, trade) => sum + trade.amountIn, 0n);
  assert.equal(purchases, minimumCash - reserve, 'purchase spending is bounded by encoded sale minima and a rounded reserve');
  assert.ok(purchases > balances.USDG, 'these buys require balances credited by earlier calls in the same transaction');
  initialBuyInput ??= purchases;
  return { purchases, reserve };
};
chain.snapshot = async () => { snapshots++; return original.snapshot(); };
chain.quote = async () => { throw new Error('Atomic runtime must not quote a legacy leg'); };
chain.transaction = async () => { throw new Error('Atomic runtime must not dispatch a legacy leg'); };
chain.quoteBatch = async (plan, context) => {
  quotes++; assert.deepEqual(context, { driftThresholdBps: 500 });
  if (scenario === 'mixed-observation-changed-quote') moveOnTarget();
  const batch = await original.quoteBatch(plan, context); assertCombined(batch); return batch;
};
chain.transactionBatch = async (plan, previous, context) => {
  preparations++; assert.deepEqual(context, { driftThresholdBps: 500 });
  if (scenario === 'mixed-observation-changed-preparation') moveOnTarget();
  if (scenario === 'mixed-lower-quotes' && ['AAPL', 'NVDA', 'USDG'].every(id => allowances[id] > 0n)) saleRateBps = 9975n;
  const tx = await original.transactionBatch(plan, previous, context);
  assert.equal(tx.plan.trades.length, 4); assert.equal(tx.swapCount, 4);
  const decoded = decodeFunctionData({ abi: TRANSACTION_ABI, data: tx.data });
  if (tx.kind === 'approval') {
    assert.equal(decoded.functionName, 'approve'); assert.equal(decoded.args[0], ROUTER);
    const inputId = idAt(tx.to);
    const exactInput = tx.plan.trades.filter(trade => trade.sellAssetId === inputId).reduce((sum, trade) => sum + trade.amountIn, 0n);
    assert.equal(decoded.args[1], exactInput, 'each approval is exactly the aggregate input for its token');
    if (inputId === 'USDG') assert.ok(exactInput > balances.USDG, 'the prior approval can cover USDG received by the later multicall');
    assert.ok(allowances[inputId] < exactInput);
    payloads.set(tx.data, { kind: tx.kind, approvalToken: inputId, amount: exactInput, plan: tx.plan });
  } else {
    assert.equal(decoded.functionName, 'multicall'); assert.equal(tx.to, ROUTER);
    const calls = decoded.args[1].map(data => decodeFunctionData({ abi: TRANSACTION_ABI, data }).args[0]);
    const batch = { plan: tx.plan, quotes: calls.map(call => ({ minimumOut: call.amountOutMinimum })), blockNumber: head };
    const bound = assertCombined(batch); finalBuyInput = bound.purchases; finalReserve = bound.reserve;
    for (const [index, call] of calls.entries()) {
      const trade = tx.plan.trades[index];
      assert.equal(call.recipient, account.address); assert.equal(call.amountIn, trade.amountIn);
      assert.equal(idAt(call.tokenIn), trade.sellAssetId); assert.equal(idAt(call.tokenOut), trade.buyAssetId);
      assert.equal(call.sqrtPriceLimitX96, 0n);
    }
    if (scenario === 'mixed-lower-quotes') assert.ok(finalBuyInput < initialBuyInput, 'final preparation must resize purchases when sale quotes fall');
    payloads.set(tx.data, { kind: tx.kind, plan: tx.plan, calls });
  }
  return tx;
};
for (const method of ['snapshot', 'quoteBatch', 'transactionBatch']) {
  const operation = chain[method];
  chain[method] = async (...args) => {
    try { return await operation(...args); }
    catch (error) { fixtureFailure = error; throw error; }
  };
}
const mine = item => {
  assert.equal(item.mined, false); item.mined = true; head = item.blockNumber;
  if (item.kind === 'approval') { allowances[item.approvalToken] = item.amount; return; }
  const settled = structuredClone(balances), remaining = structuredClone(allowances);
  for (const [index, call] of item.calls.entries()) {
    const from = idAt(call.tokenIn), to = idAt(call.tokenOut);
    assert.ok(settled[from] >= call.amountIn, 'later purchases spend only balances already received');
    assert.ok(remaining[from] >= call.amountIn, 'USDG allowance covers both purchases together');
    settled[from] -= call.amountIn; remaining[from] -= call.amountIn;
    const actual = from !== 'USDG'
      ? scenario === 'mixed-minimum-proceeds' ? call.amountOutMinimum : call.amountIn / scale * saleRateBps / 10000n
      : call.amountIn * scale;
    assert.ok(actual >= call.amountOutMinimum);
    settled[to] += actual;
    if (scenario === 'mixed-late-buy-revert' && index === item.calls.length - 1) {
      assert.ok(settled.AMD > 0n, 'the final-buy failure follows earlier simulated sales and a purchase');
      item.status = 'reverted'; return;
    }
  }
  Object.assign(balances, settled); Object.assign(allowances, remaining);
  assert.ok(balances.USDG >= finalReserve);
};
const traverse = () => runtime.tick(true, () => chain, ledger, undefined, { connected: true, revision: 1 });
const expected = scenario === 'mixed-preapproved' ? ['swap:mixed']
  : ['approval:AAPL', 'approval:NVDA', 'approval:USDG', 'swap:mixed'];
const describe = item => item.kind + ':' + (item.kind === 'approval' ? item.approvalToken : 'mixed');
try {
  let state = await traverse();
  if (scenario.startsWith('mixed-observation-changed')) {
    assert.equal(state.error, null, fixtureFailure?.stack); assert.equal(state.operation.status, 'observation-changed');
    assert.equal(state.proposal, undefined); assert.equal(state.feeCheck, undefined);
    assert.equal(state.portfolio.positions.find(position => position.id === 'AAPL').balance, initialBalances.AAPL,
      'a fresh-preparation short circuit must not mislabel a retained observation as current');
    assert.equal(ledger.active, false); assert.equal(sent.length, 0); assert.equal(signatures, 0);
    assert.equal((await request.readLedgerPromptState()).suspended, false);
    if (scenario === 'mixed-observation-changed-preparation') {
      assert.equal((await request.readLedgerRequest()).outcome, 'observation-changed');
    }
    assert.equal((await events()).filter(event => event.type === 'rebalance-completed').length, 0);
    assert.equal(await storage.readJson(configModule.PENDING_PATH), null);
    const observed = await traverse(); assert.equal(observed.proposal, null); assert.equal(sent.length, 0);
    console.log(JSON.stringify({ scenario, signatures, sends: 0, swapBatches: 0 }));
  } else {
    const initialCycle = await storage.readJson(runtime.CYCLE_PATH);
    for (const [index, operation] of expected.entries()) {
      assert.equal(state.error, null, fixtureFailure?.stack); assert.equal(state.operation.status, 'pending');
      assert.equal(sent.length, index + 1); assert.equal(signatures, sent.length);
      assert.equal(state.proposal.trades.length, 4, 'status shows the rebuilt mixed plan, including purchases');
      assert.equal(state.portfolio.positions.find(position => position.id === 'USDG').balance, initialBalances.USDG,
        'a planned minimum-funded portfolio must never replace observed holdings');
      const item = sent[index]; assert.equal(describe(item), operation);
      if (item.kind === 'swap') assert.deepEqual(state.proposal, item.plan, 'status uses final prepared amounts');
      const before = { snapshots, quotes, preparations, rpcReads, signatures, sends: sent.length };
      const pending = await storage.readJson(configModule.PENDING_PATH); assert.equal(pending.hash, item.hash);
      state = await traverse(); assert.equal(state.operation.status, 'pending');
      assert.deepEqual({ snapshots, quotes, preparations, rpcReads, signatures, sends: sent.length }, before);
      const beforeSwapAllowances = structuredClone(allowances);
      mine(item);
      state = await traverse(); assert.equal(state.operation.status, item.status === 'reverted' ? 'reverted' : 'confirming');
      assert.deepEqual({ snapshots, quotes, preparations, rpcReads, signatures, sends: sent.length }, before,
        'even mined balance changes cannot bypass the single confirmation barrier');
      assert.deepEqual(await storage.readJson(configModule.PENDING_PATH), pending);
      assert.equal((await events()).filter(event => event.type === 'rebalance-completed').length, 0);
      head = item.blockNumber + 1n; state = await traverse();
      if (item.status === 'reverted') {
        assert.equal(state.operation.status, 'reverted'); assert.equal(state.proposal, undefined);
        assert.deepEqual(balances, initialBalances); assert.deepEqual(allowances, beforeSwapAllowances);
        assert.deepEqual(await storage.readJson(configModule.PENDING_PATH), pending);
        assert.equal((await storage.readJson(runtime.CYCLE_PATH)).swapConfirmed, false);
        assert.equal(ledger.active, false);
        assert.equal((await events()).filter(event => event.type === 'rebalance-completed').length, 0);
        await traverse(); assert.equal(sent.length, expected.length); assert.equal(signatures, expected.length);
      }
    }
    assert.deepEqual(sent.map(describe), expected);
    assert.equal(sent.filter(item => item.kind === 'swap').length, 1);
    assert.equal(new Set(sent.map(item => item.hash)).size, expected.length);
    if (scenario !== 'mixed-late-buy-revert') {
      assert.equal(state.error, null); assert.equal(state.operation.status, 'confirmed'); assert.equal(state.proposal, null);
      assert.equal(await storage.readJson(configModule.PENDING_PATH), null);
      if (scenario === 'mixed-minimum-proceeds') assert.equal(balances.USDG, finalReserve);
      else assert.ok(balances.USDG > finalReserve, 'better realized proceeds remain in the wallet');
      assert.ok(state.portfolio.positions.every(position => Math.abs(position.driftBps) <= 500));
      const cycle = await storage.readJson(runtime.CYCLE_PATH);
      assert.equal(cycle.startedAt, initialCycle.startedAt); assert.equal(cycle.nextEligibleAt, initialCycle.nextEligibleAt);
      assert.equal(cycle.swapConfirmed, true); assert.equal((await request.readLedgerRequest()).outcome, 'on-target');
      const completed = (await events()).filter(event => event.type === 'rebalance-completed');
      assert.equal(completed.length, 1); assert.equal(completed[0].hash, sent.at(-1).hash);
      await traverse(); assert.equal(sent.length, expected.length); assert.equal(signatures, expected.length);
    }
    console.log(JSON.stringify({ scenario, signatures, sends: sent.length, swapBatches: 1 }));
  }
} finally { await ledger.finish('fixture-ended'); await release(); }
`;

for (const scenario of ['mixed-approvals', 'mixed-preapproved', 'mixed-minimum-proceeds', 'mixed-lower-quotes',
  'mixed-late-buy-revert', 'mixed-observation-changed-quote', 'mixed-observation-changed-preparation']) {
  test(`atomic batch runtime: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rebalance-mixed-batch-runtime-'));
    try {
      const result = await promisify(execFile)(process.execPath,
        ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', mixedScript, '--',
          new URL('../src/', import.meta.url).href, scenario], {
          env: { ...process.env, REBALANCE_DATA_DIR: directory, REBALANCE_ROOT_DIR: directory, REBALANCE_PROFILE_WALLET: '' },
          timeout: 30_000,
        }).catch(error => { throw new Error(String(error.stderr || error.message).slice(-6000)); });
      const transactions = scenario.includes('observation-changed') ? 0 : scenario === 'mixed-preapproved' ? 1 : 4;
      assert.deepEqual(JSON.parse(result.stdout), { scenario, signatures: transactions, sends: transactions,
        swapBatches: transactions ? 1 : 0 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
