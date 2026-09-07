/** A profile pins its own listener before loading commands or spawning children. */
export function chartPort(value: string | undefined = process.env.REBALANCE_CHART_PORT): number {
  if (value === undefined) return 4663;
  const port = Number(value);
  if (!/^[1-9][0-9]{0,4}$/.test(value) || String(port) !== value || port > 65_535) {
    throw new Error('REBALANCE_CHART_PORT must be an integer from 1 through 65535.');
  }
  return port;
}

export function chartUrl(port = chartPort()): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid chart port.');
  return `http://127.0.0.1:${port}`;
}
