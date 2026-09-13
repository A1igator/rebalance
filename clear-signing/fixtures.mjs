// Development-only public constants and invented amounts. No key, RPC or app-state imports.
import { encodeFunctionData, erc20Abi, parseAbi } from 'viem';
export const chainId = 4663;
export const wallet = '0x1111111111111111111111111111111111111111';
export const implementation = '0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9';
export const router = '0xCaf681a66D020601342297493863E78C959E5cb2';
export const deadline = 1800000000n;
export const tokens = {
  USDG: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', name: 'USDG (fixture metadata)', decimals: 6 },
  AAPL: { address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', symbol: 'AAPL', name: 'AAPL (fixture metadata)', decimals: 18 },
  NVDA: { address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', symbol: 'NVDA', name: 'NVDA (fixture metadata)', decimals: 18 },
  MSFT: { address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', symbol: 'MSFT', name: 'MSFT (fixture metadata)', decimals: 18 },
  AMD: { address: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC', symbol: 'AMD', name: 'AMD (fixture metadata)', decimals: 18 },
};
export const batchAbi = parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);
export const routerAbi = parseAbi([
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)',
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
export const approval = (symbol, amount, spender = router) => ({
  target: tokens[symbol].address, value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
});
export const swapParams = [
  ['AAPL', 'USDG', 10n ** 16n, 2_000_000n],
  ['NVDA', 'USDG', 2n * 10n ** 16n, 3_000_000n],
  ['MSFT', 'USDG', 3n * 10n ** 16n, 4_000_000n],
  ['USDG', 'AMD', 8_000_000n, 4n * 10n ** 16n],
].map(([input, output, amountIn, amountOutMinimum]) => ({
  tokenIn: tokens[input].address, tokenOut: tokens[output].address,
  fee: 3000, recipient: wallet, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n,
}));
export const swapData = (params) => encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [params] });
export const routerCall = (params = swapParams, expiry = deadline) => ({
  target: router, value: 0n,
  data: encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [expiry, params.map(swapData)] }),
});
export const calls = [approval('AAPL', 10n ** 16n), approval('NVDA', 2n * 10n ** 16n),
  approval('MSFT', 3n * 10n ** 16n), approval('USDG', 8_000_000n), routerCall()];
export const batch = (items = calls) => ({ chainId, from: wallet, to: wallet, value: 0n,
  data: encodeFunctionData({ abi: batchAbi, functionName: 'executeBatch', args: [items] }) });
export const direct = (call) => ({ chainId, from: wallet, to: call.target, value: call.value, data: call.data });
