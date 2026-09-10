import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { getAddress, parseTransaction, recoverTransactionAddress, toHex, type Address, type Hex, type TransactionSerialized } from 'viem';

import { canonicalPayloadSignature, preparedAuthorization, preparedMessageHash, verifiedAuthorizationSignature, verifiedMessageHashSignature,
  type PreparedAuthorization } from './signing-payloads.js';

export type PreparedTransaction = {
  chainId: 4663; type: 'legacy'; nonce: number; gas: bigint; gasPrice: bigint;
  to: Address; data: Hex; value: bigint;
};
export type PrivyCommand = (args: readonly string[], input?: string) => Promise<string>;
const cliPath = () => createRequire(import.meta.url).resolve('@privy-io/agent-wallet-cli');

/** Use the locked package, no shell/dlx install/LLM or provider broadcast in the runner. */
export const privyCommand: PrivyCommand = (args, input) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [cliPath(), ...args], {
    timeout: 30_000, maxBuffer: 262_144, windowsHide: true,
  }, (error, stdout) => {
    // Never relay CLI stderr, request bodies, session data or signatures into errors/logs.
    if (error) reject(new Error('Privy CLI failed or timed out. Check the Privy session through the agent; no transaction was broadcast by this command.'));
    else resolve(stdout);
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
});

export type PrivyWallet = { provider: 'privy'; address: Address; walletId: string; session: 'cached'; networkVerified: false };
export async function privyWallet(command: PrivyCommand = privyCommand): Promise<PrivyWallet> {
  const output = await command(['list-wallets']);
  // CLI 0.3.6 rpc selects the first Ethereum session wallet. Mirror that exact choice.
  const first = output.split('\n').find(line => /^\s*ethereum:/i.test(line));
  const match = first?.match(/^\s*ethereum:\s+(0x[0-9a-fA-F]{40})\s+\(([a-zA-Z0-9_-]+)\)\s*$/i);
  if (!match) throw new Error('No usable Privy Ethereum session wallet. Use privy login through the agent.');
  return { provider: 'privy', address: getAddress(match[1]!), walletId: match[2]!, session: 'cached', networkVerified: false };
}

/** OAuth device approval is the only interactive step; existing sessions are preserved. */
export async function loginPrivy(): Promise<PrivyWallet> {
  try { return await privyWallet(); } catch { /* Let the official CLI handle missing/expired login. */ }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['--package=@privy-io/agent-wallet-cli@0.3.6', 'dlx', 'privy-agent-wallet', 'login'], {
      stdio: 'inherit', shell: false,
    });
    child.once('error', () => reject(new Error('Could not start Privy device login. pnpm must be installed on this machine.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Privy login did not complete. Keep the existing session; inspect the device login result.')));
  });
  return privyWallet();
}

export function privySigningRequest(wallet: Address, tx: PreparedTransaction) {
  if (tx.chainId !== 4663 || tx.type !== 'legacy' || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 ||
      tx.gas <= 0n || tx.gasPrice <= 0n || tx.value < 0n || [tx.gas, tx.gasPrice, tx.value].some(n => n >= 2n ** 256n)) {
    throw new Error('Invalid prepared Robinhood transaction for Privy.');
  }
  return { method: 'eth_signTransaction', caip2: 'eip155:4663', params: { transaction: {
    from: getAddress(wallet), to: getAddress(tx.to), chain_id: 4663, type: 0,
    nonce: tx.nonce, gas_limit: toHex(tx.gas), gas_price: toHex(tx.gasPrice), value: toHex(tx.value), data: tx.data,
  } } };
}

/** Provider output is untrusted: recover the sender and compare every transaction field. */
export async function verifiedPrivyTransaction(output: string, wallet: Address, tx: PreparedTransaction): Promise<Hex> {
  try {
    const response = JSON.parse(output);
    const raw = response?.data?.signed_transaction;
    if (response?.method !== 'eth_signTransaction' || response?.data?.encoding !== 'rlp' ||
        typeof raw !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(raw)) throw new Error();
    const serialized = raw as Hex;
    const decoded = parseTransaction(serialized);
    if (decoded.type !== 'legacy' || decoded.chainId !== tx.chainId || (decoded.nonce ?? 0) !== tx.nonce ||
        decoded.gas !== tx.gas || decoded.gasPrice !== tx.gasPrice || (decoded.value ?? 0n) !== tx.value ||
        decoded.to?.toLowerCase() !== tx.to.toLowerCase() || (decoded.data ?? '0x').toLowerCase() !== tx.data.toLowerCase()) throw new Error();
    if ((await recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized })).toLowerCase() !== wallet.toLowerCase()) throw new Error();
    return serialized;
  } catch { throw new Error('Privy returned an invalid signature or a transaction differing from the prepared sender, network or fields. No transaction was broadcast.'); }
}

export async function privySigner(wallet: Address, command: PrivyCommand = privyCommand) {
  const selected = await privyWallet(command);
  if (selected.address.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('Privy session wallet differs from the configured wallet; no fallback signer was used.');
  }
  return { address: selected.address, signTransaction: async (tx: PreparedTransaction): Promise<Hex> => {
    const request = privySigningRequest(wallet, tx);
    const output = await command(['rpc'], JSON.stringify(request));
    return verifiedPrivyTransaction(output, wallet, tx);
  },
  async signAuthorization(input: PreparedAuthorization): Promise<Hex> {
    const prepared = preparedAuthorization(input);
    const request = { method: 'eth_sign7702Authorization', params: {
      contract: prepared.address, chain_id: prepared.chainId, nonce: prepared.nonce,
    } };
    const output = await command(['rpc'], JSON.stringify(request));
    try {
      const response = JSON.parse(output), authorization = response?.data?.authorization;
      if (response?.method !== 'eth_sign7702Authorization' || !authorization ||
          authorization.chain_id !== prepared.chainId || authorization.nonce !== prepared.nonce ||
          typeof authorization.contract !== 'string' || getAddress(authorization.contract) !== prepared.address) throw new Error();
      const signature = canonicalPayloadSignature({ r: authorization.r, s: authorization.s, yParity: authorization.y_parity });
      return await verifiedAuthorizationSignature(signature, wallet, prepared);
    } catch { throw new Error('Privy returned an invalid delegation authorization for the prepared fields or selected wallet.'); }
  },
  async signMessageHash(input: Hex): Promise<Hex> {
    const hash = preparedMessageHash(input);
    const request = { method: 'personal_sign', caip2: 'eip155:4663', params: { message: hash, encoding: 'hex' },
      signature_options: { type: 'ecdsa' } };
    const output = await command(['rpc'], JSON.stringify(request));
    try {
      const response = JSON.parse(output);
      if (response?.method !== 'personal_sign' || response?.data?.encoding !== 'hex') throw new Error();
      return await verifiedMessageHashSignature(response.data.signature, wallet, hash);
    } catch { throw new Error('Privy returned an invalid personal signature for the prepared hash or selected wallet.'); }
  } };
}
