import { decodeEventLog, getAbiItem, isAddress, toEventSelector, TransactionReceiptNotFoundError,
  type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';

const event = getAbiItem({ abi: entryPoint07Abi, name: 'UserOperationEvent' });
const eventTopic = toEventSelector(event).toLowerCase();
export const PAYMASTER_RECEIPT_SCAN_BLOCKS = 2_048n;
export const PAYMASTER_RECEIPT_SCAN_PAGES = 4;
const MAX_RECEIPT_LOGS = 4_096;
const MAX_SCAN_LOGS = 8;
const UINT256_LIMIT = 2n ** 256n;
const BLOCK_LIMIT = 2n ** 64n;
const zeroAddress = `0x${'0'.repeat(40)}`;

type ReceiptClient = Pick<PublicClient, 'getChainId' | 'getBlockNumber' | 'getTransactionReceipt' | 'getBlock' | 'getLogs'>;
export type PaymasterReceiptInput = {
  wallet: Address; userOperationHash: Hex; userOperationNonce: string; paymaster: Address;
  submittedAtBlock: string; scanFromBlock?: string;
};
export type PaymasterReceiptDependencies = {
  publicClient: ReceiptClient;
  /** Standard eth_getUserOperationReceipt result, used only for receipt.transactionHash. */
  getUserOperationReceipt?: (hash: Hex) => Promise<unknown>;
};
export type PaymasterReceiptResult = {
  state: 'pending' | 'confirming' | 'confirmed' | 'reverted'; nextScanBlock: string;
  transactionHash?: Hex; blockNumber?: string; actualGasCost?: string; actualGasUsed?: string;
};
const messages = {
  'invalid-input': 'Invalid UserOperation receipt identity or search cursor.',
  'invalid-evidence': 'UserOperation receipt evidence did not match the saved operation; preserve its identity.',
  'unsupported-entrypoint': 'UserOperation receipt used an unsupported EntryPoint transaction target.',
  'read-failed': 'UserOperation receipt could not be verified; preserve its identity for another read.',
} as const;
export class PaymasterReceiptError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = 'PaymasterReceiptError'; }
}

const hashValue = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const addressValue = (value: unknown): value is Address => typeof value === 'string' && isAddress(value, { strict: false });
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const blockValue = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n && value < BLOCK_LIMIT;
function decimal(value: unknown, limit: bigint): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new PaymasterReceiptError('invalid-input');
  const parsed = BigInt(value);
  if (parsed >= limit) throw new PaymasterReceiptError('invalid-input');
  return parsed;
}

async function receiptHint(hash: Hex, get?: PaymasterReceiptDependencies['getUserOperationReceipt']): Promise<Hex | null> {
  if (!get) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => get(hash)),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 4_000); }),
    ]);
    return record(result) && record(result.receipt) && hashValue(result.receipt.transactionHash)
      ? result.receipt.transactionHash : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** Read-only: bundler state is only a discovery hint. EntryPoint logs in the
 * canonical transaction receipt establish this operation's execution outcome. */
