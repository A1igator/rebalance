# Feasibility and trust assumptions

Research date: **2026-09-04**. These findings come from primary documentation, not a completed installation, device test, node synchronization or transaction. Revalidate deployment identities and runtime behavior before implementation uses them.

Current decisions are in [PLAN.md](../PLAN.md), [network candidates](NETWORK.md) and the [Ledger Agent Stack assessment](LEDGER_AGENT_STACK.md). Robinhood remains viable, with Base as an alternative. Raw-key and Privy profiles execute automatically under configured policy; Ledger waits for device confirmation. Earlier vault/session-key architecture is superseded.

## Robinhood network and assets

Robinhood documents mainnet **4663** and testnet **46630**, with ETH gas, an Arbitrum L2 architecture and Ethereum blob data availability. Public RPC access is available but does not prove returned state. [Network reference](https://docs.robinhood.com/chain/connecting/)

Stock Tokens are issuer-backed debt securities that provide economic exposure; they are not direct ownership of the underlying shares. Mint/redemption and transfer/access restrictions remain part of the asset model. Real-asset eligibility must be checked for the actual participant and use; do not infer it from a local timezone. Use labelled simulated/test assets until acquisition and demo eligibility are verified. [Stock Token reference](https://docs.robinhood.com/chain/stock-tokens/)

The platform documents RFQ trading at launch and AMM composability. A Uniswap deployment does not establish liquid pools for a particular stock. Verify token contracts, tradability, pool identity, depth and price sources as separate gates. [Trading integration](https://docs.robinhood.com/chain/building-with-stock-tokens/), [canonical contracts](https://docs.robinhood.com/chain/contracts/)

Stock price feeds already incorporate corporate-action multipliers. They update 24/5, so the engine needs explicit freshness/calendar behavior, sequencer uptime and recovery checks, and `oraclePaused()` handling. Confirm canonical proxies, decimals, heartbeat values and available onchain checks before permitting automated valuation. [Oracle integration](https://docs.robinhood.com/chain/oracles-and-price-feeds/)

## Uniswap deployment

Uniswap's **July 1, 2026** announcement states that v2, v3, v4 and UniswapX are live on Robinhood mainnet. Direct protocol integration is therefore a plausible path. [Launch announcement](https://developers.uniswap.org/docs/changelog/completed-notifications/uniswapx-live-on-robinhood-chain)

The official v4 registry lists Robinhood mainnet contracts. Testnet 46630 was not listed in the v4 testnet table reviewed. Choose and record one supported version, contract set, route and license during the first spike. Do not infer addresses from another chain. Verify chain ID, deployed code and any proxy implementation against canonical sources before signing. [Canonical v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments)

If target testnet deployments/liquidity are unavailable, use a clearly labelled local fork or a test deployment of upstream contracts under their applicable licenses. Distinguish upstream protocol work from the original rebalancer implementation. Do not call a self-deployed test pool an official deployment or suggest that mock stock tokens represent real equities.

## Local verification

Robinhood's full-node guide calls for Nitro, Ethereum execution and beacon endpoints, at least **64 GB RAM** (128 GB recommended), and several TB of NVMe storage. This is not a lightweight laptop deployment. Verify L1 inputs and bootstrap assumptions when evaluating independent L2 execution. [Full-node guide](https://docs.robinhood.com/chain/run-a-full-node/)

Helios documents Ethereum, OP Stack/Base and Linea support; its reviewed documentation does not establish Robinhood/Nitro support. A custom chain ID or endpoint is insufficient. A light-client claim needs an actual compatible state-proof, L1 anchoring and finality verification path. [Helios README](https://github.com/a16z/helios/blob/master/README.md)

Robinhood also documents permissioned BoLD validation and Security Council upgrade powers. A locally verified execution path does not remove these assumptions or issuer backing risk. [Governance](https://docs.robinhood.com/chain/governance/)

Decision: support a labelled RPC integration first; evaluate node/light-client attachment for the selected network. Treat a Robinhood light client as research-only unless verified. Base has documented Helios support, but stock precompile compatibility remains unverified. Report unavailable verification rather than silently switching modes.

## Ledger

Scheduling update, **2026-09-04**: the owner's device is expected in a couple of days. Defer physical integration and verification until arrival is confirmed; proceed with deterministic core, Ledger component evaluation and an actual raw-key testnet Uniswap flow. Local simulation remains a test tool. The findings below are design references, not hardware evidence.

Current Ethereum Signer Kit documentation supports raw transactions and EIP-712 typed data. Its default context module requires a Ledger-issued `originToken`; a custom context interface is documented. Hardware signing support does not prove meaningful display for this project's chain and policy. [Signer reference](https://developers.ledger.com/docs/device-interaction/dmk-ts/references/signers/eth)

Use DMK/Ethereum Signer Kit for the integration spike. Ledger's August 4 migration guidance says legacy `hw-app-eth` stops working with its Ethereum app after September 2026. [Migration guidance](https://developers.ledger.com/docs/device-interaction/dmk-ts/integration/migrations/signers/eth/hw_app_eth_to_dmk)

Test actual device/app versions, the selected chain ID, domain separation, typed-data fields, token display, reject/disconnect flows and outbound context requests. Full context resolution involves partner integration in the current wallet guidance; determine whether a local custom context path meets this prototype's needs. No origin token, device or compatibility result was acquired in this planning session. [Wallet integration](https://developers.ledger.com/docs/clear-signing/for-wallets), [token display support](https://developers.ledger.com/docs/clear-signing/for-dapps/token-support)

Decision: provide explicit local raw-key, Ledger and Privy backends behind one deterministic operation interface. All application requests/reviews go through the agent; the chart has no signing transport or controls. Raw-key/Privy profiles automatically execute valid policy-bounded swaps with no per-trade human or LLM input. Ledger adds physical confirmation through a native bridge. Direct owner wallets suffice; no separate session-key/vault contract is planned. Verify native hardware transport after arrival. Software signing is not Ledger evidence.

Privy is the third planned prize target with an optional automatic signer mode. The owner accepts its hosted TEE trust model. Its agent/headless SDK/REST integration and supported authorization policies remain to be verified in code. See [the prize and architecture assessment](PRIVY.md).

## Open gates to close with evidence

| Gate | Required evidence | If unavailable |
| --- | --- | --- |
| Assets and acquisition | Canonical addresses, transfer behavior, actual eligibility and allowed demo use | Test/simulated assets |
| Uniswap integration | Canonical contracts/code, supported route, pool state and sufficient depth | Labelled fork/test pools |
| Price enforcement | Feed addresses/semantics, freshness and sequencer checks, independent onchain output bound | Capped test-fund demo only |
| Ledger | Physical device signing/display and local context path | Disclose gap; no completed Ledger claim |
| Automatic execution | Deterministic recipient/route/budget/expiry checks, persistent accounting, verified Privy controls where used | Pause invalid/unconfigured profiles; do not claim local limits are onchain restrictions |
| Light verification | Working selected-chain verification path, including relevant native token behavior and finality assumptions | Document RPC/full-node modes |
| Local privacy | Outbound-request inspection and secret/data isolation | Disclose services and data sent |

Cloud LLM assistance is accepted by the owner for this hackathon. No local model is a delivery prerequisite. The agent translates configuration requests and presents results without receiving keys. Routine raw-key/Privy automation works with the agent closed; only Ledger mode claims an independent physical authorization step.
