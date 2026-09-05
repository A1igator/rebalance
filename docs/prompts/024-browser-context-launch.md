# Browser-context launch framing — 2026-09-05

## Human input and native evidence

The user submitted the canonical Rebalance skill suggestion after the requested Desktop reload check. The visible message contains one automatically supplied `in-app-browser-context` block, the heading `## My request:`, and only the canonical skill link in the request section. The user continues to request launch through that skill, with no separate arming command.

For the first time, the real local hook diagnostic records entry: `2026-09-05T16:29:47.059Z`, `UserPromptSubmit`, `promptLength=477`, `promptFormat=other-with-command`, `selection=ignored`, `workspace=inside`, `planMode=false`. Public status remains unarmed and the notification event queue is empty. This establishes native hook entry and exact-match rejection, not a successful launcher dispatch or trade.

The model-visible framing is a candidate explanation for the rejected input. A literal reconstruction measured 475 characters before any surrounding host whitespace; the recorded native length is 477. No raw native payload was captured, so neither exact payload equality nor host serialization is claimed.

## Correction plan

1. Recognize the complete observed framing: one fixed ambient browser-context block, bounded single-line tab-count/URL data, one exact `## My request:` heading, and an entire request section matching typed `$rebalance` or the canonical skill link.
2. Treat browser metadata only as ignored context. Never use a URL, tab count, command found inside context, or the wrapper's apparent origin as launch authority. No generic substring search, recursive unwrapping, arbitrary Markdown normalization or extra prose is accepted.
3. Preserve Plan-mode, workspace and identity checks, stable request deduplication, stop-generation handling and unknown-start reporting. Classify this framing in the existing local diagnostic without storing prompt/URL text. Do not change the native hook definition or trust settings.
4. Test both accepted requests inside this framing through isolated unconfigured fixtures with network blocked. Reject scoped/quoted/prose requests, altered or nested wrappers, multiple headings, extra context lines and unrelated destinations. Never replay the real funded request or start its runner.
5. Update skill, plans and disclosures; commit and push on main. The next actual user submission can establish whether the candidate framing correction matches Desktop input and reaches the launcher.

An independent read-only reviewer checked the proposed framing boundaries. It recommended complete anchoring and exact request-tail matching, and cautioned that text matching cannot authenticate a wrapper as host-generated. No settings, live hook, wallet or trading state were changed during review.
