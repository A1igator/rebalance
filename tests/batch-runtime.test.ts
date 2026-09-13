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
  quoteBatch: async plan => {
    quotes++;
    assert.equal(plan.trades.length, 4, 'the initial all-cash plan includes all four stock buys');
    assert.deepEqual(new Set(plan.trades.map(trade => trade.buyAssetId)), new Set(['AAPL', 'NVDA', 'MSFT', 'AMD']));
    for (const trade of plan.trades) { assert.equal(trade.sellAssetId, 'USDG'); assert.equal(trade.amountIn, 20000000n); }
    assert.equal(plan.trades.reduce((sum, trade) => sum + trade.amountIn, 0n), 80000000n);
    return { quotes: plan.trades.map(() => ({ amountOut: 20000000n, minimumOut: 19900000n, fee: 500, blockNumber: 102n })), blockNumber: 102n };
  },
  transactionBatch: async (plan, batch) => {
    preparations++;
    assert.equal(batch.quotes.length, plan.trades.length); assert.equal(batch.blockNumber, 102n);
    // Chain builder/ABI atomicity is covered independently. This fixture reports
    // one aggregate approval followed by one four-leg swap to the real runtime.
    return { to: account.address, data: approved ? '0x02' : '0x01', value: 0n,
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

// A mixed portfolio exercises both phases through the real runtime. Public
// balances change only when the fixture mines a transaction, and runtime must
// wait for its second confirmation before observing or preparing the next one.
const mixedScript = `
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { keccak256, parseTransaction, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const [base, scenario] = process.argv.slice(1);
const path = name => new URL(name + '.ts', base).href;
globalThis.fetch = () => { throw new Error('Network forbidden in mixed batch runtime fixture'); };
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
const { evaluatePortfolio } = await import(path('core'));
const { events } = await import(path('events'));
const targets = { USDG: 2000, AAPL: 2000, NVDA: 2000, MSFT: 2000, AMD: 2000 };
const config = configModule.validateConfig({ version: 1, chainId: 4663, wallet: account.address, mode: 'ledger',
  rpcUrl: 'http://mixed-batch-fixture.invalid', targets, driftThresholdBps: 500, slippageBps: 50,
  deadlineSeconds: 120, pollSeconds: 5, rebalanceIntervalSeconds: 3600 });
await storage.atomicWriteJson(configModule.CONFIG_PATH, config);
const release = await storage.acquireLock(configModule.DATA, 'run.lock');
const ledger = new request.LedgerExecution();
const balances = { USDG: 20000000n, AAPL: 40000000n, NVDA: 40000000n, MSFT: 0n, AMD: 0n };
const allowance = new Set(scenario === 'mixed-preapproved' ? ['AAPL', 'NVDA', 'USDG'] : []);
const lowerProceeds = scenario === 'mixed-lower-proceeds';
const sent = [], payloads = new Map();
let snapshots = 0, quotes = 0, preparations = 0, head = 100n, saleReceiptBlock;
const blockHash = number => '0x' + number.toString(16).padStart(64, '0');
const phaseOf = plan => plan.trades.every(trade => trade.buyAssetId === 'USDG') ? 'sell' : 'buy';
const chain = {
  publicClient: {
    getChainId: async () => 4663, getTransactionCount: async () => sent.length,
    estimateGas: async () => 21000n, getGasPrice: async () => 1n, getBalance: async () => 10n ** 18n,
    sendRawTransaction: async ({ serializedTransaction }) => {
      const decoded = parseTransaction(serializedTransaction);
      const payload = payloads.get(decoded.data); assert.ok(payload);
      const hash = keccak256(serializedTransaction);
      const pending = await storage.readJson(configModule.PENDING_PATH);
      assert.equal(pending.hash, hash); assert.equal(pending.status, 'prepared');
      const blockNumber = head + 1n;
      sent.push({ ...payload, hash, blockNumber, mined: false });
      return hash;
    },
    getTransactionReceipt: async ({ hash }) => {
      const item = sent.find(transaction => transaction.hash === hash);
      if (!item?.mined) throw new TransactionReceiptNotFoundError({ hash });
      return { transactionHash: hash, from: account.address, status: 'success', blockNumber: item.blockNumber,
        blockHash: blockHash(item.blockNumber) };
    },
    getBlock: async ({ blockNumber }) => ({ hash: blockHash(blockNumber) }), getBlockNumber: async () => head,
  },
  snapshot: async () => {
    snapshots++;
    return { portfolio: evaluatePortfolio(Object.keys(targets).map(id => ({ id, symbol: id, decimals: 6,
      balance: balances[id], priceUsdE8: 100000000n, targetBps: targets[id] }))),
      nativeBalance: 10n ** 18n, blockNumber: head, valuationNote: 'Offline mixed batch fixture' };
  },
  quote: async () => { throw new Error('Mixed batch runtime must not quote a legacy leg'); },
  transaction: async () => { throw new Error('Mixed batch runtime must not dispatch a legacy leg'); },
  quoteBatch: async plan => {
    quotes++;
    const phase = phaseOf(plan);
    assert.equal(plan.trades.length, 2, 'both assets belong to one phase batch');
    if (saleReceiptBlock === undefined) {
      assert.equal(phase, 'sell', 'a buy must not use hypothetical sale proceeds');
      assert.deepEqual(plan.trades.map(trade => [trade.sellAssetId, trade.buyAssetId, trade.amountIn]),
        [['AAPL', 'USDG', 20000000n], ['NVDA', 'USDG', 20000000n]]);
      assert.equal(balances.USDG, 20000000n);
    } else {
      assert.equal(phase, 'buy', 'within-threshold residual stock overweights must not cause another sales phase');
      assert.ok(head >= saleReceiptBlock + 1n, 'purchases wait for the sales batch confirmation');
      assert.equal(await storage.readJson(configModule.PENDING_PATH), null);
      assert.deepEqual(new Set(plan.trades.map(trade => trade.buyAssetId)), new Set(['MSFT', 'AMD']));
      assert.ok(plan.trades.every(trade => trade.sellAssetId === 'USDG'));
      const total = Object.values(balances).reduce((sum, value) => sum + value, 0n);
      const reserve = total * 2000n / 10000n;
      const input = plan.trades.reduce((sum, trade) => sum + trade.amountIn, 0n);
      assert.equal(input, balances.USDG - reserve, 'purchase input comes from the newly observed cash surplus');
      assert.equal(input, lowerProceeds ? 39920000n : 40000000n);
      if (lowerProceeds) assert.ok(input < 40000000n, 'the old quote cannot authorize spending unreceived cash');
    }
    return { quotes: plan.trades.map(trade => ({ amountOut: trade.amountIn,
      minimumOut: trade.amountIn * 9950n / 10000n, fee: 500, blockNumber: head })), blockNumber: head };
  },
  transactionBatch: async (plan, batch) => {
    preparations++;
    assert.equal(batch.blockNumber, head); assert.equal(batch.quotes.length, plan.trades.length);
    const phase = phaseOf(plan);
    const inputs = [...new Set(plan.trades.map(trade => trade.sellAssetId))];
    const missing = inputs.filter(id => !allowance.has(id));
    const kind = missing.length ? 'approval' : 'swap';
    const data = '0x' + preparations.toString(16).padStart(2, '0');
    const payload = { kind, phase, approvalToken: missing[0], plan: structuredClone(plan), batch: structuredClone(batch) };
    payloads.set(data, payload);
    return { to: account.address, data, value: 0n, kind, swapCount: plan.trades.length, approvalCount: missing.length };
  },
};
const mine = item => {
  assert.equal(item.mined, false); item.mined = true; head = item.blockNumber;
  if (item.kind === 'approval') { allowance.add(item.approvalToken); return; }
  for (const [index, trade] of item.plan.trades.entries()) {
    const quoted = item.batch.quotes[index];
    const actualOut = quoted.amountOut - (lowerProceeds && item.phase === 'sell' ? 50000n : 0n);
    assert.ok(actualOut >= quoted.minimumOut, 'lower realized proceeds remain within the accepted slippage');
    assert.ok(balances[trade.sellAssetId] >= trade.amountIn);
    balances[trade.sellAssetId] -= trade.amountIn;
    balances[trade.buyAssetId] += actualOut;
  }
  if (item.phase === 'sell') saleReceiptBlock = item.blockNumber;
};
const traverse = () => runtime.tick(true, () => chain, ledger, undefined, { connected: true, revision: 1 });
const expected = scenario === 'mixed-preapproved'
  ? ['swap:sell', 'swap:buy']
  : ['approval:AAPL', 'approval:NVDA', 'swap:sell', 'approval:USDG', 'swap:buy'];
const describe = item => item.kind + ':' + (item.kind === 'approval' ? item.approvalToken : item.phase);
try {
  let state = await traverse();
  const initialCycle = await storage.readJson(runtime.CYCLE_PATH);
  for (const [index, operation] of expected.entries()) {
    assert.equal(state.error, null); assert.equal(state.operation.status, 'pending');
    assert.equal(sent.length, index + 1); assert.equal(signatures, sent.length);
    const item = sent[index]; assert.equal(describe(item), operation);
    const before = { snapshots, quotes, preparations, signatures, sends: sent.length };
    const pending = await storage.readJson(configModule.PENDING_PATH);
    assert.equal(pending.hash, item.hash);
    state = await traverse();
    assert.equal(state.operation.status, 'pending');
    assert.deepEqual({ snapshots, quotes, preparations, signatures, sends: sent.length }, before);
    mine(item);
    state = await traverse();
    assert.equal(state.operation.status, 'confirming');
    assert.deepEqual({ snapshots, quotes, preparations, signatures, sends: sent.length }, before,
      'even changed mined balances cannot bypass the pending confirmation barrier');
    assert.deepEqual(await storage.readJson(configModule.PENDING_PATH), pending);
    head = item.blockNumber + 1n;
    state = await traverse();
  }
  assert.equal(state.error, null); assert.equal(state.operation.status, 'confirmed'); assert.equal(state.proposal, null);
  assert.deepEqual(sent.map(describe), expected);
  assert.equal(sent.filter(item => item.kind === 'swap' && item.phase === 'sell').length, 1);
  assert.equal(sent.filter(item => item.kind === 'swap' && item.phase === 'buy').length, 1);
  assert.equal(new Set(sent.map(item => item.hash)).size, expected.length);
  assert.equal(await storage.readJson(configModule.PENDING_PATH), null);
  assert.equal(balances.USDG, lowerProceeds ? 19980000n : 20000000n);
  assert.ok(state.portfolio.positions.every(position => Math.abs(position.driftBps) <= 500));
  const cycle = await storage.readJson(runtime.CYCLE_PATH);
  assert.equal(cycle.startedAt, initialCycle.startedAt); assert.equal(cycle.nextEligibleAt, initialCycle.nextEligibleAt);
  assert.equal(cycle.swapConfirmed, true);
  assert.equal((await request.readLedgerRequest()).outcome, 'on-target');
  const completed = (await events()).filter(event => event.type === 'rebalance-completed');
  assert.equal(completed.length, 1); assert.equal(completed[0].hash, sent.at(-1).hash);
  await traverse(); assert.equal(sent.length, expected.length); assert.equal(signatures, expected.length);
  console.log(JSON.stringify({ scenario, signatures, sends: sent.length, swapBatches: 2 }));
} finally { await ledger.finish('fixture-ended'); await release(); }
`;

for (const scenario of ['mixed-approvals', 'mixed-preapproved', 'mixed-lower-proceeds']) {
  test(`batch runtime: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rebalance-mixed-batch-runtime-'));
    try {
      const result = await promisify(execFile)(process.execPath,
        ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', mixedScript, '--',
          new URL('../src/', import.meta.url).href, scenario], {
          env: { ...process.env, REBALANCE_DATA_DIR: directory, REBALANCE_ROOT_DIR: directory, REBALANCE_PROFILE_WALLET: '' },
          timeout: 20_000,
        }).catch(error => { throw new Error(String(error.stderr || error.message).slice(-5000)); });
      const transactions = scenario === 'mixed-preapproved' ? 2 : 5;
      assert.deepEqual(JSON.parse(result.stdout), { scenario, signatures: transactions, sends: transactions, swapBatches: 2 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
