# Trim Details and link the wallet explorer — 2026-09-10

During the PR #20 merge, the human requested: “can we remove things from detail that exists on the main page like address and remove latest trade too but rather the address button should link to the robhinhood scanner so people can see it there”. This supersedes the prior copy-address click behavior; retain the compact public address at the top of the chart.

## Plan before implementation

After committing the validated PR merge, remove the Latest Trade block and its now-unused rendering code from Details. Keep unique fee and cadence information; do not duplicate the top address or current center status there. Change the top address control to open the displayed wallet on the official Robinhood mainnet Blockscout explorer in a separate tab, preserving the companion. Generate the destination only from a valid public address, omit navigation when unavailable, prevent sending the local view fragment as a referrer, and retain wallet-specific Start/Stop and conversation attachment.

Update focused UI tests and current usage docs, visually verify the simplified panel and exact explorer destination, commit and push main. No trading, wallet creation, signing, seed access or allocation changes are authorized by these display edits.

## Source

Robinhood's official network setup documentation (https://docs.robinhood.com/chain/add-network-to-wallet/), checked 2026-09-10, identifies https://robinhoodchain.blockscout.com as the mainnet explorer for chain 4663. Use its `/address/<public-wallet>` route. Do not send any local view capability or private data to the explorer.
