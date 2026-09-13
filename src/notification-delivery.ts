import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from './storage.js';

/** Public project preference, separate from portfolio settings and per-chat bindings. */
export const NOTIFICATION_PAUSE_FILE = 'notifications-paused.json';
export async function portfolioNotificationsEnabled(root: string): Promise<boolean> {
  try {
    const saved: unknown = JSON.parse(await readFile(resolve(root, NOTIFICATION_PAUSE_FILE), 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false;
    const record = saved as Record<string, unknown>;
    return record.version === 1 && record.paused === false &&
      Object.keys(record).every(key => key === 'version' || key === 'paused');
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}
export async function setPortfolioNotificationsPaused(root: string, paused: boolean): Promise<void> {
  if (typeof paused !== 'boolean') throw new Error('Notification pause preference must be boolean');
  await atomicWriteJson(resolve(root, NOTIFICATION_PAUSE_FILE), { version: 1, paused });
}
