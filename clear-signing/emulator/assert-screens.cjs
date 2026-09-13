'use strict';

// Checks captured Nano X text against the fixed, public synthetic fixtures.
// This verifies the recorded display only, independently of signature success.
// It does not establish production metadata trust or EIP-7702 proxy support.
const LABELS = [
  'Transaction type', 'Account', 'Native value (wei)', 'Call target', 'Call value (wei)',
  'Contract', 'Router caller', 'Deadline', 'Input token', 'Output token',
  'Input (0=router bal)', 'Minimum received', 'Pool fee', 'Recipient',
  'Recipient flags', 'Sqrt price limit X96', 'Spender', 'Approval amount',
  'Network', 'Max fees',
];
const compact = value => String(value).replace(/[\s|]/g, '');
const labels = LABELS.map(label => ({ label, key: compact(label) }))
  .sort((a, b) => b.key.length - a.key.length);

function decimal(value, decimals) {
  const digits = BigInt(value).toString().padStart(decimals + 1, '0');
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}

// Matches app-ethereum 1.22.3 src/time_format.c: UTC, 12-hour clock.
function ledgerDate(timestamp) {
  const date = new Date(Number(BigInt(timestamp) * 1000n));
  const iso = date.toISOString();
  const hour = date.getUTCHours();
  return `${iso.slice(0, 10)} ${String(hour % 12 || 12).padStart(2, '0')}:${iso.slice(14, 19)} ${hour < 12 ? 'AM' : 'PM'} UTC`;
}

function expectedFields({ fixture: f, fixtureName, signerAddress }) {
  if (!['approval', 'swap', 'router', 'batch'].includes(fixtureName)) throw new Error('Unknown synthetic fixture');
  const fields = [];
  const add = (operation, label, value) => fields.push({ operation, label, value: String(value) });
  const address = (operation, label, value) => {
    if (!/^0x[0-9a-f]{40}$/i.test(value || '')) throw new Error(`Missing valid expected ${operation} ${label}`);
    add(operation, label, value);
  };
  const token = address => {
    const result = Object.values(f.tokens).find(t => t.address.toLowerCase() === address.toLowerCase());
    if (!result) throw new Error('Unknown fixture token');
    return result;
  };
  const amount = (value, address) => {
    const metadata = token(address);
    return `${decimal(value, metadata.decimals)} ${metadata.symbol}`;
  };
  const approval = (symbol, value, operation) => {
    if (fixtureName === 'batch') add(operation, 'Transaction type', 'Approve token');
    address(operation, 'Contract', f.tokens[symbol].address);
    add(operation, 'Native value (wei)', 0);
    address(operation, 'Spender', f.router);
    add(operation, 'Approval amount', amount(value, f.tokens[symbol].address));
  };
  const swap = (params, index, caller) => {
    const operation = `swap[${index}]`;
    if (fixtureName === 'router' || fixtureName === 'batch') add(operation, 'Transaction type', 'Swap exact input');
    address(operation, 'Contract', f.router);
    address(operation, 'Router caller', caller);
    add(operation, 'Native value (wei)', 0);
    address(operation, 'Input token', params.tokenIn);
    address(operation, 'Output token', params.tokenOut);
    add(operation, 'Input (0=router bal)', amount(params.amountIn, params.tokenIn));
    add(operation, 'Minimum received', amount(params.amountOutMinimum, params.tokenOut));
    add(operation, 'Pool fee', `${decimal(params.fee, 4)} %`);
    address(operation, 'Recipient', params.recipient);
    add(operation, 'Recipient flags', '1=sender; 2=router');
    add(operation, 'Sqrt price limit X96', params.sqrtPriceLimitX96);
  };
  const router = caller => {
    if (fixtureName === 'batch') add('router', 'Transaction type', 'Swap batch');
    address('router', 'Contract', f.router);
    address('router', 'Router caller', caller);
    add('router', 'Native value (wei)', 0);
    add('router', 'Deadline', ledgerDate(f.deadline));
    f.swapParams.forEach((params, index) => swap(params, index, caller));
  };
  if (fixtureName === 'approval') approval('USDG', 8000000n, 'approval[0]');
  if (fixtureName === 'swap') swap(f.swapParams[0], 0, signerAddress);
  if (fixtureName === 'router') router(signerAddress);
  if (fixtureName === 'batch') {
    address('batch', 'Account', f.implementation);
    add('batch', 'Native value (wei)', 0);
    const approvals = [['AAPL', 10n ** 16n], ['NVDA', 2n * 10n ** 16n],
      ['MSFT', 3n * 10n ** 16n], ['USDG', 8000000n]];
    approvals.forEach(([symbol, value], index) => {
      address(`call[${index}]`, 'Call target', f.tokens[symbol].address);
      add(`call[${index}]`, 'Call value (wei)', 0);
      approval(symbol, value, `approval[${index}]`);
    });
    address('call[4]', 'Call target', f.router);
    add('call[4]', 'Call value (wei)', 0);
    router(f.implementation);
  }
  add('transaction', 'Network', 'Robinhood Chain');
  // Injector fixes gas=1,000,000 and gasPrice=1 wei in every synthetic case.
  add('transaction', 'Max fees', '0.000000000001 ETH');
  return fields;
}

