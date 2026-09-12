---
description: Launch Rebalance, select a portfolio, or operate it through the shared skill
---
Use the project's skills/rebalance/SKILL.md for Rebalance.

Requested arguments: $ARGUMENTS

A bare /rebalance is handled by the native Rebalance plugin before this message reaches the model. Report its result once. Do not repeat launch/start/recovery. If no native result is present, report the integration as incomplete instead of substituting a model-driven launch. Nonempty arguments request only their named operation. Wallet setup never authorizes trading.
