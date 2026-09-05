import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type PendingTransaction = {
  chainId: 4663;
  wallet: string;
  hash: string;
  nonce: number;
  kind: "approval" | "swap" | "wrap";
  createdAt: string;
  status: "prepared" | "broadcast" | "unknown";
  message?: string;
};

type LockRecord = { pid: number; createdAt: string; token?: string };

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

export function stringifyJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item, 2);
  if (json === undefined) throw new TypeError("Value cannot be serialized as JSON");
  return `${json}\n`;
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Some filesystems/platforms do not expose directory fsync.
    if (hasCode(error, "EINVAL") || hasCode(error, "ENOTSUP") || hasCode(error, "EISDIR")) return;
    if (process.platform === "win32" && (hasCode(error, "EPERM") || hasCode(error, "EACCES"))) return;
    throw error;
  }
}

/** Commit a complete same-directory file, syncing it before the atomic rename. */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const json = stringifyJson(value);
  const directory = dirname(path);
  await ensureDirectory(directory);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(json, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(directory);
  } finally {
    await removeIfPresent(temporary);
  }
}

/** Only a missing file is suppressed; corrupt JSON and other I/O errors throw. */
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function readLock(path: string): Promise<LockRecord | null> {
  const value = await readJson<LockRecord>(path);
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 2_147_483_647 ||
    typeof value.createdAt !== "string" ||
    (value.token !== undefined && typeof value.token !== "string")
  ) {
    throw new Error(`Invalid lock record: ${path}`);
  }
  return value;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    if (hasCode(error, "EPERM")) return true;
    throw error;
  }
}

async function createLock(path: string, record: LockRecord): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  let written = false;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(stringifyJson(record), "utf8");
    await handle.sync();
    written = true;
  } finally {
    await handle.close();
    if (!written) await removeIfPresent(path);
  }
}

function releaseOwnedLock(path: string, token: string): () => Promise<void> {
  let release: Promise<void> | undefined;
  return () => release ??= (async () => {
    const current = await readLock(path);
    if (current?.token !== token) return;
    await removeIfPresent(path);
  })();
}

/** Exclusive per-directory process lock. A dead PID is the only reclaim signal. */
export async function acquireLock(
  directory: string,
  name = "run.lock",
): Promise<() => Promise<void>> {
  if (!name || name === "." || name === ".." || basename(name) !== name || name.includes("\\")) {
    throw new Error("Lock name must be a plain filename");
  }
  await ensureDirectory(directory);
  const path = join(directory, name);
  const token = randomUUID();
  const record = { pid: process.pid, createdAt: new Date().toISOString(), token };
  try {
    await createLock(path, record);
    return releaseOwnedLock(path, token);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }

  const existing = await readLock(path);
  if (existing && processIsAlive(existing.pid)) {
    throw new Error(`Lock ${name} is held by process ${existing.pid}`);
  }

  // Serialize stale cleanup so a second reclaimer cannot remove a new holder.
  // An interrupted cleanup guard is left for inspection, never guessed stale.
  const guardPath = `${path}.reclaim`;
  const guardToken = randomUUID();
  try {
    await createLock(guardPath, { ...record, token: guardToken });
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw new Error(`Lock cleanup is already pending: ${name}`);
    throw error;
  }
  const releaseGuard = releaseOwnedLock(guardPath, guardToken);
  try {
    const current = await readLock(path);
    if (current) {
      if (processIsAlive(current.pid)) throw new Error(`Lock ${name} is held by process ${current.pid}`);
      await removeIfPresent(path);
    }
    try {
      await createLock(path, record);
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw new Error(`Lock ${name} was acquired by another process`);
      throw error;
    }
    return releaseOwnedLock(path, token);
  } finally {
    await releaseGuard();
  }
}
