# Privy integration and prize assessment

The owner selected [Privy Agent Wallets](https://agents.privy.io) and its [official skill](https://agents.privy.io/skill.md). The integration uses the official **`@privy-io/agent-wallet-cli` 0.3.6**, pinned by version, through the local deterministic application. CLI source and signing schemas were inspected on **2026-09-06**; the prize assessment below was checked on **2026-09-04**.

An existing local Privy session was detected and its public wallet metadata was read. Login reported an existing session, which was preserved. This establishes cached wallet availability, not current server authorization. The adapter and its isolated signing, dispatch, recovery and launch fixtures pass ([391-test validation record](evidence/privy-agent-wallets.json)); no live Privy signing, Robinhood transaction, swap receipt, policy enforcement or prize submission is established by this work.

## Setup and explicit mode selection

Application controls stay in the existing agent conversation. The agent uses:

```bash
npm run cli -- privy login
npm run cli -- privy status
```

Login follows the official skill's pinned `pnpm --package=@privy-io/agent-wallet-cli@0.3.6 dlx privy-agent-wallet login` flow. For a new session, OAuth device authorization opens a browser and requires the user to verify and approve the displayed device code. Existing sessions are reused; setup does not log out or replace a session automatically. The public status command reports the cached Ethereum address and wallet ID without returning credentials. The upstream `list-wallets` command does not refresh tokens or validate authorization, so a successful status read cannot promise that the next signing request will succeed.

After the user explicitly selects the Privy wallet, the existing configuration command selects its public address:

```bash
npm run cli -- configure --mode privy --wallet <public-address>
```

With an existing configuration, omitting `--targets` preserves the saved allocation, threshold, slippage and cadence. Initial configuration still requires targets. Pending transaction barriers remain in force. Login and wallet selection do not themselves arm trading or fund the wallet. Do not silently substitute this wallet for another configured signer.

## Deterministic signing and submission

The runtime invokes the installed, pinned CLI's `dist/index.js` with Node as a bounded subprocess. It does not run `pnpm dlx` or download a package on each tick, and no LLM participates in the daemon's planning, signing, submission or recovery. The only wallet operation needed for dispatch is `eth_signTransaction`; the application retains its existing Robinhood RPC broadcast and receipt path.

The CLI selects the first `ethereum` wallet in its session and has no per-request wallet selector. The adapter must match the configured public address and validate the returned signed transaction's sender and complete transaction contents before accepting it for broadcast. It must reject missing, malformed, mismatched or unexpected output. A Privy error leaves the operation unavailable; it never falls back to the local private key or another wallet.

The [official signing schema](https://docs.privy.io/api-reference/wallets/ethereum/eth-sign-transaction) supports explicit `chain_id`, `nonce`, `gas_limit`, `gas_price`, `value`, `to`, `data` and transaction `type`. The current skill additionally specifies top-level `caip2`. For the existing legacy-fee Robinhood path, the request uses `caip2: "eip155:4663"`, `chain_id: 4663`, `type: 0`, and explicit nonce, gas limit and gas price. EIP-1559 fee fields are omitted for that transaction type. The application supplies the prepared values rather than relying on server estimation or nonce selection.

The documented response is:

```json
{
  "method": "eth_signTransaction",
  "data": {
    "signed_transaction": "0x...",
    "encoding": "rlp"
  }
}
```

The CLI prints the complete server JSON on success and exits with an error on failure. Signing alone does not broadcast. After validation, the existing local transaction path persists the transaction identity and pending state around RPC submission and reconciles receipts before another trade. Recovery retains the same nonce, hash and cycle protections; adding a signer does not reset timing or permit duplicate sends.

## Session and network boundaries

Privy performs signing through its hosted service; a local subprocess does not make the signer local. The application sends the prepared transaction fields to Privy and the signed transaction to the configured Robinhood RPC. No wallet private key is imported or exported for this integration. Privy's TEE trust model remains accepted for this explicitly selected mode. [Signing architecture](https://docs.privy.io/wallets/using-wallets/signers/overview)

The official CLI owns session credentials. On macOS it uses the system credential manager when available, with an encrypted, machine-bound file fallback at `~/.privy/session.json`. The fallback is not a hardware wallet or a guarantee against a compromised local account. Credentials stay outside project configuration, source control and application logs. The inspected CLI refreshes an expired access token or authorization key, and performs one refresh-and-retry after HTTP 401. A revoked or failed refresh requires renewed login; cached public wallet metadata does not override that failure. `privy login` deliberately reuses cached state and cannot repair revocation by itself. When the user requests renewed authorization, the agent runs the official `pnpm --package=@privy-io/agent-wallet-cli@0.3.6 dlx privy-agent-wallet logout`, then `npm run cli -- privy login` to obtain a new device approval. Logout only clears the CLI session; it does not change Rebalance's configured wallet or move funds. Verify that the newly authorized Ethereum address still matches before proceeding. Do not log out automatically in response to a generic network failure.

The CLI's default device authorization, token, wallet authentication and wallet RPC requests use `https://auth.privy.io`. Browser approval, wallet management and funding use `https://agents.privy.io`. The upstream package supports environment overrides for its API base, app ID and browser origin; these are routing settings, not network isolation or a Privy-native transaction policy. The integration does not claim a general outbound network restriction. Runtime subprocess deadlines bound the local wait because the inspected RPC fetch has no explicit timeout.

The project remains on **Robinhood mainnet, chain 4663**, with no alternative-chain or signer fallback. [Privy's chain overview](https://docs.privy.io/wallets/overview/chains) includes EVM networks, and the inspected CLI does not contain a chain-ID whitelist for `rpc`. That supports the integration approach but does not prove that the OAuth wallet service accepts this exact Robinhood request. Live signing and a confirmed supported transaction remain evidence gates. A testnet listing does not establish mainnet support, gas sponsorship, balances/history coverage or managed transaction support. Ordinary native gas payment is sufficient; gas sponsorship is not required.

## Native policies

The selected CLI exposes login, public wallet listing and wallet RPC operations. It does not expose a policy-creation or policy-management command. **No Privy-native contract, method or signer restriction is implemented or verified by this adapter.** The local transaction validation is application behavior, not evidence of a provider-enforced policy.

A focused allowed/denied demonstration remains optional future prize work if supported by this wallet flow. Confirm the actual service controls before claiming enforcement; do not introduce a different SDK/REST signing path merely to imply that the chosen CLI has those controls. The user removed spending caps, budget accounting and session-key work. Privy signs its own configured wallet; it is not a delegated signer over the Ledger wallet. [Scope decision](prompts/006-minimal-mvp.md), [direct-signing decision](prompts/008-direct-signing-and-ledger-connect.md)

## Prize fit

Privy remains the planned third partner alongside Uniswap and Ledger. [ETHOnline 2026 — Privy](https://ethglobal.com/events/ethonline2026/prizes#privy) lists **$2,500 for Best financial flow**. Its requirements include Privy as a core integration, at least one Privy wallet, a working financial flow using generally available features, demo/source access and a clear user benefit. Swaps are in scope. A dependency, cached wallet or signing adapter alone does not establish a qualifying financial flow.

The separate B2B prize calls for an organization/business workflow and a Privy control such as policies, signers, quorums or intents. The personal rebalancer targets financial flow; no B2B use case or provider policy demonstration is claimed. At most three partner selections are planned, and actual enrollment/submission remains unverified. Consult the [hackathon checklist](HACKATHON.md) before submission.

## Evidence still required

- [x] Owner selected the official agent-wallet CLI and accepted Privy's hosted signing model.
- [x] Official 0.3.6 package archive and transaction schema inspected; archive integrity matched registry metadata.
- [x] Existing session preserved and public wallet metadata observed without publishing a personal wallet in this document.
- [x] Adapter and isolated fixture tests validate output, wallet/transaction matching, unavailable signer behavior, explicit nonce/fee fields and unchanged pending/cycle behavior. The subprocess has a 30-second timeout; no live timeout was induced.
- [ ] Actual Privy authorization and signing on Robinhood 4663 verified with clearly identified evidence.
- [ ] A supported Privy-backed financial flow completes on Robinhood mainnet with receipt evidence, without a per-trade model call or human prompt.
- [ ] Any optional provider-native policy claim has a real allowed/denied test through the selected wallet flow.
- [ ] Working source, demo, wallet/transaction evidence and user-benefit explanation satisfy the selected prize requirements.

No live Privy signing, mainnet API compatibility, swap, policy enforcement, submission, acceptance or award is claimed by documentation or fixture tests.
