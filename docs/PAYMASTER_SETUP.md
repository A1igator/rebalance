# Optional USDG gas payments

> **Archived — removed on September 10, 2026.** The owner withdrew gas abstraction under [prompt 068](prompts/068-remove-unused-paymaster.md). The implementation and CLI commands described below are historical and are unavailable in current main. Native ETH gas and the per-wallet fee target remain. Older gasPayment configurations and paymaster pending records are rejected without modification.

USDG gas is an optional per-wallet transport. Native ETH remains the default. The implementation keeps the same wallet address and uses Alchemy Wallet APIs, EntryPoint v0.7 and SemiModularAccount7702 v1.1. It does not create a new portfolio, change targets or start trading.

Implementation and fixture tests do not prove that a particular Alchemy policy accepts Robinhood canonical USDG. A successful authenticated read-only estimate is required before `configure` saves the transport. A sponsored execution is proven only by its verified on-chain UserOperation receipt.

## Provider owner setup

1. In your own [Alchemy account](https://dashboard.alchemy.com/), create/select an app with Robinhood mainnet Wallet API and bundler access. Set up the mainnet billing capacity required by your account. The API key belongs to this provider app, not a portfolio signer.
2. Create an **ERC-20 policy** for Robinhood mainnet, token **`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (USDG, six decimals)**, with post-operation collection (`usePostOp: true`) and your intended recipient. If USDG is absent from the picker, use Alchemy's official custom-token policy tooling. A supported direct price or explicitly chosen same-decimal reference price is required. Activate the policy; newly created policies may be inactive. [Alchemy token payment instructions](https://www.alchemy.com/docs/wallets/transactions/pay-gas-with-any-token)
3. Copy the public policy UUID. Rebalance discovers the policy's Robinhood EntryPoint v0.7 paymaster contract itself with authenticated `pm_getPaymasterStubData`, then verifies a complete estimate; you do not need to find the contract address manually. [Alchemy paymaster discovery](https://www.alchemy.com/docs/wallets/low-level-infra/gas-manager/gas-sponsorship/using-sdk/pay-gas-with-any-erc20-token)
4. Enter the app API key yourself in a local terminal in this repository:

   ```sh
   npm run cli -- paymaster setup
   ```

   Input is hidden. Do not paste it into chat, put it in a command argument, or pipe it into this command. The insert-only local credential is shared by portfolios under the same root and stored outside Git with owner-only permissions. Repeated setup never overwrites it. The command does not take or store an Alchemy administration access token. `REBALANCE_ALCHEMY_API_KEY` is an optional owner-managed process environment alternative, but do not ask an agent to inspect it or include its value in a command.
5. Fund the intended wallet with enough canonical USDG for the read-only probe and later swaps. Give the agent only the public policy UUID. The agent can run:

   ```sh
   npm run cli -- --profile <wallet-address> paymaster configure <policy-uuid>
   ```

   An optional third argument supplies an already verified public paymaster contract address instead of automatic discovery; it still requires the full estimate. Configuration checks the chain, supported account implementation, contract presence, exact prepared calls, canonical token, paymaster, nonce, token fee and available USDG using `wallet_prepareCalls` with `onlyEstimation`. A failed check saves nothing. It uses a simulated `USDG.approve(router, 0)` as a probe; no approval, delegation or transaction is actually sent.

## Operating it

```sh
npm run cli -- --profile <wallet-address> paymaster status
npm run cli -- --profile <wallet-address> paymaster check
npm run cli -- --profile <wallet-address> paymaster disable
```

Status reads saved public settings and credential presence, not credential contents or live readiness. Check repeats the read-only probe. Its quote is an approval-probe amount, not a whole-rebalance fee, an actual charge or proof of successful trading. Full execution estimates the actual operation again and respects that wallet's configured rebalance fee target.

Settings can change while a runner is active. Existing targets, pending receipt identities and cycle timing remain intact. A pending UserOperation continues reconciling through its saved transport even after disable. Old processes require the updated binary before they can use the new transport.

**EIP-7702 delegation persists on-chain when this transport is disabled.** Disable returns future operations to native gas and does not revoke an existing delegation. First live use needs a delegation signature followed by the operation signature; later operations use the existing supported delegation. The account's owner still controls signing. [EIP-7702 behavior](https://www.alchemy.com/docs/wallets/transactions/using-eip-7702)

Ledger requires physical confirmation for both payloads when applicable, inside an explicitly requested rebalance. Start or device connection alone does not sign. Local and Privy use their existing automatic-signing authorization. Privy remains exclusively on agents.privy.io; Alchemy does not receive its wallet secret.

Token fees are collected after execution using an exact batched allowance where needed. This path does not rely on USDG permit support, use unlimited approvals, introduce session keys or fall back silently to ETH. Provider/RPC availability and pricing remain trust dependencies; this is not a consensus-verified light-client path. See the earlier [read-only research record](PAYMASTER_CHECK.md) for public observations and their limits.
