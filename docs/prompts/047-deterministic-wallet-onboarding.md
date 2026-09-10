# Deterministic wallet onboarding — 2026-09-07

## Human requests

> also if I press privy on new portfolio, it should open the privy sign in and automatically do it for me in the UI. local key just happens deterministically, and ledger try to open a new wallet in my ledger

> new raw key wallets should use the same seed btw like how browser wallets work

## Plan before implementation

Replace New portfolio's model-directed setup messages with a local deterministic onboarding job. A validated view handle and request ID scope setup to its conversation. Stream progress directly to the setup dialog and open/connect the ready portfolio through the existing selector. The job never arms trading, signs transactions, changes existing targets or triggers a model. Use the existing default demonstration targets for new portfolios: USDG 5%, AAPL/NVDA/MSFT/AMD 23.75% each. Preserve a provider wallet's existing registered allocation when reused.

New local-key portfolios derive distinct indexed Ethereum accounts from one application-local BIP-39 seed, using the conventional browser-wallet path m/44'/60'/0'/0/index. Create the seed only once and keep it private on disk; never return it in API responses, logs, chat or evidence. Reserve each request's account index durably, and resume the same account after interruption. Reuse the existing raw-key signer by provisioning the derived key into that fresh wallet's isolated directory. Never replace or attempt to retroactively derive the pre-existing standalone wallet from this seed.

Privy uses the installed official @privy-io/agent-wallet-cli 0.3.6. Reuse its existing Ethereum session wallet; otherwise invoke its official login, capture only validated approval URL/display code, and let the provider own authentication and credential storage. The CLI opens its approval page itself and requires the user to complete provider authentication. It does not support another independently selectable Ethereum wallet in the same session, so do not promise one or automatically log out existing portfolios. Keep login serialized and sanitize all other subprocess output.

Ledger uses the official Device Management Kit with Node HID and Ethereum Signer Kit to derive an account and request device address verification. Use separate account indices, never seed initialization/reset. Ethereum addresses are chain-independent; bind the resulting portfolio to Robinhood 4663 without claiming Robinhood-specific device-screen verification. Candidate pins verified from official package metadata: device-management-kit 1.9.0, device-transport-kit-node-hid 1.0.1, device-signer-kit-ethereum 1.18.0, context-module 2.5.0 (Apache-2.0), rxjs 7.8.2 (Apache-2.0). Adopt only required packages and record final versions/licenses. Do not enable telemetry/logging or claim hardware success from fixtures.

Persist setup progress and request identity; preserve generated accounts through registration or view failures. Read/stream endpoints never start a fresh job. Closing a view does not turn setup into trading. Isolated fixtures cover shared-seed derivation, replay, key-file boundaries, provider approval parsing, Ledger cancellation/verification, cross-conversation routing and the UI completion flow. Validate the read-only UI without creating a real provider account or submitting transactions; native login/device approval remain user actions. Update affected skill, architecture/portfolio/provider docs and AI-use evidence. Keep commits local until the pending explicit destination push authorization arrives.
