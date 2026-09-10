import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { Observable, Subject, of } from 'rxjs';
import { bytesToHex, parseSignature, serializeSignature, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalPayloadSignature, preparedAuthorization, preparedMessageHash, verifiedAuthorizationSignature,
  verifiedMessageHashSignature, type PreparedAuthorization } from '../src/signing-payloads.js';
import { privySigner } from '../src/privy.js';
import { ledgerSigner, LedgerSigningError } from '../src/ledger-signing.js';
import type { LedgerAddressAction, LedgerDevice, LedgerSdk } from '../src/ledger-onboarding.js';
import { atomicWriteJson } from '../src/storage.js';

// Published disposable vectors, injected provider/device adapters, and temporary public metadata only.
const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
const other = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`);
const authorization: PreparedAuthorization = { chainId: 4663, address: other.address, nonce: 4 };
const userOpHash: Hex = `0x${'ab'.repeat(32)}`;
const secondHash: Hex = `0x${'cd'.repeat(32)}`;
const anchor = other.address, anchorPath = "44'/60'/0'/0/0", path = "44'/60'/1'/0/0";
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const outcome = (expected: string) => (error: unknown) => error instanceof LedgerSigningError && error.outcome === expected;
const completed = (output: unknown): LedgerAddressAction => ({ observable: of({ status: 'completed', output }), cancel() {} });
const addressAction = (address: Address) => completed({ address, publicKey: `04${'12'.repeat(64)}` });
async function authSignature(input = authorization, owner = account) {
  const { r, s, yParity } = await owner.signAuthorization(input);
  return { r, s, v: 27 + yParity! };
}
async function messageSignature(hash = userOpHash, owner = account) {
  const { r, s, v } = parseSignature(await owner.signMessage({ message: { raw: hash } }));
  return { r, s, v: Number(v) };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 300; i++) { if (condition()) return; await delay(2); }
  assert.fail('Fixture did not reach the expected state');
}
async function fixture(t: TestContext) {
  const rootDir = await mkdtemp(join(await realpath(tmpdir()), 'rebalance-paymaster-sign-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const journal = join(rootDir, 'ledger-onboarding', 'accounts.json');
  await atomicWriteJson(journal, { version: 1, requests: { [digest('first')]: {
    fingerprint: digest(anchor.toLowerCase()), accountIndex: 1, derivationPath: path,
    address: account.address, verifiedAt: '2026-09-10T00:00:00.000Z',
  } } });
  const signed: unknown[] = [], addresses: string[] = [];
  let closes = 0, connects = 0;
  const auth = await authSignature(), message = await messageSignature();
  const device: LedgerDevice = {
    getAddress(p) { addresses.push(p); return addressAction(p === anchorPath ? anchor : account.address); },
    signDelegationAuthorization(p, chainId, contract, nonce) { signed.push({ p, chainId, contract, nonce }); return completed(auth); },
    signMessage(p, bytes) { signed.push({ p, message: bytesToHex(bytes) }); return completed(message); },
    signTransaction() { assert.fail('Paymaster signing must not fall back to a transaction'); },
    async close() { closes++; },
  };
  return { rootDir, journal, device, signed, addresses, connects: () => connects, closes: () => closes,
    connect: async () => { connects++; return device; } };
}
const methods = ['signAuthorization', 'signMessageHash'] as const;
const invoke = (signer: { signAuthorization(input: PreparedAuthorization): Promise<Hex>; signMessageHash(hash: Hex): Promise<Hex> }, method: typeof methods[number]) =>
  method === 'signAuthorization' ? signer.signAuthorization(authorization) : signer.signMessageHash(userOpHash);

test('payload signatures bind to the selected wallet and exact chain, delegate, nonce or raw hash', async () => {
  const auth = await authSignature(), message = await messageSignature();
  assert.equal(await verifiedAuthorizationSignature(auth, account.address, authorization), serializeSignature({ ...auth, v: BigInt(auth.v) }));
  assert.equal(await verifiedMessageHashSignature(message, account.address, userOpHash), await account.signMessage({ message: { raw: userOpHash } }));
  for (const changed of [{ nonce: 5 }, { address: account.address }]) {
    await assert.rejects(verifiedAuthorizationSignature(auth, account.address, { ...authorization, ...changed }), /Invalid signature/);
  }
  await assert.rejects(verifiedAuthorizationSignature(await authSignature({ ...authorization, chainId: 1 } as unknown as PreparedAuthorization), account.address, authorization), /Invalid signature/);
  await assert.rejects(verifiedAuthorizationSignature(await authSignature(authorization, other), account.address, authorization), /Invalid signature/);
  await assert.rejects(verifiedMessageHashSignature(await messageSignature(secondHash), account.address, userOpHash), /Invalid signature/);
  await assert.rejects(verifiedMessageHashSignature(await messageSignature(userOpHash, other), account.address, userOpHash), /Invalid signature/);
  await assert.rejects(verifiedMessageHashSignature(await account.signMessage({ message: userOpHash }), account.address, userOpHash), /Invalid signature/);
});

test('payload validation rejects wildcard/wrong chains and non-canonical signatures without echoing contents', async () => {
  assert.ok(Object.isFrozen(preparedAuthorization(authorization)));
  for (const changed of [{ chainId: 0 }, { chainId: 1 }, { nonce: -1 }, { nonce: 1.2 }, { nonce: Number.MAX_SAFE_INTEGER + 1 },
    { address: `0x${'00'.repeat(20)}` }, { address: 'sensitive-value' }, { extra: 'sensitive-value' }]) {
    assert.throws(() => preparedAuthorization({ ...authorization, ...changed } as PreparedAuthorization), /^Error: Invalid prepared Robinhood delegation authorization\.$/);
  }
  for (const hash of ['0x', '0x01', `0x${'ab'.repeat(33)}`, 'sensitive-value']) assert.throws(() => preparedMessageHash(hash as Hex), /exact 32-byte/);
  const signature = await authSignature();
  for (const invalid of [null, {}, 'sensitive-value', { ...signature, v: 9361 }, { ...signature, v: 35 }, { ...signature, yParity: 1 - (signature.v - 27) },
    { ...signature, r: `0x${'00'.repeat(32)}` }, { ...signature, s: `0x${'ff'.repeat(32)}` },
    { ...signature, extra: 'sensitive-value' }, `0x${'ab'.repeat(66)}`]) {
    assert.throws(() => canonicalPayloadSignature(invalid), /^Error: Invalid signature for the prepared payload or selected wallet\.$/);
  }
  assert.equal(canonicalPayloadSignature({ ...signature, v: signature.v - 27 }), canonicalPayloadSignature(signature));
});

test('Privy signs explicit 7702 authorization and raw personal hash through stdin without broadcasts', async () => {
  const calls: unknown[] = [];
  const signer = await privySigner(account.address, async (args, input) => {
    if (args[0] === 'list-wallets') return `ethereum: ${account.address} (fixture-wallet)`;
    assert.deepEqual(args, ['rpc']);
    const request = JSON.parse(input!); calls.push(request);
    if (request.method === 'eth_sign7702Authorization') {
      const signed = await account.signAuthorization(authorization);
      return JSON.stringify({ method: request.method, data: { authorization: {
        contract: signed.address, chain_id: signed.chainId, nonce: signed.nonce, r: signed.r, s: signed.s, y_parity: signed.yParity,
      } } });
    }
    assert.equal(request.method, 'personal_sign');
    return JSON.stringify({ method: request.method, data: { encoding: 'hex', signature: await account.signMessage({ message: { raw: userOpHash } }) } });
  });
  assert.equal(await signer.signAuthorization(authorization), canonicalPayloadSignature(await authSignature()));
  assert.equal(await signer.signMessageHash(userOpHash), canonicalPayloadSignature(await messageSignature()));
  assert.deepEqual(calls, [
    { method: 'eth_sign7702Authorization', params: { contract: authorization.address, chain_id: 4663, nonce: 4 } },
    { method: 'personal_sign', caip2: 'eip155:4663', params: { message: userOpHash, encoding: 'hex' }, signature_options: { type: 'ecdsa' } },
  ]);
});

test('Privy rejects changed provider authorization fields, signer, encoding and malformed response', async () => {
  const auth = await account.signAuthorization(authorization);
  const base = { contract: auth.address, chain_id: auth.chainId, nonce: auth.nonce, r: auth.r, s: auth.s, y_parity: auth.yParity };
  for (const changed of [{ contract: account.address }, { chain_id: 0 }, { chain_id: 1 }, { nonce: 5 }, { y_parity: 27 }, { r: 'sensitive-value' }]) {
    const signer = await privySigner(account.address, async args => args[0] === 'list-wallets' ? `ethereum: ${account.address} (fixture)` :
      JSON.stringify({ method: 'eth_sign7702Authorization', data: { authorization: { ...base, ...changed } } }));
    await assert.rejects(signer.signAuthorization(authorization), /^Error: Privy returned an invalid delegation authorization for the prepared fields or selected wallet\.$/);
  }
  const wrong = await other.signAuthorization(authorization);
  for (const output of ['sensitive-value {', JSON.stringify({ method: 'eth_signTransaction', data: { authorization: base } }),
    JSON.stringify({ method: 'eth_sign7702Authorization', data: { authorization: { ...base, r: wrong.r, s: wrong.s, y_parity: wrong.yParity } } })]) {
    const signer = await privySigner(account.address, async args => args[0] === 'list-wallets' ? `ethereum: ${account.address} (fixture)` : output);
    await assert.rejects(signer.signAuthorization(authorization), /invalid delegation/);
  }
  for (const output of ['sensitive-value {', JSON.stringify({ method: 'personal_sign', data: { encoding: 'utf-8', signature: await account.signMessage({ message: { raw: userOpHash } }) } }),
    JSON.stringify({ method: 'personal_sign', data: { encoding: 'hex', signature: await other.signMessage({ message: { raw: userOpHash } }) } }),
    JSON.stringify({ method: 'personal_sign', data: { encoding: 'hex', signature: await account.signMessage({ message: { raw: secondHash } }) } })]) {
    const signer = await privySigner(account.address, async args => args[0] === 'list-wallets' ? `ethereum: ${account.address} (fixture)` : output);
    await assert.rejects(signer.signMessageHash(userOpHash), /^Error: Privy returned an invalid personal signature for the prepared hash or selected wallet\.$/);
  }
});

test('invalid new payloads fail before a Privy RPC or Ledger connection', async t => {
  const f = await fixture(t), ledger = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: f.connect });
  const privy = await privySigner(account.address, async args => {
    assert.deepEqual(args, ['list-wallets']); return `ethereum: ${account.address} (fixture)`;
  });
  for (const signer of [privy, ledger]) {
    await assert.rejects(signer.signAuthorization({ ...authorization, chainId: 0 } as unknown as PreparedAuthorization));
    await assert.rejects(signer.signMessageHash('0x1234'));
  }
  assert.equal(f.connects(), 0);
});

test('Ledger new actions use verified path and exact values, and release the device with public state unchanged', async t => {
  const f = await fixture(t), before = await readFile(f.journal, 'utf8');
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: f.connect });
  assert.equal(f.connects(), 0);
  assert.equal(await signer.signAuthorization(authorization), canonicalPayloadSignature(await authSignature()));
  assert.equal(await signer.signMessageHash(userOpHash), canonicalPayloadSignature(await messageSignature()));
  assert.deepEqual(f.signed, [{ p: path, chainId: 4663, contract: authorization.address, nonce: 4 }, { p: path, message: userOpHash }]);
  assert.deepEqual(f.addresses, [anchorPath, path, anchorPath, anchorPath, path, anchorPath]);
  assert.equal(f.closes(), 2); assert.equal(await readFile(f.journal, 'utf8'), before);
});

for (const method of methods) {
  test(`Ledger ${method} rejection never retries or falls back`, async t => {
    const f = await fixture(t); let signs = 0, cancelled = 0;
    const action = () => { signs++; return { observable: of({ status: 'error', error: { errorCode: '6985', message: 'sensitive-value' } }), cancel() { cancelled++; } }; };
    if (method === 'signAuthorization') f.device.signDelegationAuthorization = action; else f.device.signMessage = action;
    const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: f.connect });
    await assert.rejects(invoke(signer, method), error => outcome('rejected')(error) && !(error as Error).message.includes('sensitive-value'));
    assert.equal(signs, 1); assert.equal(cancelled, 1); assert.equal(f.closes(), 1);
  });
  test(`Ledger ${method} cancellation and timeout cancel physical action and discard its result`, async t => {
    for (const mode of ['cancelled', 'timeout', 'cleanup']) {
      const f = await fixture(t), controller = new AbortController();
      let subscribed = false, cancelled = 0, unsubscribed = 0;
      const action = (): LedgerAddressAction => ({ observable: new Observable(subscriber => {
        subscribed = true; subscriber.next({ status: 'pending' }); return () => { unsubscribed++; };
      }), cancel() { cancelled++; } });
      if (mode !== 'cleanup') {
        if (method === 'signAuthorization') f.device.signDelegationAuthorization = action; else f.device.signMessage = action;
      } else f.device.close = async () => { controller.abort(); };
      const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: f.connect,
        timeoutMs: mode === 'timeout' ? 150 : 5000, signal: controller.signal });
      const pending = invoke(signer, method), rejected = assert.rejects(pending, outcome(mode === 'timeout' ? 'timeout' : 'cancelled'));
      if (mode !== 'cleanup') {
        await until(() => subscribed);
        if (mode === 'cancelled') controller.abort();
      }
      await rejected;
      if (mode !== 'cleanup') { assert.equal(cancelled, 1); assert.equal(unsubscribed, 1); assert.equal(f.closes(), 1); }
    }
  });
  test(`Ledger ${method} rejects unavailable capability, account mismatch and wrong signature`, async t => {
    for (const mode of ['missing', 'account', 'signature', 'anchor']) {
      const f = await fixture(t);
      if (mode === 'missing') {
        if (method === 'signAuthorization') delete f.device.signDelegationAuthorization; else delete f.device.signMessage;
      }
      if (mode === 'account') f.device.getAddress = p => addressAction(p === anchorPath ? account.address : other.address);
      if (mode === 'signature') {
        const wrong = method === 'signAuthorization' ? await authSignature(authorization, other) : await messageSignature(userOpHash, other);
        if (method === 'signAuthorization') f.device.signDelegationAuthorization = () => completed(wrong);
        else f.device.signMessage = () => completed(wrong);
      }
      if (mode === 'anchor') {
        let reads = 0;
        f.device.getAddress = p => addressAction(p === anchorPath ? (++reads > 1 ? account.address : anchor) : account.address);
      }
      const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: f.connect });
      await assert.rejects(invoke(signer, method), outcome(mode === 'missing' ? 'unavailable' : mode === 'signature' ? 'invalid-signature' : 'account-mismatch'));
      assert.equal(f.closes(), 1);
    }
  });
}

test('already cancelled Ledger paymaster request cannot access the device', async t => {
  const f = await fixture(t), controller = new AbortController();
  controller.abort();
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: f.connect, signal: controller.signal });
  for (const method of methods) await assert.rejects(invoke(signer, method), outcome('cancelled'));
  assert.equal(f.connects(), 0); assert.deepEqual(f.signed, []);
});

test('Ledger authorization snapshots caller input and shares one hardware mutex across payload types', async t => {
  const f = await fixture(t), action = new Subject<{ status: string; output?: unknown }>();
  let started = false;
  f.device.signDelegationAuthorization = (p, chainId, contract, nonce) => {
    assert.deepEqual({ p, chainId, contract, nonce }, { p: path, chainId: 4663, contract: authorization.address, nonce: 4 });
    started = true; return { observable: action, cancel() {} };
  };
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: f.connect });
  const mutable = { ...authorization }, first = signer.signAuthorization(mutable);
  await until(() => started);
  mutable.address = account.address; mutable.nonce = 99;
  const second = signer.signMessageHash(userOpHash);
  await delay(40); assert.equal(f.connects(), 1);
  action.next({ status: 'completed', output: await authSignature() });
  assert.equal(await first, canonicalPayloadSignature(await authSignature()));
  assert.equal(await second, canonicalPayloadSignature(await messageSignature()));
  assert.equal(f.connects(), 2); assert.equal(f.closes(), 2);
});

test('native SDK adapter forwards both paymaster actions without transaction signing', async t => {
  const f = await fixture(t), delegated: unknown[] = [];
  let closes = 0;
  const auth = await authSignature(), message = await messageSignature();
  const sdk: LedgerSdk = {
    manager: { listenToAvailableDevices: () => of([{}]), async connect() { return 'fixture-session'; }, async disconnect() {}, close() { closes++; } },
    signer(session) {
      assert.equal(session, 'fixture-session');
      return { getAddress: p => addressAction(p === anchorPath ? anchor : account.address),
        signDelegationAuthorization(p, chainId, contract, nonce) { delegated.push({ p, chainId, contract, nonce }); return completed(auth); },
        signMessage(p, bytes) { delegated.push({ p, message: bytesToHex(bytes) }); return completed(message); } };
    },
  };
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, loadSdk: () => sdk });
  await signer.signAuthorization(authorization); await signer.signMessageHash(userOpHash);
  assert.deepEqual(delegated, [{ p: path, chainId: 4663, contract: authorization.address, nonce: 4 }, { p: path, message: userOpHash }]);
  assert.equal(closes, 2);
});

test('local signer capabilities use the selected fixture account, with no production key loading', async () => {
  const configUrl = new URL('../src/config.ts', import.meta.url).href;
  const signersUrl = new URL('../src/signers.ts', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { privateKeyToAccount } from 'viem/accounts';
    import { recoverMessageAddress } from 'viem';
    import { recoverAuthorizationAddress } from 'viem/utils';
    const account = privateKeyToAccount('0x' + '1'.padStart(64, '0'));
    const other = privateKeyToAccount('0x' + '2'.padStart(64, '0'));
    mock.module(process.argv[1], { namedExports: { localAccount: async () => account } });
    const { loadSigner } = await import(process.argv[2]);
    const config = { mode:'private-key', wallet:account.address };
    const signer = await loadSigner(config);
    config.wallet = other.address; // Signer identity is captured when loaded.
    const authorization = { chainId:4663, address:other.address, nonce:4 };
    const hash = '0x' + 'ab'.repeat(32);
    assert.equal(await recoverAuthorizationAddress({authorization, signature:await signer.signAuthorization(authorization)}), account.address);
    assert.equal(await recoverMessageAddress({message:{raw:hash},signature:await signer.signMessageHash(hash)}), account.address);
    const mismatched = await loadSigner({...config,wallet:other.address});
    await assert.rejects(mismatched.signAuthorization(authorization), /differs/);
    await assert.rejects(mismatched.signMessageHash(hash), /differs/);
    console.log('fixture passed');
  `, configUrl, signersUrl], { cwd: new URL('..', import.meta.url), env: process.env, timeout: 15_000, maxBuffer: 50_000 });
  assert.match(stdout, /fixture passed/);
});
