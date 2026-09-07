# Wallet portfolios and conversation connections

Each Robinhood wallet has one independent portfolio. Targets, observed holdings, pending transactions, recovery records, cadence, stop state, process locks and event queues belong to that wallet. The same chain/address cannot be registered twice under different signer names. Changing the chat's connection never transfers assets or changes another wallet's allocation or runner.

A local-key or Privy portfolio runs its deterministic background process once armed. It continues when the agent and chart disconnect. Ledger portfolios still await the hardware adapter for signing. There is no LLM supervisor or shared trading loop deciding between wallets; each process uses the existing graph and is pinned to its own storage before importing runtime modules.

The pinned Privy CLI exposes one first-Ethereum session wallet and no per-request wallet selector. App storage is independent, but this MVP does not add multiple concurrent Privy logins; a session/address mismatch blocks signing. See [the Privy adapter limits](PRIVY.md).

## Agent commands

All user interaction stays in the conversation. The agent operates:

```bash
npm run cli -- wallet list
npm run cli -- wallet add --wallet <public-address> --mode privy --targets USDG=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75
npm run cli -- wallet connect <public-address>
npm run cli -- --profile <public-address> status
```

The percentages are an example; each new wallet requires its own explicitly supplied allocation. `wallet add` registers configuration only and leaves trading unarmed. Privy login supplies a public wallet address but does not silently register it, inherit another portfolio's targets or move its assets. An additional raw-key portfolio can be registered with its public address and have its own ignored key file provisioned locally; do not paste keys into the agent. Initial `wallet create` retains the original local-wallet setup behavior and cannot create a replacement key inside an already registered portfolio.

`wallet connect` saves this conversation's selection and runs setup-only to prepare/reuse that wallet's chart. It neither arms nor stops trading. A chart failure is reported separately from the saved connection. A bare skill invocation retains its full-launch meaning for the connected wallet; other running wallets continue. Explicit `launch --all` launches each registered wallet independently; `launch --all --setup-only` prepares their views without arming. Batch output preserves a separate result for every wallet, including unknown or failed launches. Do not retry a wallet whose start outcome is unknown without checking its status.

Without `--profile`, ordinary commands refer to this conversation's saved wallet. With multiple wallets and no saved attachment, the agent lists the wallets and asks which one to connect. A sole portfolio is selected automatically. `--profile <address>` overrides command scope without changing attachment; use it for notifications and operations directed at a different portfolio.

The CLI uses `REBALANCE_SESSION_ID` or the host's `CODEX_THREAD_ID` when available. If the host does not expose a stable session identity to shell commands, the agent supplies `--session <native-session-id>` consistently from the host's trusted session context. Claude's hook uses `claude:<native-session-id>`; Codex uses its native session ID. Do not invent a session identity or use the working directory, current browser URL or a global last-selected wallet as a conversation identifier.

## Storage and compatibility

The public registry is `.local/portfolios.json`. It maps chain 4663 and normalized wallet address to a data directory and chart port. Additional wallets use `.local/wallets/<lowercase-address>/`; conversation attachments are separate hashed files in `.local/connections/`.

The existing legacy wallet stays directly in `.local/` on chart port 4663. Registration adopts its public identity in place. No key, nonce, pending transaction, recovery record, cycle, event history or live process lock is copied or moved. This lets the original running wallet continue during the migration. New chart ports start at 4664 and remain assigned in the registry. A port occupied by an unrelated service is reported unavailable rather than replaced.

Commands and subprocesses receive the wallet directory, chart port and expected wallet identity explicitly. Background workers ignore later changes to chat attachment. Ordinary `configure --wallet` cannot retarget an existing portfolio; use add/connect. Signing-mode changes require the selected runner to be stopped. Invalid or missing configuration for one wallet is reported for that wallet and does not block stopping or inspecting another portfolio.

Each wallet has its own view-only chart URL. Two charts can stay open simultaneously without a global selected-wallet variable. No dropdown or extra chart controls are added.

## Hooks and notifications

Native skill hooks persist request-to-wallet routing in `.local/hook-routes/` before reading that wallet's stop marker or installing dependencies. A replay stays on its original wallet even if the chat connects elsewhere. Legacy request receipts retain their original directory. An incomplete or corrupt routing receipt blocks the request rather than selecting a different wallet.

Event history, acknowledgements, filters and delivery journals stay in the producing wallet's directory. Codex prompts identify the source wallet and carry explicit `--profile` scope for status, events and acknowledgement. Claude channels resolve their wallet before importing state modules and retain that selection for the channel's lifetime. Reconnecting a chat does not redirect an already queued event or its acknowledgement.

Notification bindings remain per wallet. Connecting a different chat does not steal an existing wallet's notification destination, and a newly registered wallet has no destination until configured through the existing notification setup. No scheduled LLM sweep is introduced. Existing Claude channels need a normal reconnect to load the updated routing code; phone delivery remains unverified.

## Validation

Isolated tests cover different allocations and state, two simultaneous background workers without real network/signing, independent stop behavior, separate chart HTTP/SSE streams, chat selection and explicit scope, source-wallet acknowledgement, native replay affinity, missing/corrupt configuration and duplicate identity rejection. Production migration checks use only public state and setup-only chart work. Registering an unfunded wallet or showing its targets is not a live swap or successful provider authorization.
