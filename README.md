# Trading Bot — Uniswap v4

Arbitrage bot that trades a **Uniswap v4** pool against a **Sushiswap (V2)** pair.

Instead of borrowing from an external flash loan provider (the old version used Balancer), the
`ArbitrageV4` contract uses **v4 flash accounting**: all swaps run inside the PoolManager's
`unlock` callback and only net balances settle at the end of the transaction — no upfront
capital and no flash loan fee.

## Technology Stack & Tools

- Solidity 0.8.26 (Cancun EVM — required by v4's transient storage)
- Javascript (Node 20+, see `.nvmrc`)
- [Hardhat](https://hardhat.org/) (Development Framework)
- [Ethers.js v6](https://docs.ethers.org/v6/) (Blockchain Interaction)
- [Alchemy](https://www.alchemy.com/) (Blockchain Connection)
- [Uniswap v4](https://docs.uniswap.org/contracts/v4/overview) (PoolManager, StateView, V4Quoter)
- [Sushiswap](https://www.sushi.com/) (V2 router/pairs — Sushi has no v4)

## Architecture

### On-chain: `contracts/ArbitrageV4.sol`
- `executeTrade(TradeParams)` (owner-only) calls `poolManager.unlock()`.
- Inside `unlockCallback`:
  - **Start on Uniswap** (`startOnUniswap = true`): sell WETH/ETH on the v4 pool, `take()` the
    output token, sell it for WETH on Sushiswap, then `settle()` the v4 debt. The v4 swap
    itself acts as the flash loan.
  - **Start on Sushiswap** (`startOnUniswap = false`): flash-`take()` WETH/ETH from the
    PoolManager, sell it on Sushiswap, swap the proceeds back through the v4 pool, and net
    the credit against the debt.
- Supports **native ETH pools** (currency0 = `0x0`, where most v4 liquidity lives) by
  wrapping/unwrapping WETH around the Sushiswap leg.
- `minProfit` makes unprofitable trades revert instead of settling at a loss.
- Profit accrues in the contract (WETH or ETH); withdraw with `withdrawToken`/`withdrawETH`.

### Off-chain: `bot.js`
v4 has no pair contracts — all pools live in the PoolManager singleton, identified by a
`PoolId` (the hash of the `PoolKey`: currency0, currency1, fee, tickSpacing, hooks).
- Swap events are read from the **PoolManager**, filtered by PoolId.
- Prices come from **StateView** (`getSlot0` → `sqrtPriceX96`) instead of reserves.
- Trade simulation uses the **V4Quoter** for the v4 leg and `getAmountsOut` for the Sushi leg.

Default pair: the **ETH/USDC 0.05%** v4 pool (native ETH, fee 500, tick spacing 10, no hooks)
against Sushiswap's WETH/USDC pair. Change the pool in `config.json` (`UNISWAP_V4.POOL`) and
the tokens in `.env`.

## Requirements For Initial Setup
- Install [NodeJS](https://nodejs.org/en/) **v20+** (see `.nvmrc`; `nvm use` will pick it up).
- Create an [Alchemy](https://www.alchemy.com/) account with an Ethereum mainnet app.

## Setting Up
### 1. Install Dependencies
`npm install`

### 2. Create and Setup .env
Copy `.env.example` to `.env` and fill in:

- **ALCHEMY_API_KEY=""**
- **ARB_FOR=""** — WETH (`0xC02a...756Cc2`); the token profit is measured in
- **ARB_AGAINST=""** — USDC by default (`0xA0b8...eB48`)
- **PRIVATE_KEY=""** — account that calls the arbitrage contract
- **PRICE_DIFFERENCE=0.50** — % spread between v4 & Sushiswap required to attempt a trade
- **ARB_AMOUNT=0.5** — WETH traded into the first leg
- **UNITS=0** — price display only
- **GAS_LIMIT=600000** / **GAS_PRICE=0.00000006** — used for profitability estimates
- **FORK_BLOCK_NUMBER** — optional; pins fork tests to a block (faster, cacheable)

### 3. Run the Tests (mainnet fork)
`npx hardhat test`

The tests deploy `ArbitrageV4` on a fork, create a price discrepancy by dumping USDC into the
Sushiswap pair, and verify a profitable Sushi → v4 arbitrage plus the revert paths.

### 4. Start Hardhat Node (local testing)
`npx hardhat node`

### 5. Deploy Smart Contract
In a separate terminal:
`npx hardhat run scripts/deploy.js --network localhost`

Copy the deployed address into **ARBITRAGE_ADDRESS** inside *config.json*.

### 6. Start the Bot
`node bot.js`

### 7. Manipulate Price
In another terminal:
`npx hardhat run scripts/manipulate.js --network localhost`

This impersonates a USDC whale and dumps USDC into the Sushiswap pair, pushing the WETH price
up on Sushi so the bot detects a "sell on Sushiswap, buy on Uniswap v4" opportunity.

## Pair Scanner

`npm run scan` (or `node scripts/scan-pairs.js`) finds and ranks every viable arbitrage pair:

1. Enumerates all Sushiswap pairs containing WETH with reserves above `MIN_WETH_RESERVE` (default 3 WETH).
2. Derives the candidate v4 PoolIds for each token directly (hookless pools, 4 standard fee
   tiers, native-ETH and WETH variants) and probes them via StateView — no event scanning.
3. For each match, measures the current spread, the fee hurdle (v4 fee + 0.30% Sushi + gas),
   a real round-trip simulation of `PROBE_AMOUNT` WETH in both directions (V4Quoter + router),
   and how many of the past `SAMPLE_DAYS` days the spread exceeded the hurdle (archive samples).
4. Ranks results and writes a config-ready `pair-report.json`.

How to read the output:
- **"tradable"** means the probe round trip lands near the fee hurdle — both sides are deep
  enough to actually execute. A pool showing "thin v4 side" with a persistently large spread
  is a mirage: the v4 pool exists but has dust liquidity, which is *why* the spread persists.
- **UNSAFE** flags tokens the contract cannot trade correctly (rebasing/fee-on-transfer, e.g. AMPL).
- To adopt a pair: set `ARB_AGAINST` to its `quoteToken` in `.env` and copy its `v4Pool`
  settings into `config.json` under `UNISWAP_V4.POOL`.

Env knobs: `MIN_WETH_RESERVE`, `PROBE_AMOUNT`, `SAMPLE_DAYS`.

## SOAR risk telemetry (optional)

The bot can emit risk events to the blockchain SOAR stack (the `SEIR-1` Terraform
root), which correlates them, has Bedrock write an incident narrative, and raises
an incident with SNS notification. See `helpers/soar.js`.

**It is off by default and the bot does not depend on it.** With `SOAR_ENABLED`
unset, every call in `helpers/soar.js` is a no-op, no AWS SDK call is made, and
the bot behaves exactly as it does without the integration. Emit failures are
logged and swallowed — telemetry can never stop trading.

What it emits today: `TRADE_REVERTED` when an arbitrage transaction fails, and
`BOT_ERROR` when profitability simulation throws. Both carry the pair, the
direction, and the failure reason.

What it reads: `/defi/tb/trading-halted`. If the SOAR stack raises a CRITICAL
finding for this bot *and* auto-halt is enabled on that stack, the flag is set
and the bot skips execution until a human clears it. The halt check is cached
for 30s, and if SSM is unreachable the last known value is kept rather than
assuming "not halted".

To enable: set the variables in `.env.example` under *SOAR risk telemetry*, and
attach the `defi-tb-event-writer` IAM policy (a `terraform output` of the SOAR
stack) to whichever principal the bot runs as. The bot needs only
`dynamodb:PutItem` on the events table and `ssm:GetParameter` on its halt flag —
it is never given credentials that can modify the SOAR pipeline itself.

## About config.json
Under `PROJECT_SETTINGS`:
- **isLocal** — `true`: bot connects to `ws://127.0.0.1:8545` (hardhat node); `false`: mainnet via Alchemy.
- **isDeployed** — whether the arbitrage contract is called when a trade is found. Set `false`
  to monitor mainnet opportunities without a deployed contract.

`UNISWAP_V4` holds the mainnet [deployment addresses](https://docs.uniswap.org/contracts/v4/deployments)
(PoolManager, StateView, V4Quoter) and the target `POOL` parameters. `USE_NATIVE_ETH` should
stay `true` for native-ETH pools (most v4 ETH liquidity); set it `false` for a WETH-denominated pool.

## Anatomy of bot.js
The bot is composed of 5 functions:
- *main()* — resolves the PoolKey/PoolId and Sushi pair, subscribes to Swap events on both venues
- *checkPrice()* — v4 price from StateView slot0, Sushi price from reserves; returns the % difference
- *determineDirection()* — decides which venue to sell WETH on first (`startOnUniswap`)
- *determineProfitability()* — simulates both legs (V4Quoter + `getAmountsOut`) for `ARB_AMOUNT` and
  compares the round trip against the estimated gas cost
- *executeTrade()* — calls `arbitrage.executeTrade({ key, startOnUniswap, amountIn, minProfit })`
  and reports balances

## Limitations & Notes
- The quote token must be a standard ERC-20 (no fee-on-transfer / non-standard approve like USDT).
- Sushiswap's mainnet V2 pools are much thinner than they used to be — check pair liquidity
  before sizing trades (`ARB_AMOUNT`).
- Hook pools: pools with a non-zero hooks address may add fees or custom behavior the
  simulation doesn't model; the default targets a hookless pool.
- After running *manipulate.js*, restart the hardhat node and re-deploy to retest cleanly.
