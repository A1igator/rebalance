import { batch } from './fixtures.mjs';
import { render, display, problems } from './render.mjs';
// Public synthetic sample only. Never read user input, wallet state or credentials.
globalThis.fetch = async () => { throw new Error('Network forbidden in development preview'); };
const transaction = batch();
const model = await render(transaction, { modelDelegation: true });
const warnings = problems(model);
console.log(JSON.stringify({
  evidence: 'Software formatting only; synthetic delegation mapping and token metadata',
  deviceTested: false, productionClearSigning: false,
  transaction, display: display(model), warnings,
}, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
if (warnings.length) process.exitCode = 1;
