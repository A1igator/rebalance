# Implementation start — 2026-09-04

Human inputs, in order:

> let's do it

In response to the assistant asking which public wallet address and allocation to use:

> just make a new wallet

> also make it as an agent graph

In response to the graph clarification question, the human supplied:

> [https://robcressy.com/blog/loops-to-graphs-ai-agent-systems](https://robcressy.com/blog/loops-to-graphs-ai-agent-systems)

> since it's tied to agent and unusable without them. unsure if mcp is needed either

> and the whole intractable UI is just one session right (outside the pie chart). Not sure if starting it with a skill also makes sense

Implementation interpretation: one existing Codex/Claude conversation is the interactive interface. A repository skill routes user intent to typed CLI commands. Agent target-setting, deterministic observation/planning/execution and independent receipt reconciliation share local state, with explicit graph nodes/edges. No embedded model service, extra chat session or MCP server is needed; routine monitoring still runs without model calls when the coding agent closes. The cited article supplies the conceptual graph framing, not a technical library or protocol requirement.

The accepted next milestone is a working TypeScript application: verify a Robinhood mainnet route, implement deterministic allocation and raw-key execution, agent commands, transaction recovery and a local view-only chart. Ledger hardware work remains deferred. No alternate chain, testnet demo, session keys, spending caps or budget accounting is introduced. The new wallet is generated locally; its private key must never enter tool output or Git. A live swap requires actual funding and configured targets; read-only quotes are not receipts.

The assistant interprets the graph request as an explicit application state graph, with deterministic recurring nodes and an agent-only configuration boundary; clarification was requested while independent work continued. Record any correction below.

## Material delegated tasks

### Network spike

Implementation authorized 'let's do it'. Own bounded network spike: verify actual Robinhood mainnet4663 publicRPC and official token/router/quoter/pool addresses; find executable Uniswap route for first live assets (ETH/WETH/USDC candidate, no fakepools/assets). Read official docs and perform READ-ONLY JSON-RPC on mainnet (chainId, blockNumber, code, pool/tokenmetadata, quote eth_call); no wallet credentials/signing/broadcast/funding. Preserve request/response evidence sanitized in docs/evidence/robinhood-mainnet.json and concise docs/ROUTE_CHECK.md; write only those2files, nootheredits. If RPCunavailable/sourcefacts inconsistent expose honestly and don't invent addresses. Need exact chainmanifest proposal with v3 preferably if official router/quoter/liquidity available; v4 ifnecessary. Root scaffolding viem client and readonly UI alongside. Send early knownendpoint/addresses then final measured findings.

### Allocation core

Implement pure deterministic allocation module + meaningful tests now. Own src/core.ts and tests/core.test.ts only. TypeScript ESM, Node built-in node:test via tsx, no added deps or package edits. Export types AssetPosition {id:string,symbol:string,decimals:number,balance:bigint,priceUsdE8:bigint,targetBps:number}; Portfolio {totalUsdE8:bigint, positions: (AssetPosition & {valueUsdE8:bigint,weightBps:number,driftBps:number})[]}; evaluatePortfolio(positions):Portfolio; redistributeTargets(targets:Record<string,number>, assetId:string, targetBps:number):Record<string,number> using proportional largest-remainder stableid rounding totals10000, handle100%zerootherweights deterministic or reject explained; planTrade(portfolio,quoteAssetId,driftThresholdBps): {sellAssetId:string,buyAssetId:string,amountIn:bigint,reason:string}|null. One corrective trade via quote asset, choose sell overweight first then buy underweight withavailablequote, avoid floating financialmath; preservebaseunit integerconservation, no spendingcaps/budgetaccounting. RejectduplicateIDs invalidweights decimalsinvalidnegativebalance/pricezero etc. Add tests realedge rounding/dust/zeroportfolio/threshold/directquote cases. Root owns codeplumbing/state/signers/cli; UIagent will read a serialized portfolio. Do not gitcommit or touchotherfiles. Record no mainnetclaim. Send APIadjustments promptly.

### Read-only chart

Implement local readonly portfolio UI only in ui/index.html ui/app.js ui/style.css (3files). No framework/deps/build, no secrets, all humaninteraction remains through external codingagent; NO buttons/forms/links/actioncontrols/walletconnect. Polished dark minimalist pie/donut current allocations, adjacent target allocation comparison, assettable, wallet/network/status and latest operation. Fetch GET /api/status every5sec; expected JSON {app:'Rebalance',chain:{id:4663,name:'Robinhood'},mode:'private-key'|'privy'|'ledger'|null,wallet:string|null,config:{targets:Record<string,number>}|null,portfolio:{totalUsdE8:string,positions:[{id,symbol,decimals,balance:string,priceUsdE8:string,targetBps:number,valueUsdE8:string,weightBps:number,driftBps:number}]}|null,operation:{status:string,hash?:string,message?:string}|null,updatedAt:string|null,error:string|null}. Empty state attractive/informative says configure through agent. All assetsbundledlocal, SVG/CSS donut notremote; displayfinancialvaluesconvertforpresentationonly coremathelsewhere. HandleRPCerror/loading/0 holdings, escape rendered text usingtextContent notuntrustedHTML. Avoid fakeassetdata initialportfolio null. Colorstableperasset. Responsive, accessiblecontrast, no hovercontrolrequirements (viewonly). Root HTTP serves these routes. Don't gitcommit or touchotherfiles. Send summary whencomplete.

## Root implementation specification

One ESM TypeScript app. Use integer bps/base units, a mainnet manifest backed by live read-only evidence, and one v3 pool. The initial quote currency is the verified canonical USDG; displayed values are indicative USDG equivalents, not independently verified USD prices. Save config, wallet and pending transaction locally and ignore them in Git. Sign raw transactions locally, persist the deterministic transaction hash before dispatch, and reconcile receipts before planning again. Persist unknown outcomes without blind retries. Keep the HTTP server read only and bound to loopback. Implement graph nodes as ordinary deterministic code, with no model or graph-service dependency. Do not claim Ledger, Privy, light-client or live-swap completion from unit tests.

Official Ledger DMK implementation skill read at LedgerHQ/agent-skills commit `2edb3937d80dec28f46c87c29aae841e6874fc7d`; it is guidance for the deferred hardware adapter, not evidence of hardware execution. No private information was redacted from this prompt record because no secret was requested or received.
