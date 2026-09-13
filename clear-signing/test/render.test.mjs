import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maxUint256, formatUnits } from 'viem';
import { render, problems, display } from '../render.mjs';
import { batch, calls, approval, direct, routerCall, swapParams, wallet, router, implementation, deadline } from '../fixtures.mjs';
// No live metadata, registry, RPC or credentials in these checks.
globalThis.fetch = async () => { throw new Error('Network forbidden in descriptor tests'); };
const values = (model, label) => model.fields.filter(field => field.label === label).map(field => field.value);
const one = (model, label) => { const result = values(model, label); assert.equal(result.length, 1, label); return result[0]; };
const formatted = async (tx, options) => { const model = await render(tx, options); assert.deepEqual(problems(model), []); return display(model); };

test('full batch renders four exact approvals and ordered sales/purchase', async () => {
  const model = await formatted(batch(), { modelDelegation: true });
  assert.equal(model.intent, 'Execute batch');
  assert.equal(one(model, 'Account'), wallet);
  assert.equal(one(model, 'Native value (wei)'), '0');
  assert.deepEqual(values(model, 'Call target'), calls.map(call => call.target));
  assert.deepEqual(values(model, 'Call value (wei)'), ['0', '0', '0', '0', '0']);
  const actions = values(model, 'Action');
  assert.equal(actions.length, 5);
  for (const [i, amount] of ['0.01 AAPL', '0.02 NVDA', '0.03 MSFT', '8 USDG'].entries()) {
    assert.equal(actions[i].intent, 'Approve token');
    assert.deepEqual(actions[i].fields, [
      { label: 'Contract', value: calls[i].target }, { label: 'Native value (wei)', value: '0' },
      { label: 'Spender', value: router }, { label: 'Approval amount', value: amount },
    ]);
  }
  const swaps = actions[4];
  assert.equal(swaps.intent, 'Swap batch');
  assert.equal(one(swaps, 'Contract'), router);
  assert.equal(one(swaps, 'Deadline'), '2027-01-15 08:00:00Z');
  const legs = values(swaps, 'Swap');
  assert.equal(legs.length, 4);
  for (let i = 0; i < legs.length; i++) {
    assert.equal(legs[i].intent, 'Swap exact input');
    assert.deepEqual(legs[i].fields, [
      { label: 'Contract', value: router }, { label: 'Router caller', value: wallet }, { label: 'Native value (wei)', value: '0' },
      { label: 'Input token', value: swapParams[i].tokenIn }, { label: 'Output token', value: swapParams[i].tokenOut },
      { label: 'Input (0=router bal)', value: ['0.01 AAPL', '0.02 NVDA', '0.03 MSFT', '8 USDG'][i] },
      { label: 'Minimum received', value: ['2 USDG', '3 USDG', '4 USDG', '0.04 AMD'][i] },
      { label: 'Pool fee', value: '0.3%' }, { label: 'Recipient', value: wallet }, { label: 'Recipient flags', value: '1=sender; 2=router' }, { label: 'Sqrt price limit X96', value: '0' },
    ]);
  }
});

test('EOA lookup remains unknown without the explicit synthetic delegation mapping', async () => {
  assert.ok(problems(await render(batch())).some(p => p.code === 'NO_DESCRIPTOR'));
  const model = await formatted({ ...batch(), to: implementation });
  assert.equal(one(model, 'Account'), implementation);
  // Direct implementation formatting is not evidence of executable wallet delegation.
});

test('unknown chain and nested calls cannot earn a clean result from a readable wrapper', async () => {
  assert.ok(problems(await render({ ...batch(), chainId: 1 }, { modelDelegation: true })).length > 0);
  for (const call of [
    { target: router, value: 0n, data: '0xdeadbeef' },
    { target: '0x2222222222222222222222222222222222222222', value: 0n, data: approval('USDG', 1n).data },
  ]) {
    const model = await render(batch([call]), { modelDelegation: true });
    assert.equal(model.intent, 'Execute batch');
    assert.ok(problems(model).length > 0);
  }
});

test('missing nested token metadata produces warnings rather than guessed decimals', async () => {
  assert.ok(problems(await render(batch(), { modelDelegation: true, tokenMetadata: false })).some(p => p.code === 'UNKNOWN_TOKEN'));
});

test('changed spender, native value and full uint256 approval remain visible', async () => {
  const spender = '0x2222222222222222222222222222222222222222';
  const model = await formatted(direct({ ...approval('USDG', 7_000_001n, spender), value: 99n }));
  assert.equal(one(model, 'Spender'), spender);
  assert.equal(one(model, 'Approval amount'), '7.000001 USDG');
  assert.equal(one(model, 'Native value (wei)'), '99');
  const huge = one(await formatted(direct(approval('USDG', maxUint256))), 'Approval amount');
  assert.equal(huge, `${formatUnits(maxUint256, 6)} USDG`);
  assert.doesNotMatch(huge, /unlimited|all/i);
});

test('changed swap recipient, minimum, fee, price limit and deadline are visible', async () => {
  const recipient = '0x2222222222222222222222222222222222222222';
  const params = { ...swapParams[0], recipient, amountOutMinimum: 1_234_567n, fee: 500, sqrtPriceLimitX96: 123456789n };
  const model = await formatted(direct(routerCall([params], deadline + 60n)));
  assert.equal(one(model, 'Deadline'), '2027-01-15 08:01:00Z');
  const leg = one(model, 'Swap');
  assert.equal(one(leg, 'Recipient'), recipient);
  assert.equal(one(leg, 'Minimum received'), '1.234567 USDG');
  assert.equal(one(leg, 'Pool fee'), '0.05%');
  assert.equal(one(leg, 'Sqrt price limit X96'), '123456789');
});

test('empty setup does not invent a rebalance or swaps', async () => {
  const model = display(await render(batch([]), { modelDelegation: true }));
  assert.equal(model.intent, 'Execute batch');
  assert.deepEqual(values(model, 'Action'), []);
  assert.equal(one(model, 'Account'), wallet);
});

test('problem collection catches a warning below grouped nested fields', () => {
  const model = { fields: [{ fields: [{ embeddedCalldata: { display: {
    intent: 'Looks readable', fields: [], warnings: [{ code: 'NO_FORMAT_MATCH', message: 'Nested method unsupported' }],
  } } }] }] };
  assert.equal(problems(model)[0].code, 'NO_FORMAT_MATCH');
});

test('router zero-input and special recipients retain their dynamic meaning', async () => {
  for (const flag of [1, 2]) {
    const recipient = `0x${flag.toString(16).padStart(40, '0')}`;
    const params = { ...swapParams[0], recipient, amountIn: 0n };
    const model = await formatted(direct(routerCall([params])));
    const leg = one(model, 'Swap');
    assert.equal(one(leg, 'Input (0=router bal)'), '0 AAPL');
    assert.equal(one(leg, 'Recipient'), recipient);
    assert.equal(one(leg, 'Recipient flags'), '1=sender; 2=router');
    assert.equal(one(leg, 'Router caller'), wallet);
  }
});

test('missing nested display keeps raw calldata and remains incomplete', () => {
  const model = { fields: [{ label: 'Action', value: '0xdeadbeef', embeddedCalldata: {} }] };
  assert.equal(problems(model)[0].code, 'RAW_CALLDATA');
  assert.equal(display(model).fields[0].value, '0xdeadbeef');
});
