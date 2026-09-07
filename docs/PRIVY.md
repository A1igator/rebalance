# Privy integration and prize assessment

The owner selected [Privy Agent Wallets](https://agents.privy.io) and its [official skill](https://agents.privy.io/skill.md). The integration uses the official **`@privy-io/agent-wallet-cli` 0.3.6**, pinned by version, through the local deterministic application. CLI source and signing schemas were inspected on **2026-09-06**, and the device-approval adapter was checked against the pinned source on **2026-09-07**; the prize assessment below was checked on **2026-09-04**.

An existing local Privy session was detected and its public wallet metadata was read. Login reported an existing session, which was preserved. This establishes cached wallet availability, not current server authorization. The adapter and its isolated signing, dispatch, recovery and launch fixtures pass ([391-test validation record](evidence/privy-agent-wallets.json)); no live Privy signing, Robinhood transaction, swap receipt, policy enforcement or prize submission is established by this work.

## Exclusive Agent Sandbox scope

The human explicitly reaffirmed **agents.privy.io exclusively**, without the Privy developer dashboard or another app/API integration. The app-controlled additional-wallet approach in [prompt 049](prompts/049-additional-privy-wallets.md) was withdrawn before its implementation was committed. Its source, app-secret form and endpoints are absent from the active repository. No developer credentials were entered or live app-backed wallet created.

On September 7, fresh inspection of [the Sandbox homepage](https://agents.privy.io), [My agents](https://agents.privy.io/manage) and [the official skill](https://agents.privy.io/skill.md) found no supported additional-Ethereum-wallet flow. The current wallet page selects the first linked Ethereum and Solana accounts, and its provider configuration creates wallets only for users without wallets. My agents manages/revokes sessions; connecting another agent shares the skill rather than creating another wallet. A general SDK function appearing in a browser bundle does not establish a supported Sandbox creation interface. Backend capabilities outside those interfaces remain unverified. Existing cached sessions and portfolios stay intact; automatic logout/relogin is not a creation workaround.

## Setup and explicit mode selection

In the local portfolio selector, **New portfolio → Privy** starts deterministic setup. If the official CLI already has a usable cached Ethereum wallet, setup reuses that address. Otherwise the installed pinned CLI starts its device approval flow and opens the official Privy page in the system browser. The local UI displays the same approval URL and user code, waits for approval, and obtains the public wallet address after the CLI succeeds. The surrounding setup flow registers/connects the portfolio; authentication itself does not fund a wallet or arm trading.

The browser link must use `https://agents.privy.io/` with only a matching `user_code` query parameter. Other origins, credentials, fragments, extra parameters and mismatched codes are rejected. The CLI's official browser opening remains enabled: version 0.3.6 exposes neither `--no-browser` nor a machine-readable login mode. This is browser approval with local progress, not an embedded Privy sign-in form.

The agent commands remain available:

```bash
npm run cli -- privy login
npm run cli -- privy status
```

The agent's `privy login` command follows the official skill's pinned `pnpm --package=@privy-io/agent-wallet-cli@0.3.6 dlx privy-agent-wallet login` flow. The UI adapter invokes the already installed 0.3.6 entry point with Node, without installing packages during setup. For a new session, OAuth device authorization opens a browser and requires the user to verify and approve the displayed device code. Existing sessions are reused; setup does not log out or replace a session automatically. The public status command reports the cached Ethereum address and wallet ID without returning credentials. The upstream `list-wallets` command does not refresh tokens or validate authorization, so a successful status read cannot promise that the next signing request will succeed.

For explicit setup through the agent, register the Privy wallet as a separate portfolio with its own chosen targets, then connect the conversation:

```bash
npm run cli -- wallet add --mode privy --wallet <public-address> --targets <five-asset-allocation>
npm run cli -- wallet connect <public-address>
```

The Privy portfolio has its own targets, balances, cadence and pending records. Registration does not inherit another wallet’s state or arm trading; connecting prepares its chart without changing the other runners. A bare skill launch applies to the connected wallet. Login or connection does not fund it. See [wallet portfolios](PORTFOLIOS.md).

## Approval lifecycle and shared-session limits

The onboarding adapter reads only the CLI's public wallet listing and its approval display output. The official CLI retains device codes, OAuth tokens and signing authorization material; those do not enter setup progress, portfolio configuration or logs. Native errors and other output are discarded or replaced with fixed errors. Both output streams are bounded. Approval progress must be saved successfully before setup adopts a wallet. Cancellation or a 599-second approval deadline kills the child; the adapter waits at most one further second for termination confirmation.

The CLI has one session for the local OS user, shared across portfolios. UI logins use an exclusive `~/.cache/rebalance/privy-login.lock` containing only a process ID and ownership token. A concurrent login fails without opening another approval. A crashed adapter or unconfirmed child termination leaves the lock in place; inspect the original login process before clearing an interrupted lock. The adapter never guesses that it is safe to start a second login. Standalone upstream CLI commands do not participate in this application lock, so avoid starting a separate login during UI approval.

Privy 0.3.6 always routes Ethereum RPC requests to the first Ethereum wallet in its session. It has no per-request wallet-ID selector, named session or separate wallet-creation command. The **Privy** option is disabled once a Privy portfolio exists, with a hover explanation of the Sandbox limit. If an older in-flight request returns an address already registered, the dialog requires an explicit **Open existing portfolio** click. Choosing Privy therefore adds or offers to open that available wallet; it does not promise a new, distinct Ethereum wallet. Reauthorization and account switching are explicit agent operations because replacing the global session can affect existing Privy portfolios. The UI never runs logout automatically.

The implementation is covered by isolated fake-process tests for reuse, serialized login, approved URL/code matching, awaited progress, cancellation, deadlines, bounded output and uncertain termination. These tests do not perform a real login or validate current server authorization. The flow and public approval fields are described by [Privy's Agent CLI documentation](https://docs.privy.io/recipes/agent-integrations/agent-cli) and [device authorization documentation](https://docs.privy.io/recipes/agent-integrations/agent-authorization).

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

The CLI's default device authorization, token, wallet authentication and wallet RPC requests use `https://auth.privy.io`. Browser approval, wallet management and funding use `https://agents.privy.io`. The upstream package supports environment overrides for its API base, app ID and browser origin; these are routing settings, not network isolation or a Privy-native transaction policy. The integration does not claim a general outbound network restriction. Runtime subprocess deadlines bound the local wait because the inspected RPC fetch has no explicit timeout. UI onboarding omits the upstream API-base, app-ID and browser-origin environment overrides so that the pinned CLI uses its official sandbox defaults; this is not a general network sandbox.

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
- [x] Adapter and isolated fixture tests validate output, wallet/transaction matching, unavailable signer behavior, explicit nonce/fee fields and unchanged pending/cycle behavior. Signing/public-status subprocesses have a 30-second timeout; UI approval has a separate bounded window described above. No live timeout was induced.
- [ ] Actual Privy authorization and signing on Robinhood 4663 verified with clearly identified evidence.
- [ ] A supported Privy-backed financial flow completes on Robinhood mainnet with receipt evidence, without a per-trade model call or human prompt.
- [ ] Any optional provider-native policy claim has a real allowed/denied test through the selected wallet flow.
- [ ] Working source, demo, wallet/transaction evidence and user-benefit explanation satisfy the selected prize requirements.

No live Privy signing, mainnet API compatibility, swap, policy enforcement, submission, acceptance or award is claimed by documentation or fixture tests.


The New portfolio dialog disables Privy once a Privy portfolio is registered. Hovering the disabled choice (or focusing its wrapper with the keyboard) explains the current Sandbox one-Ethereum-wallet limit. The existing Privy portfolio card stays available. Live portfolio snapshots refresh this state, while the click handler also refuses a duplicate setup request. The explanation stays in the tooltip rather than adding persistent text outside the choices.
