import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getAddress, isAddress, zeroAddress, type Address } from 'viem';

export type PaymasterConfig = { provider: 'alchemy'; token: 'USDG'; policyId: string; paymaster: Address };
export function validatePaymasterConfig(value: unknown): PaymasterConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid USDG paymaster configuration');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'paymaster,policyId,provider,token' || v.provider !== 'alchemy' || v.token !== 'USDG' ||
      typeof v.policyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.policyId) ||
      typeof v.paymaster !== 'string' || !isAddress(v.paymaster, { strict: false }) || v.paymaster.toLowerCase() === zeroAddress) {
    throw new Error('Use Alchemy, canonical USDG, a policy UUID and the verified paymaster address');
  }
  return { provider: 'alchemy', token: 'USDG', policyId: v.policyId.toLowerCase(), paymaster: getAddress(v.paymaster) };
}
export const providerKeyPath = () => resolve(process.env.REBALANCE_ROOT_DIR || '.local', 'alchemy-api-key');
const validKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value);
export async function providerKey(): Promise<string> {
  const supplied = process.env.REBALANCE_ALCHEMY_API_KEY;
  if (supplied !== undefined) {
    if (!validKey(supplied)) throw new Error('The local Alchemy API credential is invalid');
    return supplied;
  }
  let file;
  try {
    file = await open(providerKeyPath(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > 512) throw new Error();
    // A concurrent replacement/growth cannot make a credential read unbounded.
    const bytes = Buffer.alloc(513); let length = 0;
    while (length < bytes.length) {
      const next = await file.read(bytes, length, bytes.length - length, null);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    if (length > 512) throw new Error();
    const key = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, length)).trim();
    if (!validKey(key)) throw new Error();
    return key;
  } catch { throw new Error('Alchemy is not configured. Add its API key using local paymaster setup; never paste it into chat.'); }
  finally { await file?.close().catch(() => {}); }
}
/** Used by the local-only setup prompt; no secret is returned or logged. */
export async function saveProviderKey(key: string): Promise<void> {
  if (!validKey(key)) throw new Error('Invalid Alchemy API key');
  let file;
  try {
    const root = resolve(process.env.REBALANCE_ROOT_DIR || '.local');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error();
    // An existing credential is never overwritten by a repeated setup click.
    file = await open(providerKeyPath(), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(key + '\n'); await file.sync();
  } catch { throw new Error('The Alchemy credential was not saved. Use an owner-only local directory without an existing credential.'); }
  finally { await file?.close().catch(() => {}); }
}
