type Transport = { destroy(): void };
type Listener = (...args: unknown[]) => void;
type Emitter = {
  rawListeners(event: string): Function[];
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
};
type OwnedListeners = { emitter: Emitter; event: string; listeners: Listener[] };
const lifecycleError = () => new Error('The pinned Ledger USB transport lifecycle is incompatible; USB access remains unavailable.');

/** Node HID 1.0.1 destroy() removes every listener from its shared USB emitter.
 * Adapt only this owned instance's emitted private stop method. The pinned CJS
 * method/controller shape is checked before use; no global or prototype method
 * is replaced, and foreign listeners are never removed or restored. */
export function ownLedgerTransport<T extends Transport>(create: () => T, usb: Emitter, exits: Emitter): T {
  const watched = [{ emitter: usb, event: 'attach' }, { emitter: usb, event: 'detach' },
    { emitter: exits, event: 'exit' }].map(item => ({ ...item, before: new Set(item.emitter.rawListeners(item.event)) }));
  const added = (): OwnedListeners[] => watched.map(({ emitter, event, before }) => ({ emitter, event,
    listeners: emitter.rawListeners(event).filter(listener => !before.has(listener)) as Listener[] }));
  const remove = (owned: OwnedListeners[]) => {
    for (const { emitter, event, listeners } of owned) for (const listener of listeners) emitter.removeListener(event, listener);
  };
  let transport: T;
  try { transport = create(); }
  catch (error) { remove(added()); throw error; }
  const owned = added();
  const internal = transport as unknown as { stopListeningToConnectionEvents?: unknown; _connectionListenersAbortController?: unknown };
  if (typeof transport.destroy !== 'function' || typeof internal.stopListeningToConnectionEvents !== 'function' ||
      !(internal._connectionListenersAbortController instanceof AbortController)) {
    remove(owned); throw lifecycleError();
  }
  const controller = internal._connectionListenersAbortController;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { controller.abort(); }
    finally { remove(owned); exits.removeListener('exit', stop); }
  };
  const destroy = transport.destroy.bind(transport);
  let destroyed = false;
  try {
    Object.defineProperty(transport, 'stopListeningToConnectionEvents', { value: stop, configurable: true, writable: true });
    Object.defineProperty(transport, 'destroy', { configurable: true, writable: true, value: () => {
      if (destroyed) return;
      destroyed = true;
      try { destroy(); } finally { stop(); }
    } });
    // The vendor exit callback also calls removeAllListeners(). Replace only
    // callbacks this constructor installed with our owned cleanup function.
    remove(owned.filter(item => item.event === 'exit'));
    exits.on('exit', stop);
  } catch {
    stop(); throw lifecycleError();
  }
  return transport;
}

/** Begin native teardown even if the SDK close rejects or never settles. */
export async function closeLedgerSdk(closeManager: () => void | Promise<void>, destroy: () => void): Promise<void> {
  let closing: Promise<void>;
  try { closing = Promise.resolve(closeManager()); }
  catch (error) { closing = Promise.reject(error); }
  let destroyFailed = false;
  try { destroy(); } catch { destroyFailed = true; }
  const [result] = await Promise.allSettled([closing]);
  if (destroyFailed || result!.status === 'rejected') throw new Error('Ledger USB cleanup failed. Disconnect the device before trying again.');
}
