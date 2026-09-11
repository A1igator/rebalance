import { parseTargets, percentToBps, validateTargets, type Config } from './config.js';

// A share code is a portfolio's strategy as plain text: its targets plus the
// drift trigger and cycle interval. It never carries the wallet, signer, RPC,
// slippage or holdings, and assets are symbols resolved through our own
// manifest, so a code cannot point the runner at a token address.
export const SHARE_PREFIX = 'rebalance:v1';
const MAX_LENGTH = 400;

type Strategy = Pick<Config, 'targets' | 'driftThresholdBps' | 'rebalanceIntervalSeconds'>;
export type SharedStrategy = { targets: Record<string, number>; driftThresholdBps?: number; rebalanceIntervalSeconds?: number };

/** The shortest percentage that percentToBps reads back to the same basis points. */
export function bpsToPercent(bps: number): string {
  const whole = Math.floor(bps / 100), fraction = bps % 100;
  return fraction ? `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}` : String(whole);
}

export function encodeShareCode(strategy: Strategy): string {
  const targets = Object.entries(strategy.targets).map(([id, bps]) => `${id}=${bpsToPercent(bps)}`).join(',');
  return `${SHARE_PREFIX} ${targets} drift=${bpsToPercent(strategy.driftThresholdBps)} interval=${strategy.rebalanceIntervalSeconds}`;
}

export function decodeShareCode(input: string): SharedStrategy {
  if (typeof input !== 'string' || input.length > MAX_LENGTH) throw new Error(`A share code is at most ${MAX_LENGTH} characters`);
  const [prefix, targets, ...fields] = input.trim().split(/\s+/);
  if (prefix !== SHARE_PREFIX || !targets) throw new Error(`A share code starts with ${SHARE_PREFIX} followed by ASSET=percent targets`);
  const strategy: SharedStrategy = { targets: parseTargets(targets) };
  validateTargets(strategy.targets);
  for (const field of fields) {
    const [key, value, extra] = field.split('=');
    if (!value || extra !== undefined) throw new Error('Share code settings use drift=<percent> and interval=<seconds>');
    if (key === 'drift' && strategy.driftThresholdBps === undefined) strategy.driftThresholdBps = percentToBps(value);
    else if (key === 'interval' && strategy.rebalanceIntervalSeconds === undefined) {
      if (!/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > 604800) throw new Error('Share code interval must be whole seconds from 1 to 604800');
      strategy.rebalanceIntervalSeconds = Number(value);
    } else throw new Error('Share code settings are drift and interval, each at most once');
  }
  return strategy;
}

/** What importing would change, in the same basis points as the saved config. */
export function sharePreview(config: Strategy, shared: SharedStrategy) {
  const assets = [...new Set([...Object.keys(config.targets), ...Object.keys(shared.targets)])];
  const untrackedAssets = Object.keys(config.targets).filter(id => !Object.hasOwn(shared.targets, id));
  return {
    shared: { targets: shared.targets, driftThresholdBps: shared.driftThresholdBps ?? null,
      rebalanceIntervalSeconds: shared.rebalanceIntervalSeconds ?? null },
    targetChanges: assets.filter(id => (config.targets[id] ?? 0) !== (shared.targets[id] ?? 0))
      .map(id => ({ asset: id, currentBps: config.targets[id] ?? 0, sharedBps: shared.targets[id] ?? 0 })),
    settingChanges: (['driftThresholdBps', 'rebalanceIntervalSeconds'] as const)
      .filter(name => shared[name] !== undefined && shared[name] !== config[name])
      .map(name => ({ setting: name, current: config[name], shared: shared[name]! })),
    untrackedAssets,
    // Dropping a symbol only stops tracking it; nothing sells the holding.
    ...(untrackedAssets.length ? { note: 'Holdings of untracked assets stay in the wallet; importing does not sell them.' } : {}),
  };
}
