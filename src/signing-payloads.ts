import { getAddress, isAddress, parseSignature,
  recoverMessageAddress, serializeSignature, type Address, type Hex } from 'viem';

import { hashAuthorization, recoverAuthorizationAddress } from 'viem/utils';

export type PreparedAuthorization = { chainId: 4663; address: Address; nonce: number };
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalidSignature = () => new Error('Invalid signature for the prepared payload or selected wallet.');

/** Snapshot the exact chain-bound delegation; callers verify the approved implementation. */
export function preparedAuthorization(input: PreparedAuthorization): PreparedAuthorization {
  try {
    if (!object(input) || Object.keys(input).some(key => !['chainId', 'address', 'nonce'].includes(key)) ||
        input.chainId !== 4663 || !Number.isSafeInteger(input.nonce) || input.nonce < 0 ||
        !isAddress(input.address, { strict: false }) || /^0x0{40}$/i.test(input.address)) throw new Error();
    const prepared = Object.freeze({ chainId: 4663 as const, address: getAddress(input.address), nonce: input.nonce });
    // Validate the locally computed EIP-7702 payload before any provider/device interaction.
    hashAuthorization(prepared);
    return prepared;
  } catch { throw new Error('Invalid prepared Robinhood delegation authorization.'); }
}

export function preparedMessageHash(hash: Hex): Hex {
  if (typeof hash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error('Expected an exact 32-byte message hash.');
  return hash.toLowerCase() as Hex;
}

/** Normalize only a 65-byte low-s ECDSA signature, never EIP-155 or wrapped signatures. */
export function canonicalPayloadSignature(value: unknown): Hex {
  try {
    let signature: Record<string, unknown>;
    if (typeof value === 'string') {
      if (!/^0x[a-fA-F0-9]{130}$/.test(value)) throw new Error();
      signature = parseSignature(value as Hex);
    } else {
      if (!object(value) || Object.keys(value).some(key => !['r', 's', 'v', 'yParity'].includes(key))) throw new Error();
      signature = value;
    }
    const { r, s, v, yParity } = signature;
    if (typeof r !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(r) ||
        typeof s !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(s)) throw new Error();
    const rNumber = BigInt(r), sNumber = BigInt(s);
    if (rNumber <= 0n || rNumber >= CURVE_ORDER || sNumber <= 0n || sNumber > CURVE_ORDER / 2n) throw new Error();
    let parity: 0 | 1 | undefined;
    if (v !== undefined) {
      if (![0, 1, 27, 28, 0n, 1n, 27n, 28n].includes(v as number | bigint)) throw new Error();
      parity = (Number(v) >= 27 ? Number(v) - 27 : Number(v)) as 0 | 1;
    }
    if (yParity !== undefined) {
      if (yParity !== 0 && yParity !== 1) throw new Error();
      if (parity !== undefined && parity !== yParity) throw new Error();
      parity = yParity;
    }
    if (parity === undefined) throw new Error();
    return serializeSignature({ r: r as Hex, s: s as Hex, yParity: parity });
  } catch { throw invalidSignature(); }
}

export async function verifiedAuthorizationSignature(value: unknown, wallet: Address, input: PreparedAuthorization): Promise<Hex> {
  try {
    const authorization = preparedAuthorization(input), signature = canonicalPayloadSignature(value);
    const recovered = await recoverAuthorizationAddress({ authorization, signature });
    if (getAddress(recovered) !== getAddress(wallet)) throw new Error();
    return signature;
  } catch { throw invalidSignature(); }
}

export async function verifiedMessageHashSignature(value: unknown, wallet: Address, input: Hex): Promise<Hex> {
  try {
    const hash = preparedMessageHash(input), signature = canonicalPayloadSignature(value);
    const recovered = await recoverMessageAddress({ message: { raw: hash }, signature });
    if (getAddress(recovered) !== getAddress(wallet)) throw new Error();
    return signature;
  } catch { throw invalidSignature(); }
}
