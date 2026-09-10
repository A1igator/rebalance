# Ledger monitoring and device-confirmed rebalancing

Implemented September 10, 2026 under [prompt 053](prompts/053-ledger-execution.md). The integration uses the existing pinned Ledger DMK 1.9.0, Node HID transport 1.0.1, Ethereum Signer Kit 1.18.0 and Context Module 2.5.0. It targets Robinhood mainnet, chain ID 4663. Physical address onboarding succeeded on the owner's Nano Gen5; transaction signing, display and swap/rejection evidence still need a live device run. Unit fixtures are labelled and do not establish those outcomes.

## Using an existing Ledger portfolio

Select its card or connect the account through the agent. **Start** enables its public-address monitor; other portfolios continue independently. The monitor observes prices, balances, drift and earlier receipts while the device is disconnected. Start, attaching the chat, USB connection, notifications and wallet setup do not authorize signatures.

When a rebalance is needed, connect and unlock the Ledger and open Ethereum. Ask the agent to rebalance that Ledger portfolio. For an explicitly requested rebalance, the scoped command is:

```sh
npm run cli -- --profile <ledger-public-address> ledger rebalance --request-id <new-UUID>
```

The agent supplies the address and one request ID; the user does not need a separate terminal. Omitting the ID creates a UUID, but preserving it across uncertain command outcomes prevents accidental duplicate requests. Read the result with `ledger status` or ordinary `status`; a queued request is not a signature, submission or completed rebalance. Notification-only turns only report events and never call this command.

Each token approval and swap is prepared independently and confirmed physically on the Ledger. The graph waits for its receipt, then observes balances and obtains a new quote for the next leg. A token approval is not portfolio completion. The chart's ordinary Stop ends monitoring and cancels an outstanding prompt; a transaction already submitted still settles.

The monitor must already be running to accept a signing request. A missing/wrong/locked device, rejection, timeout, changed connection, changed configuration or failed traversal ends the request. Reconnect and issue a new explicit rebalance request after resolving the cause. The background graph does not reopen a rejected prompt. An alert acknowledged by the chat is still deduplicated for the same drift condition.

## Deterministic request lifetime

`src/ledger-request.ts` stores a public per-wallet request journal. Entries bind a UUID to wallet/chain, configuration fingerprint, current runner PID and unique runner-lock token. Requests must be claimed within two minutes and expire ten minutes after creation. The runner writes `consumed` before beginning the graph's quote/signing work. Only the claiming process's in-memory execution context can continue it; neither a restart nor an identical request ID restores authority.

The first dispatched transaction additionally binds that request to the existing cycle's start/deadline. A request started late in a cycle cannot carry signing into a second cycle. Normal successful-swap cadence remains unchanged. Stop, configuration edits, cycle expiry, uncertain send, rejection or a failed traversal clear the in-memory request. File-write failures also clear it. The journal retains prior IDs to reject replay.

A local request-file event or USB presence change wakes a fresh traversal immediately. The existing five-second local control watchdog covers missed file events. Device discovery is a passive hint: it does not connect an APDU session or establish the correct account/app/PIN state. A disconnected request or connection change during preparation is ended instead of using an old prepared transaction after reconnect. Before and after signing, dispatch checks the current request, stop state and transaction deadline; a one-second local watchdog cancels a waiting prompt if a stop event was missed.

## Exact transaction signing and receipt handling

`src/ledger-signing.ts` resolves only an indexed account with completed physical address verification from the shared onboarding journal. It reuses onboarding's hardware mutex and native connection/cleanup code, checks public account-zero fingerprint, checks the selected indexed address, and checks the anchor again after signing. It does not read a raw private key, export a seed or silently select another account.

Viem serializes the exact prepared legacy transaction for chain 4663. The device signs those bytes through the official Signer Kit. The returned EIP-155 signature is checked for the chain's expected `v`, valid signature values and recovered sender; the serialized fields must match the prepared transaction. Raw signatures and SDK errors are never logged or sent to the chat. Only the common dispatch path broadcasts, after persisting the known transaction hash. Unknown send results keep that hash and block a second send.

Ledger uses normal receipt reconciliation with two observed confirmations. It never signs an automatic same-nonce cancellation. An unresolved hash remains a receipt barrier; a mined reverted transaction retains its record for the existing explicit receipt-recovery workflow (`acknowledge-revert` after verified onchain failure). Another `ledger rebalance` request alone does not clear that barrier. Routine raw-key/Privy recovery is unchanged.

## Display, network and sponsor evidence

Metadata/context resolution uses the official Context Module. Signing report/analytics methods are replaced with no-ops; metadata requests can still contact Ledger infrastructure and expose the chain/contract/selector needed for resolution. RPC remains an external trust dependency. No consensus-verifying light client or Key Ring credential broker is introduced by this change.

The pinned Signer Kit can announce a fallback after a failed signing path; the adapter cancels that second attempt instead of silently reopening it. This does not prove all other transactions are Clear Signed. Actual device wording, token metadata and Robinhood contract support must be checked on the physical screen. No blind-signing setting, credential, device app installation or firmware change is made automatically.

The [official ETHOnline Ledger page](https://developers.ledger.com/ethonline) highlights human approval and concrete Ledger primitives and requires tooling feedback. The device approval path is the current implementation. The separate Key Ring direction remains unimplemented. See [SDK provenance](LEDGER_AGENT_STACK.md) and [actual tooling feedback and remaining evidence](LEDGER_FEEDBACK.md).
