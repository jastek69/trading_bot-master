# Security Policy

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Email **jastek.sweeney@gmail.com** with a description, reproduction steps, and the affected commit.

This is a portfolio / research project and **has not been audited**. Running it on mainnet puts real funds at risk, including through MEV (see below).

## Security model

| Control | Where | What it prevents |
|---|---|---|
| `onlyOwner` on `executeTrade` | `ArbitrageV4.sol` | Anyone triggering trades with the contract's funds |
| `msg.sender == poolManager` in `unlockCallback` | `ArbitrageV4.sol` | Direct calls to the callback |
| `minProfit` + whole-transaction revert | `ArbitrageV4.sol` | Losing trades, since the only cost of a bad trade is gas |
| Owner-only withdrawal of profit | `ArbitrageV4.sol` | Profit extraction by third parties |
| Scanner marks fee-on-transfer and rebasing tokens `UNSAFE` | `scripts/scan-pairs.js` | Silent breakage of the `settle` step |

**What this does *not* protect against:**

- **Sandwiching and front-running.** Transactions go to the public mempool. Private submission (Flashbots Protect or similar) is a listed future improvement.
- **Non-standard ERC-20s.** Only standard `approve` / `transfer` semantics are supported.
- **Owner key compromise.**

## Secrets

| Secret | Location | Notes |
|---|---|---|
| `PRIVATE_KEY` | `.env` (gitignored) | **A funded key.** Never commit it, never paste it into an issue, and use a dedicated low-balance account. Not required for tests. |
| `ALCHEMY_API_KEY` | `.env` / CI secret | |
| AWS credentials (telemetry) | Standard AWS credential chain | Never in this repo |

`hardhat.config.js` attaches `PRIVATE_KEY` to the `mainnet` network only when it's set, so tests and compilation never need it.

## Failure directions (deliberate)

| Path | Fails | Why |
|---|---|---|
| Emitting telemetry | **Open.** Errors are logged and swallowed. | Monitoring must never stop trading. |
| Reading the SSM halt flag | **Safe.** The last known value is kept. | A transient outage must never un-halt a halted bot. |

The optional SOAR integration is off unless `SOAR_ENABLED` is set. When on, it's intended to run with an IAM identity limited to `dynamodb:PutItem` on one table and `ssm:GetParameter` on one parameter.

## Recommended checks before any mainnet use

```bash
npm test                      # fork suite green at a recent pinned block
npm run scan                  # confirm the configured pair is still tradable
npm audit --omit=dev
slither .                     # static analysis
```
