# Settings header and gas-payment alternatives — 2026-09-10

The human asked whether Alchemy accepts x402/SIWX wallet authentication and whether Flashbots or blockbuilders could accept USDG instead of using the Alchemy paymaster. Research current official documentation; distinguish API request payments from transaction gas and distinguish supported Robinhood services from hypothetical relayers. Do not change gas transport, provision billing or sign anything for this comparison.

The human also requested that Settings open with its header above the contents, rather than a bottom drawer, while leaving the rest of the page stationary.

## Plan before implementation

Keep the Settings section outside chart layout, but lay out its header before the animated content within that section. Preserve open/close animation, reduced-motion behavior, keyboard accessibility and the three existing setting rows. Verify open/closed geometry and narrow companion layout without operating Start/Stop or editing live wallet settings. Record results and push to main.

## Follow-up before navigation implementation

The human reports that Back still appears broken and Settings still looks unchanged. Each chart currently holds two long-lived HTTP/1 streams, including while hidden; many companion tabs can exhaust browser connections before a navigation or stylesheet finishes. Suspend read-only chart/view/setup streams when their document is hidden and resume on visibility/pageshow. Preserve per-conversation attachment and reset the selector's selection baseline on resume so it does not bounce back to a wallet. Verify background-tab release and reconnection with isolated fixtures; do not pause a portfolio runner.

## Gas transport constraints

The human requests no developer API-key setup, with a relayer acceptable regardless of provider; otherwise revert the paymaster. Trust minimization and direct Uniswap/Ledger/Privy integrations remain priorities. Alchemy documents wallet-based RPC/data access but its ERC-20 gas flow still requires an app key and policy. Check other actual Robinhood/USDG services before choosing a replacement; chain metadata alone is not a live fee quote, valid signing policy or completed execution. Do not add custody, session keys, blind remote-hash signing or undisclosed fee-payment trust.

## Hosted execution follow-up

The human asks for an off-the-shelf Calibur relayer on Robinhood, prefers no backend to operate, and specifically suggests UniswapX or a similar intent protocol. Research hosted execution before proposing a self-operated relay. Distinguish no hosted backend from no API key, and distinguish gasless fills from initial token approvals. Do not infer acceptance of developer credentials or operate a relayer from this research request.
