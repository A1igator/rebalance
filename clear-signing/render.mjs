import { readdir, readFile } from 'node:fs/promises';
import { format } from '@ethereum-sourcify/clear-signing';
import { tokens, wallet, chainId } from './fixtures.mjs';

/** Offline development resolver. No HTTP, device transport or application imports. */
export async function render(tx, { modelDelegation = false, tokenMetadata = true } = {}) {
  const descriptors = new Map();
  const index = { calldataIndex: {}, typedDataIndex: {} };
  for (const file of (await readdir(new URL('./descriptors/', import.meta.url))).filter(name => name.endsWith('.json'))) {
    const descriptor = JSON.parse(await readFile(new URL(`./descriptors/${file}`, import.meta.url), 'utf8'));
    // The generic renderer has no EIP-7702 resolver. This explicit synthetic alias
    // exercises formatting only; never persist it in the actual descriptor.
    if (modelDelegation && file === 'calldata-Simple7702Account.json') {
      descriptor.context.contract.deployments.push({ chainId, address: wallet });
    }
    descriptors.set(file, descriptor);
    for (const deployment of descriptor.context.contract.deployments) {
      const key = `eip155:${deployment.chainId}:${deployment.address.toLowerCase()}`;
      if (index.calldataIndex[key]) throw new Error(`Duplicate descriptor deployment: ${key}`);
      index.calldataIndex[key] = file;
    }
  }
  return format(tx, {
    descriptorResolverOptions: { type: 'custom', resolver: {
      index, fetchDescriptor: async (name) => {
        if (!descriptors.has(name)) throw new Error('Unknown local descriptor');
        return descriptors.get(name);
      },
    } },
    externalDataProvider: {
      resolveToken: async (id, address) => id === chainId && tokenMetadata
        ? Object.values(tokens).find(token => token.address.toLowerCase() === address.toLowerCase()) ?? null : null,
      resolveChainInfo: async id => id === chainId ? { name: 'Robinhood (fixture)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } } : null,
    },
  });
}

// Include warnings at every depth. A readable wrapper can still hide a raw inner call.
export function problems(model) {
  const result = [...(model.warnings ?? [])];
  if (model.rawCalldataFallback) result.push({ code: 'RAW_CALLDATA', message: 'Undecoded calldata remains' });
  for (const field of model.fields ?? []) {
    if (field.warning) result.push(field.warning);
    if (field.fields) result.push(...problems({ fields: field.fields }));
    if (field.embeddedCalldata) {
      if (field.embeddedCalldata.display) result.push(...problems(field.embeddedCalldata.display));
      else result.push({ code: 'RAW_CALLDATA', message: 'Nested display is absent' });
    }
  }
  return result;
}

export function display(model) {
  return { intent: model.intent ?? null, fields: (model.fields ?? []).flatMap(field => {
    if (field.fields) return display({ fields: field.fields }).fields;
    return [{ label: field.label, value: field.embeddedCalldata?.display ? display(field.embeddedCalldata.display) : field.value }];
  }) };
}
