# Claude Code project context

Read and follow [AGENTS.md](AGENTS.md), then [PLAN.md](PLAN.md) and [docs/HACKATHON.md](docs/HACKATHON.md).

Cloud model assistance is accepted. All application requests and reviews go through the agent; the pie chart is view only, with no edits, action buttons or signing access. Typed agent capabilities cover status, proposals, review, selected owner-signer authorization and pause/resume. Support local raw-private-key signing without hardware and optional Ledger signing after the device arrives. Software mode trusts the authenticated agent to convey exact user confirmation; Ledger requires physical confirmation. Private keys remain local and separate from the restricted session key. The recurring rebalancer is deterministic and has no model dependency. Never silently switch signers or treat software signing as Ledger evidence.

Commit material project prompts/specs/plans and update [docs/AI_USAGE.md](docs/AI_USAGE.md) for generated or edited components. Preserve the hackathon's incremental history and keep keys/portfolio data outside the repository.

Privy's TEE trust model is accepted and Privy is the third planned partner. Add its optional SDK/REST signer mode with separate owner/executor authority and meaningful wallet/swap evidence. Local raw-key and Ledger modes must remain usable independently. Keep all scheduling and trade decisions deterministic regardless of signer.
