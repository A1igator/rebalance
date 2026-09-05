import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { acquireLock, atomicWriteJson, readJson, stringifyJson } from "../src/storage.js";

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rebalance-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const deadPid = 2_147_483_647;
const stale = { pid: deadPid, createdAt: "2000-01-01T00:00:00.000Z", token: "stale-owner" };
const execFileAsync = promisify(execFile);

test("JSON serialization preserves bigint integers as decimal strings", () => {
  const value = 2n ** 100n + 1n;
  assert.deepEqual(JSON.parse(stringifyJson({ amount: value, list: [0n, -3n] })), {
    amount: value.toString(), list: ["0", "-3"],
  });
  assert.throws(() => stringifyJson(undefined), /cannot be serialized/);
});

test("atomic JSON writes create private directories/files and replace complete content", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, "nested", ".local");
  const file = join(directory, "pending.json");
  await atomicWriteJson(file, { amount: 42n, status: "prepared" });
  assert.deepEqual(await readJson(file), { amount: "42", status: "prepared" });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await atomicWriteJson(file, { status: "broadcast" });
  assert.deepEqual(await readJson(file), { status: "broadcast" });
  assert.deepEqual(await readdir(directory), ["pending.json"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("serialization failure leaves the previous durable record intact", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "state.json");
  await atomicWriteJson(file, { previous: true });
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(atomicWriteJson(file, circular), /circular/i);
  assert.deepEqual(await readJson(file), { previous: true });
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

test("readJson returns null for missing files but surfaces corrupt JSON and I/O errors", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "state.json");
  assert.equal(await readJson(file), null);
  await writeFile(file, '{"incomplete":');
  await assert.rejects(readJson(file), SyntaxError);
  await assert.rejects(readJson(directory));
});

test("concurrent replacements are always complete JSON documents", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "state.json");
  await atomicWriteJson(file, { writer: -1, body: "initial" });
  const writes = Promise.all(Array.from({ length: 12 }, (_, writer) =>
    atomicWriteJson(file, { writer, body: String(writer).repeat(2_000) })));
  for (let i = 0; i < 30; i += 1) {
    const content = await readJson<{ writer: number; body: string }>(file);
    assert.ok(content);
    assert.equal(content.body, content.writer === -1 ? "initial" : String(content.writer).repeat(2_000));
  }
  await writes;
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

test("same-PID and concurrent acquisition are exclusive; release is idempotent", async (t) => {
  const directory = await temporaryDirectory(t);
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquireLock(directory)));
  const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
  assert.equal(winners.length, 1);
  const release = winners[0]!.value;
  const file = join(directory, "run.lock");
  assert.equal((await readJson<{ pid: number }>(file))!.pid, process.pid);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(acquireLock(directory), /held by process/);
  await Promise.all([release(), release()]);
  const nextRelease = await acquireLock(directory);
  await release();
  assert.ok(await readJson(file));
  await nextRelease();
  assert.equal(await readJson(file), null);
});

test("a dead PID can be reclaimed by exactly one concurrent acquirer", async (t) => {
  const directory = await temporaryDirectory(t);
  await atomicWriteJson(join(directory, "run.lock"), stale);
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquireLock(directory)));
  const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
  assert.equal(winners.length, 1);
  const current = await readJson<{ pid: number; token: string }>(join(directory, "run.lock"));
  assert.equal(current!.pid, process.pid);
  assert.notEqual(current!.token, stale.token);
  await winners[0]!.value();
  assert.deepEqual(await readdir(directory), []);
});

test("a separate process cannot acquire the lock until its owner releases it", async (t) => {
  const directory = await temporaryDirectory(t);
  const release = await acquireLock(directory);
  const script = `
    const { acquireLock } = await import(process.argv[1]);
    try {
      const release = await acquireLock(process.argv[2]);
      await release();
      process.stdout.write("acquired");
    } catch (error) {
      process.stdout.write(error.message);
    }
  `;
  const args = ["--import", "tsx", "--input-type=module", "-e", script, "--",
    new URL("../src/storage.ts", import.meta.url).href, directory];
  const blocked = await execFileAsync(process.execPath, args);
  assert.match(blocked.stdout, new RegExp(`held by process ${process.pid}`));
  await release();
  const acquired = await execFileAsync(process.execPath, args);
  assert.equal(acquired.stdout, "acquired");
});

test("EPERM means alive and does not permit reclaim", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "run.lock");
  await atomicWriteJson(file, stale);
  t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
  });
  await assert.rejects(acquireLock(directory), /held by process/);
  assert.deepEqual(await readJson(file), stale);
});

test("release checks ownership before deleting and named locks are independent", async (t) => {
  const directory = await temporaryDirectory(t);
  const releaseRun = await acquireLock(directory);
  const releaseConfig = await acquireLock(directory, "config.lock");
  await assert.rejects(acquireLock(directory, "config.lock"), /held by process/);
  const file = join(directory, "run.lock");
  const replaced = { pid: process.pid, createdAt: new Date().toISOString(), token: "different-owner" };
  await atomicWriteJson(file, replaced);
  await releaseRun();
  assert.deepEqual(await readJson(file), replaced);
  await releaseConfig();
  assert.equal(await readJson(join(directory, "config.lock")), null);
  await assert.rejects(acquireLock(directory, "../outside.lock"), /plain filename/);
});

test("malformed locks and interrupted cleanup remain unresolved instead of being removed", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "run.lock");
  await writeFile(file, "incomplete");
  await assert.rejects(acquireLock(directory), SyntaxError);
  assert.equal(await readFile(file, "utf8"), "incomplete");
  await atomicWriteJson(file, { pid: 0, createdAt: "invalid" });
  await assert.rejects(acquireLock(directory), /Invalid lock/);
  await atomicWriteJson(file, stale);
  await atomicWriteJson(`${file}.reclaim`, stale);
  await assert.rejects(acquireLock(directory), /cleanup is already pending/);
  assert.deepEqual(await readJson(file), stale);
});
