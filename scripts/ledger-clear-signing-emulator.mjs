#!/usr/bin/env node
// Development-only public Speculos smoke test. No application or HID imports.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const SPECULOS_IMAGE = 'ghcr.io/ledgerhq/speculos@sha256:6ed9eefd51cddd862b746719af4cd7a3265fe43d0588c388359753cab8d46d11';
export const ETHEREUM_RELEASE = '1.22.3';
export const EMULATOR_APPS = Object.freeze({
  nanox: { file: 'app-1.22.3-nanox.elf', sha256: '47705998a0419df75959f46faf2c4a214846f61943fd15d3708b92caf2a3559f' },
  apex_p: { file: 'app-1.22.3-apex_p.elf', sha256: 'd55b73fa82a1ab8b63d9d57a6e4993e6236b8eb7f6dce78c5437e225e783b88d' },
});
const execute = promisify(execFile);
const digest = data => createHash('sha256').update(data).digest('hex');
async function docker(args, timeout = 90000) {
  // Do not pass wallet/provider credentials into child processes or containers.
  const env = Object.fromEntries(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  return (await execute('docker', args, { env, timeout, maxBuffer: 1024 * 1024 })).stdout.trim();
}
async function checkedDirectory(input, create) {
  if (!input || !isAbsolute(input)) throw new Error('--work-dir must be an explicit absolute temporary directory');
  // POSIX /tmp is independent of inherited TMPDIR, which may point at app storage.
  const aliases = [await realpath(process.platform === 'win32' ? tmpdir() : '/tmp')];
  const parent = await realpath(dirname(resolve(input)));
  if (!aliases.some(tmp => parent === tmp || (relative(tmp, parent) && !relative(tmp, parent).startsWith('..')))) throw new Error('--work-dir must be inside the operating-system temporary directory');
  if (create) await mkdir(input, { recursive: true, mode: 0o700 });
  const directory = await realpath(input);
  if (!aliases.some(tmp => directory !== tmp && !relative(tmp, directory).startsWith('..'))) throw new Error('Temporary work directory escapes its root');
  return directory;
}
async function verifyElf(path, model) {
  if (!(await lstat(path)).isFile()) throw new Error('The emulator ELF must be a regular file, not a symlink');
  const bytes = await readFile(path);
  if (digest(bytes) !== EMULATOR_APPS[model].sha256) throw new Error('The Ethereum ELF does not match the pinned public release checksum');
  return bytes;
}
async function json(url, init) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Emulator HTTP ${response.status}`);
  return response.json();
}
export async function emulatorCommand({ action, workDir, model = 'apex_p' }) {
  if (!['preflight', 'prepare', 'smoke'].includes(action)) throw new Error('Use preflight, prepare or smoke');
  if (!Object.hasOwn(EMULATOR_APPS, model)) throw new Error('Model must be nanox or apex_p');
  const directory = await checkedDirectory(workDir, action === 'prepare');
  const app = EMULATOR_APPS[model], elf = join(directory, app.file);
  const version = JSON.parse(await docker(['version', '--format', '{{json .}}'], 30000));
  if (!version.Server) throw new Error('Docker engine is unavailable');
  if (action === 'prepare') {
    let existing;
    try { existing = await verifyElf(elf, model); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing) {
      const url = `https://github.com/LedgerHQ/app-ethereum/releases/download/${ETHEREUM_RELEASE}/${app.file}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`Public ELF download HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (digest(bytes) !== app.sha256) throw new Error('Downloaded public ELF checksum mismatch');
      await writeFile(elf, bytes, { flag: 'wx', mode: 0o600 });
    }
    await docker(['pull', SPECULOS_IMAGE], 900000);
  }
  let appReady = false, imageReady = false;
  try { await verifyElf(elf, model); appReady = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await docker(['image', 'inspect', SPECULOS_IMAGE, '--format', '{{.Id}}'], 30000); imageReady = true; } catch { /* Report absent image separately. */ }
  const summary = { scope: 'public-test-emulator-only', model, ethereumVersion: ETHEREUM_RELEASE, image: SPECULOS_IMAGE, appSha256: app.sha256, appReady, imageReady, clearSigningVerified: false };
  if (action !== 'smoke') return summary;
  if (!appReady || !imageReady) throw new Error('Run prepare first; the pinned ELF and image are required');
  const runDirectory = await mkdtemp(join(directory, `${model}-run-`));
  const name = `rebalance-ledger-emulator-${randomUUID().slice(0, 8)}`;
  let containerId, failure;
  let phase = 'container creation';
  try {
    // Copy only the public ELF; no host directory, hardware or Docker socket mount.
    containerId = await docker(['create', '--name', name, '--label', 'rebalance.emulator=public-test-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--publish', '127.0.0.1::5000', SPECULOS_IMAGE, '--display', 'headless', '--api-port', '5000', '--model', model, '/speculos/rebalance-app.elf']);
    if (!/^[0-9a-f]{64}$/.test(containerId)) throw new Error('Docker did not return an exact container ID');
    phase = 'ELF copy';
    await docker(['cp', elf, `${containerId}:/speculos/rebalance-app.elf`]);
    phase = 'container start';
    await docker(['start', containerId]);
    phase = 'port lookup';
    const binding = JSON.parse(await docker(['inspect', containerId, '--format', '{{json .NetworkSettings.Ports}}']));
    const port = binding['5000/tcp']?.[0];
    if (port?.HostIp !== '127.0.0.1' || !/^\d+$/.test(port.HostPort)) throw new Error('Emulator API must bind only to loopback');
    const url = `http://127.0.0.1:${port.HostPort}`;
    phase = 'API readiness';
    let screen;
    for (let i = 0; i < 30; i++) {
      try { screen = await json(`${url}/events?currentscreenonly=true`); break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!screen) throw new Error('Speculos did not expose its API before the startup deadline');
    // Read app metadata only. This APDU cannot request a signature or modify settings.
    phase = 'app metadata';
    const config = await json(`${url}/apdu`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'b001000000' }) });
    const statusWord = typeof config.data === 'string' ? config.data.slice(-4) : undefined;
    if (statusWord !== '9000') throw new Error(`Emulator app metadata query failed (${statusWord || 'missing response'})`);
    phase = 'screenshot';
    const response = await fetch(`${url}/screenshot`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Emulator screenshot was unavailable');
    const screenshot = join(runDirectory, 'startup.png');
    await writeFile(screenshot, Buffer.from(await response.arrayBuffer()), { flag: 'wx', mode: 0o600 });
    const result = { ...summary, outcome: 'emulator-startup-verified', statusWord, screenTexts: (screen.events || []).map(event => event.text).filter(Boolean), screenshot };
    await writeFile(join(runDirectory, 'smoke.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } catch (error) {
    failure = new Error(`Emulator ${phase} failed: ${error.message}`);
    throw failure;
  } finally {
    if (containerId && /^[0-9a-f]{64}$/.test(containerId)) {
      try { await docker(['rm', '--force', containerId]); } catch {
        throw new Error(`${failure ? failure.message + '. ' : ''}Cleanup could not be confirmed for temporary container ${containerId}`);
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'work-dir': { type: 'string' }, model: { type: 'string' } } });
    if (positionals.length !== 1) throw new Error('Usage: node scripts/ledger-clear-signing-emulator.mjs preflight|prepare|smoke --work-dir /absolute/tmp/directory [--model nanox|apex_p]');
    console.log(JSON.stringify(await emulatorCommand({ action: positionals[0], workDir: values['work-dir'], model: values.model }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