function assertScreens(args) {
  const { events } = args;
  const failures = [];
  let expected;
  try { expected = expectedFields(args); }
  catch (error) {
    return { passed: false, complete: false, failures: [{ reason: error.message }], fields: [], expectedFieldCount: null, matchedFieldCount: 0 };
  }
  if (!Array.isArray(events) || !events.every(value => typeof value === 'string')) {
    return { passed: false, complete: false, failures: [{ reason: 'Screen events must be strings' }], fields: [], expectedFieldCount: expected.length, matchedFieldCount: 0 };
  }
  const observed = [];
  let terminalSeen = false;
  let introSeen = false;
  events.forEach((event, eventIndex) => {
    const text = compact(event);
    const field = labels.find(({ key }) => text.startsWith(key));
    if (field) {
      if (terminalSeen) failures.push({ eventIndex, reason: 'Field appeared after the signing confirmation screen' });
      observed.push({ label: field.label, value: text.slice(field.key.length), eventIndex });
    } else if (text === 'Signtransaction') {
      if (terminalSeen) failures.push({ eventIndex, reason: 'Repeated signing confirmation screen' });
      terminalSeen = true;
    } else if (text === ({swap:'ReviewtransactiontoSwapexactinput',router:'ReviewtransactiontoSwapbatch',batch:'ReviewtransactiontoExecutebatch'})[args.fixtureName] &&
      !introSeen && !terminalSeen && observed.length === 0) {
      // Captured on Nano X; app-ethereum 1.22.3 src/nbgl/ui_gcs.c:416.
      // An exact fixture intent is allowed once, before any transaction fields.
      introSeen = true;
    } else if (text === 'Ethereumappisready' || text === 'InteractionwithRebalancedevelopment') {
      // Known app startup and descriptor-owner introduction, not calldata fields.
    } else {
      failures.push({ eventIndex, reason: 'Unrecognized screen; full display is not established', screen: event });
    }
  });
  const fields = expected.map((wanted, index) => {
    const actual = observed[index];
    const wantedValue = compact(wanted.value);
    const sameValue = /^0x[0-9a-f]{40}$/i.test(wantedValue)
      ? actual?.value.toLowerCase() === wantedValue.toLowerCase()
      : actual?.value === wantedValue;
    const matched = actual?.label === wanted.label && sameValue;
    const result = { ...wanted, index, matched, observed: actual || null };
    if (!matched) failures.push({ index, operation: wanted.operation, label: wanted.label, expected: wanted.value, observed: actual || null, reason: 'Missing, changed or out-of-order field' });
    return result;
  });
  if (observed.length !== expected.length) failures.push({ reason: 'Field count differs', expected: expected.length, observed: observed.length });
  if (!terminalSeen) failures.push({ reason: 'Signing confirmation screen was not captured' });
  const passed = failures.length === 0;
  return { passed, complete: passed, expectedFieldCount: expected.length,
    observedFieldCount: observed.length, matchedFieldCount: fields.filter(field => field.matched).length,
    terminalSeen, failures, fields,
    scope: 'Exact ordered synthetic Nano X display fields only; signature, production trust and EIP-7702 proxy support are separate' };
}

module.exports = { assertScreens, expectedFields };
