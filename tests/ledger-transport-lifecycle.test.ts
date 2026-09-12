import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { closeLedgerSdk, ownLedgerTransport } from '../src/ledger-transport-lifecycle.js';

// Deliberately reproduce only the pinned CJS lifecycle shape. These fixtures
// never import a USB/HID native module, enumerate a device or construct a DMK.
function fixture() {
  const usb = new EventEmitter(), exits = new EventEmitter();
  const make = () => {
    const state = { attach: 0, detach: 0, destroys: 0, closed: 0 };
    const transport = {
      _connectionListenersAbortController: new AbortController(),
      stopListeningToConnectionEvents() {
        this._connectionListenersAbortController.abort(); usb.removeAllListeners();
      },
      destroy() { state.destroys++; this.stopListeningToConnectionEvents(); state.closed++; },
    };
    usb.on('attach', () => state.attach++); usb.on('detach', () => state.detach++);
    exits.on('exit', () => usb.removeAllListeners());
    return { transport, state };
  };
  return { usb, exits, make };
}

test('closing a signer preserves monitor and foreign hotplug callbacks, with idempotent owned teardown', () => {
  const f = fixture();
  const foreign = () => {};
  f.usb.on('attach', foreign); f.usb.on('detach', foreign); f.exits.on('exit', foreign);
  let monitor!: ReturnType<typeof f.make>, signer!: ReturnType<typeof f.make>;
  ownLedgerTransport(() => (monitor = f.make()).transport, f.usb, f.exits);
  const before = { attach: f.usb.rawListeners('attach'), detach: f.usb.rawListeners('detach'), exit: f.exits.rawListeners('exit') };
  ownLedgerTransport(() => (signer = f.make()).transport, f.usb, f.exits);
  signer.transport.destroy(); signer.transport.destroy();
  assert.equal(signer.state.destroys, 1); assert.equal(signer.state.closed, 1);
  assert.equal(signer.transport._connectionListenersAbortController.signal.aborted, true);
  assert.deepEqual(f.usb.rawListeners('attach'), before.attach);
  assert.deepEqual(f.usb.rawListeners('detach'), before.detach);
  assert.deepEqual(f.exits.rawListeners('exit'), before.exit);
  f.usb.emit('detach'); f.usb.emit('attach');
  assert.equal(monitor.state.attach, 1); assert.equal(monitor.state.detach, 1);
  assert.equal(signer.state.attach, 0); assert.equal(signer.state.detach, 0);
  monitor.transport.destroy();
  assert.deepEqual(f.usb.rawListeners('attach'), [foreign]); assert.deepEqual(f.usb.rawListeners('detach'), [foreign]);
  assert.deepEqual(f.exits.rawListeners('exit'), [foreign]);
});

test('the owned exit hook never runs vendor global listener removal', () => {
  const f = fixture(), foreign = () => {};
  f.usb.on('attach', foreign); f.usb.on('detach', foreign);
  let item!: ReturnType<typeof f.make>;
  ownLedgerTransport(() => (item = f.make()).transport, f.usb, f.exits);
  f.exits.emit('exit', 0);
  assert.deepEqual(f.usb.rawListeners('attach'), [foreign]); assert.deepEqual(f.usb.rawListeners('detach'), [foreign]);
  assert.equal(f.exits.listenerCount('exit'), 0);
  item.transport.destroy(); assert.equal(item.state.closed, 1);
});

test('partial construction, incompatible shape and non-writable seam clean up only newly installed callbacks', () => {
  for (const failure of ['constructor', 'shape', 'frozen']) {
    const f = fixture(), foreign = () => {};
    f.usb.on('attach', foreign); f.usb.on('detach', foreign); f.exits.on('exit', foreign);
    assert.throws(() => ownLedgerTransport(() => {
      const { transport } = f.make();
      if (failure === 'constructor') throw new Error('fixture constructor failure');
      if (failure === 'shape') Object.defineProperty(transport, '_connectionListenersAbortController', { value: null });
      if (failure === 'frozen') Object.freeze(transport);
      return transport;
    }, f.usb, f.exits));
    assert.deepEqual(f.usb.rawListeners('attach'), [foreign]); assert.deepEqual(f.usb.rawListeners('detach'), [foreign]);
    assert.deepEqual(f.exits.rawListeners('exit'), [foreign]);
  }
});

for (const outcome of ['success', 'reject', 'throw', 'destroy-throw']) {
  test(`SDK close ${outcome} still tears down only its owned transport`, async () => {
    const f = fixture(), foreign = () => {};
    f.usb.on('attach', foreign); f.exits.on('exit', foreign);
    const transport = ownLedgerTransport(() => f.make().transport, f.usb, f.exits);
    let calls = 0;
    const closing = closeLedgerSdk(() => {
      calls++;
      if (outcome === 'throw') throw new Error('private fixture error');
      if (outcome === 'reject') return Promise.reject(new Error('private fixture error'));
      transport.destroy(); // DMK may also destroy it while closing.
    }, () => { transport.destroy(); if (outcome === 'destroy-throw') throw new Error('private fixture error'); });
    if (outcome === 'success') await closing;
    else await assert.rejects(closing, error => error instanceof Error && error.message ===
      'Ledger USB cleanup failed. Disconnect the device before trying again.');
    assert.equal(calls, 1); assert.deepEqual(f.usb.rawListeners('attach'), [foreign]);
    assert.deepEqual(f.exits.rawListeners('exit'), [foreign]);
  });
}

test('an unsettled SDK close begins owned transport teardown immediately', async () => {
  const f = fixture(), foreign = () => {};
  f.usb.on('attach', foreign);
  const transport = ownLedgerTransport(() => f.make().transport, f.usb, f.exits);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const closing = closeLedgerSdk(() => pending, () => transport.destroy());
  assert.deepEqual(f.usb.rawListeners('attach'), [foreign]);
  assert.equal(f.exits.listenerCount('exit'), 0);
  finish(); await closing;
});
