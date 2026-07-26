# Executive Summary

An arbitrage bot that trades a **Uniswap v4** pool against a **Sushiswap (V2)**
pair on Ethereum mainnet. It watches both venues for price dislocation, simulates
the round trip before committing, and executes atomically inside the v4
PoolManager's unlock callback.

Because it uses **v4 flash accounting** rather than an external flash loan, it
needs no upfront capital and pays no loan fee — the arbitrage funds itself within
a single transaction, and reverts as a whole if it would not profit.

Ships with a pair scanner that ranks which markets are actually arbitrageable, and
optional risk telemetry that feeds a separate SOAR pipeline.

---

## Problem

Cross-DEX arbitrage is a well-understood strategy with three practical obstacles.

**Capital.** Naively, buying on one venue to sell on another requires holding
inventory. The usual answer is a flash loan, which adds a fee and a dependency on
a third-party lender's liquidity.

**Uniswap v4 broke the standard integration.** v4 replaced per-pair contracts with
a single `PoolManager` singleton. There is no pair address to query, no
`getReserves()` to read, and no per-pool `Swap` event to subscribe to. Every bot
written against V2/V3 needs rebuilding, not porting.

**Most apparent opportunities are not real.** A large, persistent spread between
two venues usually means one side has no liquidity to trade against. Acting on
quoted prices without simulating the actual round trip loses money on slippage
while appearing profitable on paper.

---

## Solution

**Self-funding execution.** `ArbitrageV4.sol` calls `poolManager.unlock()`, then
performs both legs inside the callback. Flash accounting lets it `take()` tokens
before paying for them and settle only the net at the end. If the round trip does
not clear `minProfit`, the whole transaction reverts and the only cost is gas.

**v4-native market data.** Prices come from `StateView.getSlot0()` (`sqrtPriceX96`)
rather than reserves; swaps are detected from PoolManager events filtered by
PoolId; and trade simulation uses the official `V4Quoter`. Native-ETH pools are
supported by wrapping and unwrapping around the Sushiswap leg, which matters
because that is where most v4 ETH liquidity actually sits.

**Verify before trading.** `npm run scan` enumerates every Sushiswap WETH pair
with real reserves, derives the candidate v4 PoolIds directly (all four fee tiers,
native and WETH variants), and probes them. For each match it computes the fee
hurdle, simulates a real round trip in both directions, and samples fourteen days
of historical spreads. Pairs whose spread looks attractive but whose round trip
loses 90%+ are flagged `thin v4 side` rather than ranked as opportunities.

---

## Architecture

```
PoolManager Swap event (filtered by PoolId)
Sushiswap pair Swap event
        │
        v
   checkPrice()          v4: StateView.getSlot0 -> sqrtPriceX96
        │                Sushi: pair reserves
        v
 determineDirection()    which venue to sell WETH on first
        │
        v
determineProfitability() V4Quoter + getAmountsOut, both legs, vs gas
        │
        v
   executeTrade() ──> ArbitrageV4.executeTrade()
                            │
                            v
                     poolManager.unlock()
                            │
                     ┌──────┴───────┐
              start on v4      start on Sushi
                     │              │
              v4 swap +        take() WETH,
              take() quote     Sushi swap,
              Sushi swap       v4 swap back,
              settle() base    settle() + net
```

**Execution paths.** Starting on Uniswap sells WETH into the v4 pool, takes the
quote token, sells it on Sushiswap, then settles the v4 debt — the v4 swap itself
acts as the loan. Starting on Sushiswap flash-takes WETH from the PoolManager,
sells it on Sushi, swaps the proceeds back through v4, and nets the credit against
the debt.

**Pair selection.** The scanner ranks by whether a pair is genuinely tradable
first, then by how often the spread cleared the fee hurdle. Output is written to a
config-ready `pair-report.json`.

---

## Technologies

| Layer | Choice | Notes |
|---|---|---|
| Contracts | Solidity 0.8.26, Cancun EVM | v4 requires transient storage |
| DEX | Uniswap v4 (`PoolManager`, `StateView`, `V4Quoter`) | Singleton architecture, flash accounting |
| DEX | Sushiswap V2 router/pairs | The other side of the arbitrage |
| Framework | Hardhat 2.29 | Mainnet-fork testing |
| Client | ethers v6, Node 20 (`.nvmrc`) | WebSocket subscriptions |
| RPC | Alchemy | Mainnet + fork pinning |
| Batching | Multicall3 | Scanner probes hundreds of pools per call |
| Telemetry | AWS SDK v3 (DynamoDB, SSM) | Optional; see Security |

---

## Deployment

Requires Node 20+ (`nvm use`) and an Alchemy mainnet key.

```bash
npm install
cp .env.example .env      # fill in ALCHEMY_API_KEY, PRIVATE_KEY, ARB_FOR/ARB_AGAINST
npx hardhat test          # mainnet-fork suite
```

Local run:

```bash
npx hardhat node
npx hardhat run scripts/deploy.js --network localhost   # copy address into config.json
node bot.js
npx hardhat run scripts/manipulate.js --network localhost  # create an opportunity
```

