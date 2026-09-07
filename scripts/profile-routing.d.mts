export type RoutedProfile = { wallet: string | null; chainId: 4663; directory: string; dataDir: string; rootDir: string; chartPort: number };
export function walletIdentity(value: unknown): string;
export function portfolioRoot(env?: NodeJS.ProcessEnv, repository?: string): string;
export function sessionIdentity(explicit?: string, env?: NodeJS.ProcessEnv): string | undefined;
export function connectionPath(root: string, sessionId: string): string;
export function readRoutingJson(path: string): Promise<any>;
export function validateProfileDirectory(root: string, directory: string): Promise<void>;
export function readProfiles(root: string): Promise<RoutedProfile[]>;
export function resolveProfile(root: string, options?: { wallet?: string; sessionId?: string }): Promise<RoutedProfile>;
