# Testing

## What is tested

`test/Arbitrage.js` runs against a **mainnet fork**, meaning the real Uniswap v4 PoolManager, Sushiswap router, and token contracts at a real block. Uniswap v4's singleton, flash accounting, and transient storage aren't worth mocking. The bugs worth catching live in how this contract interacts with the real ones.

| Group | Test | Asserts |
|---|---|---|
| Deployment | Sets the poolManager / sushiRouter / owner | Constructor wiring |
| Trading | Profits from a Sushiswap → Uniswap v4 arbitrage | After manipulating the Sushi price with an impersonated USDC whale, `executeTrade` settles and leaves the contract **more** WETH |
| | Reverts when `minProfit` is not met | The whole transaction reverts, with no partial state |
| | Blocks non-owners from trading | `onlyOwner` holds |

## Running

Prerequisites: Node 20 (`nvm use` reads `.nvmrc`) and an Alchemy mainnet key.

```bash
npm install
cp .env.example .env          # set ALCHEMY_API_KEY (PRIVATE_KEY not needed for tests)
npm test                      # = npx hardhat test
```

### Pin the fork block

Set `FORK_BLOCK_NUMBER` in `.env`. That took the suite from about 60 s with intermittent failures to about 6 s and stable. When you move the pin, re-check that the target v4 pool in `config.json` still has liquidity at that block. A pool that was deep last month can be dust now.

### Coverage and gas

```bash
npx hardhat coverage
REPORT_GAS=true npx hardhat test
```

## Scanner verification (`npm run scan`)

The pair scanner is a verification tool in its own right. It doesn't trust quoted spreads. For each candidate pair it:

1. Simulates a real round trip in both directions through `V4Quoter` and Sushiswap.
2. Samples 14 days of historical spreads against the fee hurdle.
3. Flags pairs whose round trip loses 90% or more as `thin v4 side`, and flags fee-on-transfer or rebasing tokens as `UNSAFE`.

Treat a pair as tradable only after the scanner ranks it. Never go by spread alone.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

| Step | Needs secrets? | Runs |
|---|---|---|
| `npm ci` + `npx hardhat compile` | No | Always |
| `npx hardhat test` (mainnet fork) | `ALCHEMY_API_KEY` | Only when the repository secret is set |

## Not covered (known gaps)

- **Start-on-Uniswap path.** The trading test exercises the Sushiswap-first direction.
- **Native-ETH v4 pools** (wrap and unwrap around the Sushi leg) have no dedicated test.
- **`bot.js` event loop and `helpers/soar.js`** have no automated tests. They're verified manually with `scripts/manipulate.js` against a local node.
