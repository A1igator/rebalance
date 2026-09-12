import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Subject } from 'rxjs';
import { watchLedgerPresence, type LedgerSdk } from '../src/ledger-onboarding.js';

function fixture() {
  const devices = new Subject<readonly unknown[]>();
  const changes: { connected: boolean; observed: boolean }[] = [];
  const sdk: LedgerSdk = {
    manager: { listenToAvailableDevices: () => devices,
      async connect() { assert.fail('Discovery must not open hardware'); },
      async disconnect() { assert.fail('Discovery owns no session'); }, async close() {} },
    signer() { assert.fail('Discovery must not create a signer'); },
  };
  const close = watchLedgerPresence((connected, observed) => changes.push({ connected, observed }), { loadSdk: () => sdk });
  return { devices, changes, close };
}

test('only actual discovery absence establishes a disconnect; errors and multiple devices do not', async () => {
  const f = fixture();
  f.devices.next([{}]); f.devices.next([{}, {}]); f.devices.next([]); f.devices.next([]);
  f.devices.error(new Error('private SDK details'));
  await f.close();
  assert.deepEqual(f.changes, [
    { connected: true, observed: true }, { connected: false, observed: false },
    { connected: false, observed: true }, { connected: false, observed: false },
  ]);
});

test('discovery startup and completion errors cannot manufacture a physical disconnect', async () => {
  const startup: unknown[] = [];
  await watchLedgerPresence((connected, observed) => startup.push({ connected, observed }),
    { loadSdk: () => { throw new Error('private load details'); } })();
  assert.deepEqual(startup, [{ connected: false, observed: false }]);
  const f = fixture(); f.devices.next([{}]); f.devices.complete(); await f.close();
  assert.deepEqual(f.changes, [{ connected: true, observed: true }, { connected: false, observed: false }]);
});


test('terminated discovery reports unavailability after cleanup, while normal disposal does not request restart', async () => {
  for (const end of ['error', 'complete', 'load', 'dispose']) {
    const devices = new Subject<readonly unknown[]>();
    let closes = 0, unavailable = 0;
    const sdk: LedgerSdk = {
      manager: { listenToAvailableDevices: () => devices,
        async connect() { assert.fail('No hardware connection'); }, async disconnect() {},
        async close() { closes++; } }, signer() { assert.fail('No signer'); },
    };
    const close = watchLedgerPresence(() => {}, { loadSdk: () => {
      if (end === 'load') throw new Error('fixture load failure');
      return sdk;
    } }, () => { unavailable++; assert.equal(closes, end === 'load' ? 0 : 1); });
    if (end === 'error') devices.error(new Error('fixture discovery failure'));
    if (end === 'complete') devices.complete();
    await close(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(unavailable, end === 'dispose' ? 0 : 1);
  }
});


test('the initial Node HID empty subject value cannot manufacture a disconnect before discovering a connected device', async () => {
  const f = fixture();
  f.devices.next([]); f.devices.next([]); f.devices.next([{}]);
  assert.deepEqual(f.changes, [{ connected: false, observed: false }, { connected: true, observed: true }]);
  f.devices.next([]); f.devices.next([{}]);
  assert.deepEqual(f.changes.slice(2), [{ connected: false, observed: true }, { connected: true, observed: true }]);
  await f.close();
});
