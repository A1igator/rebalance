import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SeedStore {
  /** Insert only. Existing items are never overwritten or deleted. */
  create(id: string, value: string): Promise<void>;
  /** Missing item only is null; locked, denied and invalid items throw. */
  read(id: string): Promise<string | null>;
}
export type KeychainCommand = (input: string) => Promise<string>;
const MAX_MESSAGE = 32768;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const messages = {
  duplicate: 'A Rebalance Keychain seed already exists; it was not replaced.',
  denied: 'macOS Keychain access was denied or the keychain is locked. Existing wallet data was not replaced.',
  unavailable: 'macOS Keychain is unavailable or timed out. Existing wallet data was not replaced.',
  invalid: 'The Rebalance Keychain request or response could not be verified.',
  test: 'Real macOS Keychain access is disabled for tests and temporary application data.',
  platform: 'New local wallets require macOS Keychain on this platform.',
} as const;
const failed = (code: keyof typeof messages) => new Error(messages[code]);
const validSecret = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 4096;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};
function canonical(path: string): string {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(canonical(dirname(path)), basename(path));
  }
  return realpathSync(path);
}
function temporary(path: string): boolean {
  return ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].some(root => inside(root, path)) ||
    /^\/(private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/.test(path);
}
/** No environment toggle can opt a test process into the real credential store. */
export function assertMacosKeychainEnvironment(environment = process.env, platform: string = process.platform, cwd = process.cwd()): void {
  if (environment.NODE_TEST_CONTEXT !== undefined) throw failed('test');
  const paths = [environment.REBALANCE_ROOT_DIR ?? resolve(cwd, '.local'), environment.REBALANCE_DATA_DIR ?? resolve(cwd, '.local')];
  try {
    for (const path of paths) if (temporary(resolve(cwd, path)) || temporary(canonical(resolve(cwd, path)))) throw failed('test');
  } catch { throw failed('test'); }
  if (platform !== 'darwin') throw failed('platform');
}

/** Fake commands can exercise the exact protocol without accessing the OS store. */
export function seedStoreWithCommand(command: KeychainCommand): SeedStore {
  async function request(operation: 'create' | 'read', id: string, value?: string): Promise<string | null | undefined> {
    if (typeof id !== 'string' || !idPattern.test(id) || (operation === 'create' && !validSecret(value))) throw failed('invalid');
    const input = JSON.stringify({ operation, id, ...(operation === 'create' ? { value } : {}) });
    if (Buffer.byteLength(input, 'utf8') > MAX_MESSAGE) throw failed('invalid');
    let output: string;
    try { output = await command(input); }
    catch { throw failed('unavailable'); }
    let response: unknown;
    try {
      if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_MESSAGE) throw failed('invalid');
      response = JSON.parse(output);
    } catch { throw failed('invalid'); }
    if (!record(response)) throw failed('invalid');
    if (response.ok === false && Object.keys(response).length === 2 && typeof response.error === 'string' &&
        ['duplicate', 'denied', 'unavailable', 'invalid'].includes(response.error)) throw failed(response.error as 'duplicate' | 'denied' | 'unavailable' | 'invalid');
    if (response.ok !== true) throw failed('invalid');
    if (operation === 'create') {
      if (Object.keys(response).length !== 1) throw failed('invalid');
      return;
    }
    if (Object.keys(response).length !== 2 || !Object.hasOwn(response, 'value') || (response.value !== null && !validSecret(response.value))) throw failed('invalid');
    return response.value as string | null;
  }
  return { create: async (id, value) => { await request('create', id, value); }, read: async id => await request('read', id) as string | null };
}

function privateCommand(executable: string, args: string[], input: string | undefined, timeout: number): Promise<string> {
  return new Promise((accept, reject) => {
    // No inherited credentials or user-supplied executable arguments. stdin/stdout
    // are private pipes; stderr is always discarded and never included in errors.
    const child = execFile(executable, args, { timeout, maxBuffer: MAX_MESSAGE,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: userInfo().homedir },
      encoding: 'utf8', killSignal: 'SIGKILL', windowsHide: true }, (error, stdout) => {
      if (error) reject(failed('unavailable'));
      else accept(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
async function ownedDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failed('unavailable');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error;
    await ownedDirectory(parent);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (created) { if ((created as NodeJS.ErrnoException).code !== 'EEXIST') throw created; }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failed('unavailable');
  }
}
async function privateBinary(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== userInfo().uid || (info.mode & 0o077) || !(info.mode & 0o100)) throw failed('unavailable');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
let build: Promise<string> | undefined;
async function helper(): Promise<string> {
  assertMacosKeychainEnvironment();
  const nativeSource = fileURLToPath(new URL('../native/keychain.swift', import.meta.url));
  const source = await open(nativeSource, constants.O_RDONLY | constants.O_NOFOLLOW);
  let fingerprint: string;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size > 65536) throw failed('unavailable');
    fingerprint = createHash('sha256').update(await source.readFile()).digest('hex');
  } finally { await source.close(); }
  const directory = join(userInfo().homedir, 'Library', 'Application Support', 'Rebalance', 'native');
  await ownedDirectory(directory);
  for (const path of [dirname(directory), directory]) {
    const info = await lstat(path);
    if (info.uid !== userInfo().uid || (info.mode & 0o077)) throw failed('unavailable');
  }
  const binary = join(directory, `keychain-helper-${fingerprint}`);
  if (await privateBinary(binary)) return binary;
  const temporaryBinary = join(directory, `.keychain-build-${process.pid}-${randomUUID()}`);
  try {
    await privateCommand('/usr/bin/xcrun', ['swiftc', '-O', '-framework', 'Security', nativeSource, '-o', temporaryBinary], undefined, 120000);
    await chmod(temporaryBinary, 0o700);
    if (!await privateBinary(temporaryBinary)) throw failed('unavailable');
    await rename(temporaryBinary, binary);
    return binary;
  } finally { await unlink(temporaryBinary).catch(() => {}); }
}
/** Production entry point: no fake-store fallback and no file-key fallback. */
export function macosSeedStore(): SeedStore {
  assertMacosKeychainEnvironment();
  return seedStoreWithCommand(async input => {
    assertMacosKeychainEnvironment();
    build ??= helper().catch(error => { build = undefined; throw error; });
    const executable = await build;
    assertMacosKeychainEnvironment();
    return privateCommand(executable, [], input, 30000);
  });
}
