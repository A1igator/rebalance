# Ledger monitoring and device-confirmed rebalancing

The initial request-driven integration was implemented September 10, 2026 under [prompt 053](prompts/053-ledger-execution.md). [Prompt 075](prompts/075-ledger-direct-device-validation.md), committed as `920f337` before implementation on September 12, changes the normal workflow to direct backend preparation and device prompts. The integration uses the existing pinned Ledger DMK 1.9.0, Node HID transport 1.0.1, Ethereum Signer Kit 1.18.0 and Context Module 2.5.0 on Robinhood mainnet, chain ID 4663.

Physical address onboarding succeeded on the owner's Nano Gen5. The first live rebalance request ended unavailable before a transaction hash was recorded; the owner saw no device prompt. A separate read-only SDK address check succeeded for the selected verified account. Transaction signing, actual display, Clear Signing, rejection and swap evidence remain unverified. Unit fixtures and public-account reads do not establish those outcomes.

## Using an existing Ledger portfolio

Select its card or connect the account through the agent. Selection and wallet setup leave the portfolio unarmed. **Start**, or a full Rebalance skill launch, enables direct device-confirmed rebalancing under its saved allocation; other portfolios continue independently. The backend observes prices, balances, drift and earlier receipts while the device is disconnected. Connect and unlock the Ledger and open Ethereum. When execution conditions permit, the running backend prepares the required approvals/swaps and prompts the device directly. Beginning or advancing a rebalance does not require an agent turn.

Every token approval and swap requires physical confirmation on the Ledger. The graph waits for its receipt, observes fresh balances and obtains a new quote for the next leg. A token approval is not portfolio completion. **Stop** ends monitoring and cancels an outstanding prompt; an already submitted transaction still settles. Connecting a device does not start a stopped portfolio. Notification-only turns report events and never start, advance or retry signing.

After rejection, timeout or execution failure, repeat prompts are suspended. Resolve the cause, then disconnect and reconnect so the runner observes the connection transition, or deliberately retry on the running portfolio with this optional scoped command:

```sh
npm run cli -- --profile <ledger-public-address> ledger rebalance --request-id <new-UUID>
```

The agent can supply the address and a fresh request ID for a requested retry; the user does not need a separate terminal. Omitting the ID creates a UUID, but preserving it across an uncertain command outcome prevents accidental duplicate requests. Inspect `ledger status` for the latest request and ordinary `status` for prompt suspension before deciding what to do next. A queued request is not a signature, submission or completed rebalance. A retry refreshes preparation and still respects pending receipts, fees and cadence. An explicit retry alone cannot clear an unresolved or reverted transaction barrier.

## Deterministic request lifetime and prompt suspension

`src/ledger-request.ts` stores a public per-wallet request journal. The running backend creates requests as conditions permit; the explicit command remains an optional retry/control. Entries bind a UUID to wallet/chain, configuration fingerprint, current runner PID and unique runner-lock token. Requests must be claimed within two minutes and expire ten minutes after creation. The runner writes `consumed` before beginning the graph's quote/signing work. Only the claiming process's in-memory execution context can continue it; neither a restart nor an identical request ID restores consumed authority.

The first dispatched transaction also binds that request to the existing cycle's start/deadline. A request started late in a cycle cannot carry signing into a second cycle. Successful completion remains eligible for future backend-created requests under the saved successful-swap cadence. Normal cooldown and fee waits remain local. Stop, configuration edits, cycle expiry, uncertain send, rejection or a failed traversal clear the current in-memory request. The journal retains prior IDs to reject replay.

Rejection, timeout, unavailable hardware and execution failures durably suspend automatic prompts. Restarting the process cannot reopen a rejected or interrupted attempt. An observed disconnection followed by reconnection, or a new deliberate retry request, releases the suspension for fresh evaluation. All receipt, stop, configuration and cadence checks still apply. Existing failed requests retain suppression when the new code first loads. File/journal failures leave signing unavailable.

A local request-file event or USB presence change wakes a fresh traversal. The existing five-second local control watchdog covers missed file events. Device discovery is a passive hint: it does not connect an APDU session or establish the correct account/app/PIN state. A connection change during preparation ends the current request; reconnect never reuses its unsigned transaction. Before and after signing, dispatch checks the current request, stop state and transaction deadline; a one-second local watchdog cancels a waiting prompt if a stop event was missed.

## Exact transaction signing and receipt handling

`src/ledger-signing.ts` resolves only an indexed account with completed physical address verification from the shared onboarding journal. It reuses onboarding's hardware mutex and native connection/cleanup code, checks public account-zero fingerprint, checks the selected indexed address, and checks the anchor again after signing. It does not read a raw private key, export a seed or silently select another account.

Viem serializes the exact prepared legacy transaction for chain 4663. The device signs those bytes through the official Signer Kit. The returned EIP-155 signature is checked for the chain's expected `v`, valid signature values and recovered sender; the serialized fields must match the prepared transaction. Public diagnostics use fixed stages and error categories to distinguish connection, account readiness, metadata/signing, fallback and invalid-signature failures. Raw signatures, keys, provider credentials and arbitrary SDK error payloads are never persisted, logged or sent to the chat. Only the common dispatch path broadcasts, after persisting the known transaction hash. Unknown send results keep that hash and block a second send.

Ledger uses normal receipt reconciliation with two observed confirmations. It never signs an automatic same-nonce cancellation. An unresolved hash remains a receipt barrier; a mined reverted transaction retains its record for the existing explicit receipt-recovery workflow (`acknowledge-revert` after verified onchain failure). Another `ledger rebalance` request alone does not clear that barrier. Routine raw-key/Privy recovery is unchanged.

## Display, network and sponsor evidence

Metadata/context resolution uses the official Context Module. Signing report/analytics methods are replaced with no-ops; metadata requests can still contact Ledger infrastructure and expose the chain/contract/selector needed for resolution. RPC remains an external trust dependency. No consensus-verifying light client or Key Ring credential broker is introduced by this change.

The pinned Signer Kit can announce a fallback after a failed signing path; the adapter cancels that second attempt instead of silently reopening it. This does not prove transactions are Clear Signed. Actual device wording, token metadata and Robinhood contract support must be checked on the physical screen. No blind-signing setting, credential, device app installation or firmware change is made automatically. No session keys, unattended hardware signing or raw-key fallback are introduced.

The [official ETHOnline Ledger page](https://developers.ledger.com/ethonline) highlights human approval and concrete Ledger primitives and requires tooling feedback. The device approval path is the current implementation. The separate Key Ring direction remains unimplemented. See [SDK provenance](LEDGER_AGENT_STACK.md) and [actual tooling feedback and remaining evidence](LEDGER_FEEDBACK.md).
