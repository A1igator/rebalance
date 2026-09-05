# Demo allocation — 2026-09-04

Exact human requests:

> you can come up with the allocation you think makes sense

> I feel like usdg should be like 5%. people don't hold much cash for obvious reasons

The assistant initially chose equal 20% weights as an easily explained hackathon demonstration, then followed the user's cash-weight correction. Final targets are **USDG 5% and TSLA, AAPL, NVDA, AMZN 23.75% each**. This is a demo configuration, not a return forecast or a claim about an appropriate cash balance for investors generally.

The agent ran `configure --targets USDG=20,TSLA=20,AAPL=20,NVDA=20,AMZN=20`, followed by `targets set USDG 5` and `status`. The deterministic proportional redistribution produced 500 basis points of USDG and 2375 for each stock, totaling 10000. A subsequent read-only `check` succeeded at Robinhood block 54732359; all five holdings and native ETH were zero. The chart showed the new targets and Monitor Stopped. No signing, funding or transaction occurred.

The private local configuration and wallet details remain outside Git. A bounded parallel task was asked to record these decisions in this prompt, PLAN and AI_USAGE while the root checked the portfolio. The root completed that documentation after stopping the unfinished documentation task; no subagent edits or additional validation are claimed.
