import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { privySigner, privySigningRequest, privyWallet, verifiedPrivyTransaction, type PreparedTransaction } from '../src/privy.js';

// Published disposable fixture keys; every command here is injected, with no CLI or network.
const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
const other = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`);
const tx: PreparedTransaction = { chainId: 4663, type: 'legacy', nonce: 0, gas: 25200n,
  gasPrice: 9_007_199_254_740_993n, to: other.address, value: 0n, data: '0x' };
const response = (signed_transaction: string) => JSON.stringify({ method: 'eth_signTransaction', data: { encoding: 'rlp', signed_transaction } });

test('Privy selects the same first Ethereum wallet as its CLI, with cached status clearly labelled', async () => {
  const wallet = await privyWallet(async args => {
    assert.deepEqual(args, ['list-wallets']);
    return `Wallets:\n  solana: abc (sol-id)\n  ethereum: ${account.address} (first)\n  ethereum: ${other.address} (second)\n`;
  });
  assert.equal(wallet.address, account.address); assert.equal(wallet.walletId, 'first');
  assert.equal(wallet.session, 'cached'); assert.equal(wallet.networkVerified, false);
  await assert.rejects(privyWallet(async () => `ethereum: malformed (first)\n ethereum: ${account.address} (second)`), /No usable/);
  await assert.rejects(privySigner(other.address, async () => `ethereum: ${account.address} (first)`), /differs/);
});

test('Privy uses signing-only stdin with explicit chain and exact integer fields', async () => {
  const calls: string[][] = [];
  const raw = await account.signTransaction(tx);
  const signer = await privySigner(account.address, async (args, input) => {
    calls.push([...args]);
    if (args[0] === 'list-wallets') return `ethereum: ${account.address} (first)`;
    assert.deepEqual(args, ['rpc']);
    assert.deepEqual(JSON.parse(input!), { method: 'eth_signTransaction', caip2: 'eip155:4663', params: { transaction: {
      from: account.address, to: other.address, chain_id: 4663, type: 0, nonce: 0,
      gas_limit: '0x6270', gas_price: '0x20000000000001', value: '0x0', data: '0x',
    } } });
    return response(raw);
  });
  assert.equal(await signer.signTransaction(tx), raw);
  assert.deepEqual(calls, [['list-wallets'], ['rpc']]);
});

test('Privy rejects modified sender, chain, nonce, gas, fee, recipient, value, data and typed transactions', async () => {
  const variants = [
    await other.signTransaction(tx),
    ...await Promise.all([
      { chainId: 1 }, { nonce: 1 }, { gas: 25201n }, { gasPrice: 2n },
      { to: account.address }, { value: 1n }, { data: '0x1234' as const },
    ].map(change => account.signTransaction({ ...tx, ...change }))),
    await account.signTransaction({ ...tx, type: 'eip1559', gasPrice: undefined, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
  ];
  for (const raw of variants) await assert.rejects(verifiedPrivyTransaction(response(raw), account.address, tx), /invalid signature or a transaction differing/);
});

test('Malformed or wrong-method Privy responses fail closed without reflecting provider contents', async () => {
  const raw = await account.signTransaction(tx);
  const malformed = ['sensitive server error', '{}', 'null', response('0xc080'),
    JSON.stringify({ method: 'eth_sendTransaction', data: { signed_transaction: raw, encoding: 'rlp' } }),
    JSON.stringify({ method: 'eth_signTransaction', data: { signed_transaction: raw, encoding: 'base64' } })];
  for (const output of malformed) await assert.rejects(verifiedPrivyTransaction(output, account.address, tx), error =>
    error instanceof Error && !error.message.includes(output) && /No transaction was broadcast/.test(error.message));
});

test('Invalid prepared transaction never reaches the signing request', () => {
  for (const change of [{ chainId: 1 }, { nonce: -1 }, { nonce: 1.2 }, { gas: 0n }, { gasPrice: 0n }, { value: -1n }, { gasPrice: 2n ** 256n }]) {
    assert.throws(() => privySigningRequest(account.address, { ...tx, ...change } as PreparedTransaction), /Invalid prepared/);
  }
});
