import { resolve } from 'node:path';
import { DATA, type Config } from './config.js';
import { type RebalanceCycle } from './cadence.js';
import { copyRebalanceInputLimits, type RebalanceInputLimits, type RebalancePlan } from './core.js';
import { ledgerConfigFingerprint } from './ledger-request.js';
import { atomicWriteJson, readJson } from './storage.js';
import type { Operation } from './transactions.js';

export const BATCH_INPUTS_PATH = resolve(DATA, 'batch-inputs.json');
type PreparedBatch = {
  version: 1; wallet: string; chainId: 4663; configFingerprint: string;
  cycleStartedAt: string; lastConfirmedSwapHash: string | null;
  inputs: Record<string, string>;
};
const hash = /^0x[0-9a-f]{64}$/;
const invalid = () => new Error('Invalid prepared rebalance inputs; preserve the record for inspection.');

function confirmedSwap(config: Config, operation: Operation | null): string | null {
  return operation?.status === 'confirmed' && operation.kind === 'swap' && operation.chainId === config.chainId &&
    operation.wallet?.toLowerCase() === config.wallet.toLowerCase() && typeof operation.hash === 'string' && hash.test(operation.hash.toLowerCase())
    ? operation.hash.toLowerCase() : null;
}

async function matching(config: Config, cycle: RebalanceCycle | null, operation: Operation | null) {
  const record = await readJson<PreparedBatch>(BATCH_INPUTS_PATH);
  if (!record) return null;
  if (record.version !== 1 || record.chainId !== 4663 || typeof record.wallet !== 'string' || !/^0x[0-9a-f]{40}$/.test(record.wallet) ||
      typeof record.configFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.configFingerprint) ||
      typeof record.cycleStartedAt !== 'string' || !Number.isFinite(Date.parse(record.cycleStartedAt)) ||
      (record.lastConfirmedSwapHash !== null && (typeof record.lastConfirmedSwapHash !== 'string' || !hash.test(record.lastConfirmedSwapHash))) ||
      !record.inputs || typeof record.inputs !== 'object' || Array.isArray(record.inputs) ||
      Object.entries(record.inputs).some(([id, value]) => !/^[A-Z][A-Z0-9]{0,15}$/.test(id) || typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) >= 2n ** 256n)) throw invalid();
  const now = Date.now();
  const swap = confirmedSwap(config, operation);
  if (!cycle || cycle.startedAt !== record.cycleStartedAt || now < Date.parse(cycle.startedAt) || now >= Date.parse(cycle.activeUntil) ||
      record.wallet !== config.wallet.toLowerCase() || record.configFingerprint !== ledgerConfigFingerprint(config) ||
      (swap !== null && swap !== record.lastConfirmedSwapHash)) return null;
  const inputs = copyRebalanceInputLimits(Object.fromEntries(Object.entries(record.inputs).map(([id, value]) => [id, BigInt(value)])), Object.keys(config.targets))!;
  return { record, inputs };
}

/** Public amount maxima only, never saved prices or calldata. An approval receipt
 * or process restart keeps these bounds; a new successful swap begins a new batch. */
export async function readBatchInputLimits(config: Config, cycle: RebalanceCycle | null, operation: Operation | null): Promise<RebalanceInputLimits | undefined> {
  return (await matching(config, cycle, operation))?.inputs;
}

/** Caller holds run.lock and the current-config write boundary. Persist before
 * signing every prepared transaction, tightening even when quotes shrink first. */
export async function retainBatchInputs(config: Config, cycle: RebalanceCycle, operation: Operation | null, plan: RebalancePlan): Promise<void> {
  const current = await matching(config, cycle, operation);
  const inputs: Record<string, bigint> = {};
  if (!plan || !Array.isArray(plan.trades) || plan.trades.length < 1 || plan.trades.length > 4) throw invalid();
  for (const trade of plan.trades) {
    if (!trade || !Object.hasOwn(config.targets, trade.sellAssetId) || typeof trade.amountIn !== 'bigint' || trade.amountIn <= 0n) throw invalid();
    const total = (inputs[trade.sellAssetId] ?? 0n) + trade.amountIn;
    if (total >= 2n ** 256n || (current && total > (current.inputs[trade.sellAssetId] ?? 0n))) throw invalid();
    inputs[trade.sellAssetId] = total;
  }
  const record: PreparedBatch = { version: 1, wallet: config.wallet.toLowerCase(), chainId: config.chainId,
    configFingerprint: ledgerConfigFingerprint(config), cycleStartedAt: cycle.startedAt,
    lastConfirmedSwapHash: current?.record.lastConfirmedSwapHash ?? confirmedSwap(config, operation),
    inputs: Object.fromEntries(Object.entries(inputs).map(([id, value]) => [id, value.toString()])) };
  await atomicWriteJson(BATCH_INPUTS_PATH, record);
}
