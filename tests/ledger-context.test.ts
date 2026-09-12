import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextModule, ContextModuleChainID } from '@ledgerhq/context-module';
import { buildLedgerContext } from '../src/ledger-onboarding.js';

type Options = ConstructorParameters<typeof import('@ledgerhq/context-module').ContextModuleBuilder>[0];
const ethereum = 'ethereum' as ContextModuleChainID;

function fixture() {
  let options: Options | undefined, selectedChain: ContextModuleChainID | undefined;
  const calls: string[] = [];
  const context = {
    marker: true,
    async getContexts() { assert.equal(this.marker, true); calls.push('contexts'); return []; },
    async getFieldContext() { assert.equal(this.marker, true); calls.push('field'); return {}; },
    async getTypedDataFilters() { assert.equal(this.marker, true); calls.push('typed'); return {}; },
    async report() { assert.fail('Reports must stay disabled with credentials'); },
    async signReport() { assert.fail('Reports must stay disabled with credentials'); },
  };
  class Builder {
    constructor(args: Options) { options = args; }
    setChain(chain: ContextModuleChainID) { selectedChain = chain; return this; }
    build() { return context as unknown as ContextModule; }
  }
  return { Builder, calls, options: () => options, chain: () => selectedChain };
}

test('runtime credential reaches the custom context without restoring signing reports', async () => {
  const f = fixture();
  const loggerFactory = (() => assert.fail('Fixture does not need a logger')) as NonNullable<Options['loggerFactory']>;
  const context = buildLedgerContext(f.Builder, ethereum, loggerFactory, 'synthetic.application-token');
  assert.equal(f.options()?.originToken, 'synthetic.application-token');
  assert.equal(f.options()?.loggerFactory, loggerFactory);
  assert.equal(f.chain(), ethereum);
  await context.getContexts({});
  await context.getFieldContext({}, 'fixture' as never);
  await context.getTypedDataFilters({} as never);
  await context.report({} as never);
  await context.signReport!({} as never);
  assert.deepEqual(f.calls, ['contexts', 'field', 'typed']);
});

test('no runtime credential leaves the SDK option absent', () => {
  assert.equal(process.env.LEDGER_ORIGIN_TOKEN, undefined, 'Isolated test launcher must remove host credentials');
  const f = fixture();
  buildLedgerContext(f.Builder, ethereum, undefined);
  assert.equal(Object.hasOwn(f.options()!, 'originToken'), false);
});

test('invalid credentials fail before building a context and never appear in errors', () => {
  for (const token of ['', ' ', 'secret\nheader', 'secret\rheader', 'secret\theader', 'secret key', 'secret\x00key', 'secret\x7fkey', 'secreté']) {
    const f = fixture();
    assert.throws(() => buildLedgerContext(f.Builder, ethereum, undefined, token), {
      message: 'LEDGER_ORIGIN_TOKEN must be a nonempty token without whitespace or control characters.',
    });
    assert.equal(f.options(), undefined);
  }
});
