import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const script = await import(new URL('../scripts/ledger-clear-signing-emulator.mjs', import.meta.url).href);
const repository = fileURLToPath(new URL('../', import.meta.url));

test('emulator rejects application paths even when inherited TMPDIR points there', async () => {
  const before = process.env.TMPDIR;
  try {
    process.env.TMPDIR = repository;
    await assert.rejects(script.emulatorCommand({ action: 'smoke', workDir: repository }), /temporary directory/);
    await assert.rejects(script.emulatorCommand({ action: 'prepare', workDir: 'relative' }), /absolute temporary/);
  } finally {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
  }
});

test('emulator pins both model binaries and image digest to the provenance manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../clear-signing/emulator/manifest.json', import.meta.url), 'utf8'));
  assert.equal(script.SPECULOS_IMAGE, manifest.speculos.image);
  assert.equal(script.ETHEREUM_RELEASE, manifest.ethereumApp.version);
  for (const model of ['nanox', 'apex_p']) assert.deepEqual(script.EMULATOR_APPS[model], manifest.ethereumApp[model]);
  await assert.rejects(script.emulatorCommand({ action: 'smoke', workDir: '/tmp', model: 'physical-ledger' }), /Model must/);
  await assert.rejects(script.emulatorCommand({ action: 'sign', workDir: '/tmp' }), /preflight, prepare or smoke/);
});
