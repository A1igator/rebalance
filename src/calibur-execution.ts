import { decodeFunctionData, erc20Abi, getAddress, parseAbi, type Address } from 'viem';
import { ASSETS } from './assets.js';
import { CALIBUR_ADDRESS, CALIBUR_ABI, assertCaliburDeployment, inspectCaliburAccountCode } from './calibur.js';
import { ROUTER, type ChainTransaction, type createChain } from './chain.js';
import type { Config } from './config.js';

type Chain = ReturnType<typeof createChain>;
export type CaliburState = 'undelegated' | 'calibur';
const DELEGATION_CODE = `0xef0100${CALIBUR_ADDRESS.slice(2).toLowerCase()}` as const;
const ROUTER_ABI = parseAbi([
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

/** No generic contract execution: only the prepared approvals and router batch. */
export function validateCaliburTransaction(config: Config, tx: ChainTransaction): void {
  if (config.execution !== 'calibur' || config.mode !== 'ledger' || config.chainId !== 4663 ||
      tx.to.toLowerCase() !== config.wallet.toLowerCase() || tx.kind !== 'swap' || tx.value !== 0n ||
      !tx.plan || !Number.isInteger(tx.swapCount) || tx.swapCount! < 1 || tx.swapCount! > 4 ||
      tx.plan.trades.length !== tx.swapCount || tx.approvalCount !== 0 || !tx.calibur || !Number.isInteger(tx.calibur.approvalCount) ||
      tx.calibur.approvalCount < 0 || tx.calibur.approvalCount > 4) {
    throw new Error('Calibur execution requires an explicit Ledger wallet and an atomic rebalance');
  }
  const decoded = decodeFunctionData({ abi: CALIBUR_ABI, data: tx.data });
  if (decoded.functionName !== 'execute') throw new Error('Invalid Calibur method');
  const batch = decoded.args[0];
  if (!batch.revertOnFailure || batch.calls.length !== tx.calibur.approvalCount + 1) throw new Error('Invalid Calibur batch');
  const approved = new Set<string>();
  for (const call of batch.calls.slice(0, -1)) {
    const token = Object.values(ASSETS).find(asset => asset.address.toLowerCase() === call.to.toLowerCase());
    if (!token || !Object.hasOwn(config.targets, token.id) || approved.has(token.id) || call.value !== 0n) {
      throw new Error('Invalid Calibur approval target');
    }
    const approval = decodeFunctionData({ abi: erc20Abi, data: call.data });
    if (approval.functionName !== 'approve' || getAddress(approval.args[0]) !== getAddress(ROUTER) || approval.args[1] <= 0n) {
      throw new Error('Invalid Calibur router approval');
    }
    // The fresh planner is the authority for exact input amounts. No headroom.
    const input = tx.plan?.trades.filter(trade => trade.sellAssetId === token.id).reduce((sum, trade) => sum + trade.amountIn, 0n);
    if (input === undefined || input !== approval.args[1]) throw new Error('Calibur approval differs from the prepared input');
    approved.add(token.id);
  }
  const routerCall = batch.calls.at(-1)!;
  if (getAddress(routerCall.to) !== getAddress(ROUTER) || routerCall.value !== 0n) throw new Error('Invalid Calibur swap target');
  const router = decodeFunctionData({ abi: ROUTER_ABI, data: routerCall.data });
  if (router.functionName !== 'multicall' || router.args[1].length !== tx.swapCount ||
      tx.expiresAt === undefined || router.args[0] < tx.expiresAt) throw new Error('Invalid Calibur swap batch');
  const usedStocks = new Set<string>();
  let purchasing = false;
  for (const [index, data] of router.args[1].entries()) {
    const swap = decodeFunctionData({ abi: ROUTER_ABI, data });
    if (swap.functionName !== 'exactInputSingle') throw new Error('Invalid Calibur inner swap');
    const trade = tx.plan.trades[index]!;
    const sell = Object.values(ASSETS).find(asset => asset.id === trade.sellAssetId);
    const buy = Object.values(ASSETS).find(asset => asset.id === trade.buyAssetId);
    const params = swap.args[0];
    if (!sell || !buy || sell.id === buy.id || !Object.hasOwn(config.targets, sell.id) || !Object.hasOwn(config.targets, buy.id) ||
        (sell.id !== 'USDG' && buy.id !== 'USDG') || getAddress(params.tokenIn) !== getAddress(sell.address) ||
        getAddress(params.tokenOut) !== getAddress(buy.address) || params.amountIn !== trade.amountIn || params.amountIn <= 0n ||
        params.amountOutMinimum <= 0n || params.sqrtPriceLimitX96 !== 0n || ![100, 500, 3000, 10000].includes(params.fee) ||
        getAddress(params.recipient) !== getAddress(config.wallet)) throw new Error('Calibur swap differs from its prepared plan');
    const stock = sell.id === 'USDG' ? buy.id : sell.id;
    if (usedStocks.has(stock) || (purchasing && sell.id !== 'USDG')) throw new Error('Invalid Calibur trade order');
    usedStocks.add(stock);
    purchasing ||= sell.id === 'USDG';
  }
}

/** Recheck public code every attempt; cached discovery cannot authorize a delegation. */
export async function readCaliburState(chain: Chain, wallet: Address): Promise<CaliburState> {
  const rpc = chain.publicClient;
  if (await rpc.getChainId() !== 4663) throw new Error('Calibur requires Robinhood mainnet');
  const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 });
  const [implementation, account] = await Promise.all([
    rpc.getCode({ address: CALIBUR_ADDRESS, blockNumber }),
    rpc.getCode({ address: wallet, blockNumber }),
  ]);
  assertCaliburDeployment(implementation);
  return inspectCaliburAccountCode(account);
}

/** Full atomic call simulation before device authorization. No signed authorization leaves the host. */
export async function estimateCaliburGas(config: Config, chain: Chain, tx: ChainTransaction, state: CaliburState): Promise<bigint> {
  validateCaliburTransaction(config, tx);
  const estimate = await chain.publicClient.estimateGas({ account: config.wallet, to: tx.to, data: tx.data, value: 0n,
    ...(state === 'undelegated' ? { stateOverride: [{ address: config.wallet, code: DELEGATION_CODE }] } : {}),
  });
  if (typeof estimate !== 'bigint' || estimate <= 0n) throw new Error('Invalid Calibur gas estimate');
  // EIP-7702 charges at most PER_EMPTY_ACCOUNT_COST=25000 per authorization.
  // The state-override estimate covers execution; include setup cost before buffering.
  return estimate + (state === 'undelegated' ? 25_000n : 0n);
}
