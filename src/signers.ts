import { getAddress, type Address, type Hex } from 'viem';
import { localAccount, type Config } from './config.js';
import { privySigner, type PreparedTransaction } from './privy.js';
import { ledgerSigner } from './ledger-signing.js';
import { preparedAuthorization, preparedMessageHash, verifiedAuthorizationSignature, verifiedMessageHashSignature,
  type PreparedAuthorization } from './signing-payloads.js';
export type { PreparedTransaction } from './privy.js';
export type { PreparedAuthorization } from './signing-payloads.js';
export type TransactionSigner = {
  address: Address;
  signTransaction(tx: PreparedTransaction): Promise<Hex>;
  signAuthorization?(input: PreparedAuthorization): Promise<Hex>;
  signMessageHash?(hash: Hex): Promise<Hex>;
};

/** Signer selection is explicit. Only the local-key branch can read its local key. */
export async function loadSigner(config: Config, options: { signal?: AbortSignal } = {}): Promise<TransactionSigner> {
  if (config.mode === 'privy') return privySigner(config.wallet);
  if (config.mode === 'ledger') return ledgerSigner(config.wallet, options);
  if (config.mode !== 'private-key') throw new Error(`${config.mode} execution is not connected yet; no fallback signer was used`);
  const wallet = getAddress(config.wallet);
  const account = await localAccount();
  const selected = () => {
    if (getAddress(account.address) !== wallet) throw new Error('Local account differs from the selected wallet; no fallback signer was used.');
  };
  return {
    address: account.address, signTransaction: tx => account.signTransaction(tx),
    async signAuthorization(input) {
      const prepared = preparedAuthorization(input);
      selected();
      if (!account.signAuthorization) throw new Error('The selected local account cannot sign delegation authorizations.');
      const { r, s, v, yParity } = await account.signAuthorization(prepared);
      return verifiedAuthorizationSignature({ r, s, v, yParity }, wallet, prepared);
    },
    async signMessageHash(input) {
      const hash = preparedMessageHash(input);
      selected();
      return verifiedMessageHashSignature(await account.signMessage({ message: { raw: hash } }), wallet, hash);
    },
  };
}
