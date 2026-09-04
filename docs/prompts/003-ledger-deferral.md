# Defer physical Ledger integration — 2026-09-04

## User request (verbatim)

> my ledger device comes in a couple of days so delay that part for now

## Applied sequencing

Defer physical Ledger integration and device validation until the owner confirms arrival. No exact delivery date is assumed. Prioritize the deterministic core, typed agent requests/reviews, Robinhood/Uniswap simulation and the view-only chart. Keep Ledger in the final architecture and prize plan.

The initial interpretation used simulation-only authorization before device arrival. The subsequent [raw-key requirement](004-raw-key-and-privy.md) supersedes that restriction: a real software owner signer is now a first-class alternative, while physical Ledger work remains deferred. Test doubles are still isolated from real authorization.

This is a planning update, not a request to create a scheduled reminder. Earlier prompts and commits remain intact.

## Independent review prompt (verbatim)

> Read-only bounded plan check: user says 'my ledger device comes in a couple of days so delay that part for now'. Root will defer physical Ledger integration until arrival, reorder the next milestone to deterministic core + Robinhood/Uniswap simulation, and retain a non-signing authorization interface/test doubles limited to isolated simulation. Inspect PLAN.md for scheduling/dependency contradictions or claims that must change. Do not implement, edit files, browse, or schedule a reminder; return only material recommendations.
