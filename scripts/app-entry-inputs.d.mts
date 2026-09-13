import type { RoutedProfile } from './profile-routing.mjs';
export type RunnerInput = { preference: string; stop: string; legacy?: { runLock: string; config: string; status: string } };
export type AppEntryInput = { profile: RoutedProfile; input: RunnerInput | null; problem?: 'Running state inputs could not be verified.' };
export type AppEntryInputs = { version: 1; requestId: string; sessionId: string | null; entries: AppEntryInput[] };
export function captureAppEntryInputs(rootDir: string, requestId: string, sessionId?: string | null): Promise<AppEntryInputs>;
export function readAppEntryInputs(rootDir: string, requestId: string, sessionId?: string | null): Promise<AppEntryInputs | null>;
export function runnerInputMatches(dataDir: string, input: RunnerInput): Promise<boolean>;