export async function inspectPaymasterReceipt(input: PaymasterReceiptInput,
  { publicClient: rpc, getUserOperationReceipt }: PaymasterReceiptDependencies): Promise<PaymasterReceiptResult> {
  if (!input || !addressValue(input.wallet) || same(input.wallet, zeroAddress) || !addressValue(input.paymaster) ||
      same(input.paymaster, zeroAddress) || !hashValue(input.userOperationHash)) throw new PaymasterReceiptError('invalid-input');
  const nonce = decimal(input.userOperationNonce, UINT256_LIMIT);
  const submitted = decimal(input.submittedAtBlock, BLOCK_LIMIT);
  const scanFrom = input.scanFromBlock === undefined ? submitted : decimal(input.scanFromBlock, BLOCK_LIMIT);
  if (scanFrom < submitted) throw new PaymasterReceiptError('invalid-input');
  let cursor = scanFrom;
  const nextCursor = (after: bigint) => (after - 2n > submitted ? after - 2n : submitted).toString();
  const pending = (): PaymasterReceiptResult => ({ state: 'pending', nextScanBlock: nextCursor(cursor) });
  try {
    if (await rpc.getChainId() !== 4663) throw new PaymasterReceiptError('invalid-evidence');
    const head = await rpc.getBlockNumber({ cacheTime: 0 });
    if (!blockValue(head)) throw new PaymasterReceiptError('invalid-evidence');
    // A shortened/reorganized chain must not leave a cursor beyond its head.
    if (cursor > head) cursor = head > submitted ? head : submitted;

    const inspectTransaction = async (hash: Hex): Promise<PaymasterReceiptResult | null> => {
      let receipt: TransactionReceipt;
      try { receipt = await rpc.getTransactionReceipt({ hash }); }
      catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
      if (!receipt || !hashValue(receipt.transactionHash) || !same(receipt.transactionHash, hash) ||
          !hashValue(receipt.blockHash) || !blockValue(receipt.blockNumber) || receipt.blockNumber < submitted ||
          !Array.isArray(receipt.logs) || receipt.logs.length > MAX_RECEIPT_LOGS) throw new PaymasterReceiptError('invalid-evidence');
      const matching = receipt.logs.filter(log => addressValue(log.address) && same(log.address, entryPoint07Address) &&
        Array.isArray(log.topics) && log.topics[0]?.toLowerCase() === eventTopic &&
        typeof log.topics[1] === 'string' && same(log.topics[1], input.userOperationHash));
      if (!matching.length) return null;
      if (matching.length !== 1 || receipt.status !== 'success') throw new PaymasterReceiptError('invalid-evidence');
      if (!addressValue(receipt.to) || !same(receipt.to, entryPoint07Address)) throw new PaymasterReceiptError('unsupported-entrypoint');
      const log = matching[0]!;
      if ((log.removed !== undefined && log.removed !== false) || !hashValue(log.transactionHash) || !same(log.transactionHash, hash) ||
          !hashValue(log.blockHash) || !same(log.blockHash, receipt.blockHash) || log.blockNumber !== receipt.blockNumber ||
          !Number.isSafeInteger(log.logIndex) || log.logIndex! < 0 ||
          log.topics.length !== 4 || !log.topics.every(hashValue) || typeof log.data !== 'string' ||
          !/^0x[0-9a-fA-F]{256}$/.test(log.data) ||
          log.topics[2]!.toLowerCase() !== `0x${'0'.repeat(24)}${input.wallet.slice(2).toLowerCase()}` ||
          log.topics[3]!.toLowerCase() !== `0x${'0'.repeat(24)}${input.paymaster.slice(2).toLowerCase()}`) throw new PaymasterReceiptError('invalid-evidence');
      const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics, strict: true });
      const args = decoded.args;
      if (!same(args.userOpHash, input.userOperationHash) || !same(args.sender, input.wallet) ||
          !same(args.paymaster, input.paymaster) || args.nonce !== nonce ||
          typeof args.success !== 'boolean' || typeof args.actualGasCost !== 'bigint' || args.actualGasCost < 0n ||
          typeof args.actualGasUsed !== 'bigint' || args.actualGasUsed < 0n) throw new PaymasterReceiptError('invalid-evidence');
      const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
      const evidence = { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(),
        nextScanBlock: (receipt.blockNumber < cursor ? receipt.blockNumber : cursor).toString() };
      if (!block || block.number !== receipt.blockNumber || !hashValue(block.hash)) throw new PaymasterReceiptError('invalid-evidence');
      if (!same(block.hash, receipt.blockHash) || head < receipt.blockNumber + 1n) return { ...evidence, state: 'confirming' };
      return { ...evidence, state: args.success ? 'confirmed' : 'reverted',
        actualGasCost: args.actualGasCost.toString(), actualGasUsed: args.actualGasUsed.toString() };
    };

    const hinted = await receiptHint(input.userOperationHash, getUserOperationReceipt);
    if (hinted) {
      const inspected = await inspectTransaction(hinted);
      if (inspected) return inspected;
    }
    for (let page = 0; page < PAYMASTER_RECEIPT_SCAN_PAGES && cursor < head; page++) {
      const end = cursor + PAYMASTER_RECEIPT_SCAN_BLOCKS - 1n;
      const toBlock = end < head ? end : head - 1n;
      const logs = await rpc.getLogs({ address: entryPoint07Address, event, args: { userOpHash: input.userOperationHash },
        fromBlock: cursor, toBlock, strict: true });
      if (!Array.isArray(logs) || logs.length > MAX_SCAN_LOGS) throw new PaymasterReceiptError('invalid-evidence');
      if (logs.length) {
        if (logs.length !== 1) throw new PaymasterReceiptError('invalid-evidence');
        const log = logs[0]!;
        if (!addressValue(log.address) || !same(log.address, entryPoint07Address) || (log.removed !== undefined && log.removed !== false) ||
            !hashValue(log.transactionHash) || !hashValue(log.blockHash) || !blockValue(log.blockNumber) ||
            log.blockNumber < cursor || log.blockNumber > toBlock ||
            !Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== eventTopic ||
            typeof log.topics[1] !== 'string' || !same(log.topics[1], input.userOperationHash)) throw new PaymasterReceiptError('invalid-evidence');
        const inspected = await inspectTransaction(log.transactionHash);
        if (inspected) return inspected;
        // A disappearing receipt or inconsistent scan hint is not an empty
        // completed range. Retain this range so another read can reconcile it.
        return pending();
      }
      cursor = toBlock + 1n;
    }
    return pending();
  } catch (error) {
    if (error instanceof PaymasterReceiptError) throw error;
    throw new PaymasterReceiptError('read-failed');
  }
}