Choosing a pair:

```bash
npm run scan     # ranks tradable pairs, writes pair-report.json
```

Then set `ARB_AGAINST` to the chosen `quoteToken` and copy that entry's `v4Pool`
settings into `config.json` under `UNISWAP_V4.POOL`.

`PROJECT_SETTINGS.isLocal` switches between the local Hardhat node and mainnet;
`isDeployed` controls whether a detected opportunity actually calls the contract —
set it `false` to monitor mainnet without deploying anything.

---

## Security

**The contract cannot be drained by a caller.** `executeTrade` is `onlyOwner`, and
`unlockCallback` rejects any caller that is not the PoolManager. Profit accrues in
the contract and is withdrawn by the owner.

**`minProfit` is the real safety mechanism.** The whole arbitrage is one
transaction; if the round trip does not clear the threshold, it reverts and only
gas is lost. There is no partially-executed state to unwind.

**Token assumptions are explicit.** The contract assumes standard ERC-20
`approve`/`transfer` semantics. Fee-on-transfer and rebasing tokens are not
supported — the scanner flags them (for example AMPL) as `UNSAFE` rather than
ranking them, because they would silently break the settle step.

**Telemetry holds no keys.** The optional SOAR integration is granted
`dynamodb:PutItem` on one table and `ssm:GetParameter` on one flag. It cannot sign
a transaction, and it cannot alter the pipeline it reports to. It is **off by
default**: with `SOAR_ENABLED` unset, `helpers/soar.js` makes no AWS call at all
and the bot behaves exactly as it does without the integration.

**Failure directions are deliberate.** Emitting telemetry is fail-open — an error
is logged and swallowed, so monitoring can never stop trading. Reading the halt
flag is fail-safe — on an SSM error the last known value is kept, so a transient
outage cannot silently un-halt a halted bot.

**Never commit `.env`.** It holds a funded private key. `.gitignore` covers it.

---

## Repository Structure

```
contracts/
  ArbitrageV4.sol        flash-accounting arbitrage inside unlockCallback
bot.js                   event loop: watch -> price -> simulate -> execute
helpers/
  initialization.js      PoolManager, StateView, V4Quoter, Sushi, contract handles
  helpers.js             PoolKey/PoolId construction, price math, simulation
  soar.js                optional risk telemetry + halt-flag check
  server.js              health endpoint
scripts/
  deploy.js              deploy ArbitrageV4
  scan-pairs.js          rank arbitrageable pairs -> pair-report.json
  manipulate.js          create a local opportunity for testing
test/
  Arbitrage.js           mainnet-fork suite
config.json              v4 addresses, target pool, Sushiswap addresses
```

---

## Lessons Learned

**A persistent spread is usually a liquidity mirage.** The first scanner run
ranked WETH/IMX and WETH/AAVE at the top — spreads above the fee hurdle on 14 of
14 days. Their probe round trips lost over 98%: the v4 side held dust. The spread
persisted *because* nobody could trade it. Ranking now requires a realistic round
trip before a pair is considered at all.

**v4 is a rewrite, not a port.** No pair addresses, no reserves, no per-pool
events. Prices come from `sqrtPriceX96` in slot0, pools are identified by hashing
a `PoolKey`, and the Quoter replaces reserve math. Assuming a V2 mental model
produces code that compiles and is wrong.

**Flash accounting removed a dependency, not just a fee.** Replacing the Balancer
flash loan with v4's `take`/`settle` eliminated both the fee and the exposure to
one lender's shrinking liquidity — the Balancer vault holds far less than it used
to.

**Hardcoded decimals are a silent bug.** The inherited helpers assumed 18 decimals
for every token. That is correct for WETH and DAI and wrong for USDC (6), which
would have produced price calculations off by twelve orders of magnitude.

**Pin the fork block.** Unpinned fork tests re-fetch mainnet state on every run —
slow, and subtly non-deterministic when liquidity shifts underneath. `FORK_BLOCK_NUMBER`
took the suite from ~60s and intermittent failures to ~6s and stable.

---

## Future Improvements

**Quoter-driven optimal sizing.** `ARB_AMOUNT` is fixed. Profit as a function of
trade size is concave, so a ternary search over the quoter would find the
profit-maximising size in roughly 15–20 calls — well inside one block. This is
likely worth more P&L than any additional pair.

**v4-versus-v4 arbitrage.** Trading two fee tiers of the same pair (0.05% against
0.30% ETH/USDC) keeps both legs inside the PoolManager, so the round trip is
cheaper and both sides are deep. The contract needs only modest changes.

**Private transaction submission.** Public mempool submission invites sandwiching.
Flashbots Protect or a similar relay would reduce that, and would make the
`SANDWICH_SUSPECTED` telemetry event actionable rather than observational.

**Multi-pair monitoring.** The bot watches one pair; the scanner already produces a
ranked list. Watching the top N concurrently is mostly bookkeeping.

**Richer telemetry.** `SLIPPAGE_EXCEEDED` and `PROFIT_ANOMALY` are scored by the
SOAR pipeline but not yet emitted — both require comparing simulated to realized
output after execution.
