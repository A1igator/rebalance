import { tap } from 'rxjs';
import type { LedgerAddressAction } from './ledger-onboarding.js';

export type LedgerPhase = 'connect' | 'account-binding' | 'anchor-read' | 'account-read' | 'sign' | 'final-anchor-read' | 'signature-validation' | 'cleanup';
export type LedgerDiagnostic = { phase: LedgerPhase; elapsedMs: number; status?: string; step?: string;
  interaction?: string; errorTag?: string; deviceCode?: string; httpStatus?: number; networkTimeout?: boolean };
const STEPS = new Set(['openApp', 'getAppConfig', 'getAddress', 'web3ChecksOptIn', 'web3ChecksOptInResult',
  'parseTransaction', 'buildContexts', 'provideContexts', 'signTransaction', 'blindSignTransactionFallback', 'detectBlindSigning']
  .map(step => `signer.eth.steps.${step}`).concat(['os.callTaskInApp.steps.callTask']));
const INTERACTIONS = new Set(['none', 'unlock-device', 'allow-secure-connection', 'confirm-open-app',
  'sign-transaction', 'verify-address', 'web3-checks-opt-in']);
const TAGS = new Set(['RefusedByUserDAError', 'EthAppCommandError', 'SendApduTimeoutError', 'SendCommandTimeoutError',
  'SendApduConcurrencyError', 'SendApduEmptyResponseError', 'DeviceNotInitializedError', 'NoAccessibleDeviceError',
  'OpeningConnectionError', 'UnknownDeviceError', 'DeviceNotRecognizedError', 'DisconnectError',
  'ReconnectionFailedError', 'DeviceDisconnectedWhileSendingError', 'AlreadySendingApduError',
  'DeviceDisconnectedBeforeSendingApdu', 'DmkNetworkClientError']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

/** Fixed public fields only: no SDK messages, URLs, context, transaction bytes or signatures. */
export class LedgerDiagnostics {
  private started = Date.now();
  private value: LedgerDiagnostic = { phase: 'connect', elapsedMs: 0 };
  phase(phase: LedgerPhase) { this.started = Date.now(); this.value = { phase, elapsedMs: 0 }; }
  error(error: unknown) {
    const seen = new Set<object>();
    let current = error;
    try {
      for (let depth = 0; depth < 6 && object(current) && !seen.has(current); depth++) {
        seen.add(current);
        const tag = current._tag ?? current.name;
        if (typeof tag === 'string' && TAGS.has(tag)) this.value.errorTag = tag;
        const raw = current.errorCode;
        const code = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 65535
          ? raw.toString(16).padStart(4, '0')
          : typeof raw === 'string' && /^(?:0x)?[0-9a-fA-F]{4}$/.test(raw) ? raw.replace(/^0x/, '').toLowerCase() : undefined;
        if (code) this.value.deviceCode = `0x${code}`;
        if (tag === 'DmkNetworkClientError') {
          if (Number.isInteger(current.status) && Number(current.status) >= 100 && Number(current.status) <= 599) this.value.httpStatus = Number(current.status);
          if (typeof current.isTimeout === 'boolean') this.value.networkTimeout = current.isTimeout;
        }
        current = current.originalError ?? current.cause;
      }
    } catch { /* Malformed diagnostics cannot affect the signing decision. */ }
  }
  observe(action: LedgerAddressAction): LedgerAddressAction {
    return { cancel: () => action.cancel(), observable: action.observable.pipe(tap({
      next: state => {
        if (['not-started', 'pending', 'completed', 'error', 'stopped'].includes(state.status)) this.value.status = state.status;
        const pending = state.intermediateValue;
        if (object(pending)) {
          if (typeof pending.step === 'string' && STEPS.has(pending.step)) this.value.step = pending.step;
          if (typeof pending.requiredUserInteraction === 'string' && INTERACTIONS.has(pending.requiredUserInteraction)) this.value.interaction = pending.requiredUserInteraction;
        }
        if (state.status === 'error') this.error(state.error);
      }, error: error => this.error(error),
    })) };
  }
  snapshot(error?: unknown): LedgerDiagnostic {
    this.error(error);
    return { ...this.value, elapsedMs: Math.max(0, Date.now() - this.started) };
  }
}
