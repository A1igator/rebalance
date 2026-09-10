import type { PendingTransaction } from './storage.js';
const uint = (v: unknown) => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 2n ** 256n;
export function validatePaymasterPending(p: PendingTransaction): void {
  const u = p.userOperation;
  if (p.transport !== 'alchemy-usdg' || p.kind === 'wrap' || !Number.isFinite(Date.parse(p.createdAt)) || !u || !/^0x[0-9a-fA-F]{40}$/.test(u.paymaster) ||
      !uint(u.userOperationNonce) || !uint(u.submittedAtBlock) || !uint(u.maxTokenAmount) ||
      typeof u.callId !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(u.callId) ||
      (u.scanFromBlock !== undefined && (!uint(u.scanFromBlock) || BigInt(u.scanFromBlock) < BigInt(u.submittedAtBlock)))) {
    throw new Error('Invalid pending USDG user operation; preserve its receipt barrier');
  }
}

export class PaymasterBalanceError extends Error {
  constructor(readonly reserve: bigint, readonly balance: bigint) { super('USDG is needed for network fees; fund this wallet with USDG before rebalancing.'); }
}
