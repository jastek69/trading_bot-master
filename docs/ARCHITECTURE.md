# Architecture

Diagrams for the Uniswap v4 ↔ Sushiswap arbitrage bot. The README has the design narrative. This page is the visual reference.

## Components

```mermaid
flowchart LR
    subgraph Off-chain ["Off-chain — Node / ethers v6"]
        BOT[bot.js<br/>event loop] --> H[helpers/helpers.js<br/>PoolKey · PoolId · price math]
        BOT --> INIT[helpers/initialization.js<br/>contract handles]
        BOT --> SOAR[helpers/soar.js]
        SCAN[scripts/scan-pairs.js] --> RPT[(pair-report.json)]
        RPT -. copy entry .-> CFG[(config.json)]
        CFG --> BOT
    end
    subgraph On-chain ["Ethereum mainnet"]
        PM[Uniswap v4 PoolManager]
        SV[StateView]
        Q[V4Quoter]
        SUSHI[Sushiswap V2 router + pairs]
        MC[Multicall3]
        ARB[ArbitrageV4.sol]
    end
    BOT -->|Swap events by PoolId| PM
    BOT -->|getSlot0| SV
    BOT -->|simulate| Q
    BOT -->|reserves / getAmountsOut| SUSHI
    BOT -->|executeTrade — onlyOwner| ARB
    SCAN -->|batched probes| MC
    ARB <-->|unlock / unlockCallback| PM
    ARB --> SUSHI
    SOAR -. "SOAR_ENABLED only<br/>PutItem + GetParameter" .-> AWS[(DynamoDB events<br/>SSM halt flag)]
```

## Decision loop

```mermaid
flowchart TD
    E[Swap event on either venue] --> HALT{halt flag set?}
    HALT -->|yes| SKIP[skip — log]
    HALT -->|no| P[checkPrice<br/>v4 sqrtPriceX96 vs Sushi reserves]
    P --> D{spread > PRICE_DIFFERENCE?}
    D -->|no| WAIT[wait for next event]
    D -->|yes| DIR[determineDirection]
    DIR --> SIM[determineProfitability<br/>V4Quoter + getAmountsOut − gas]
    SIM --> OK{profitable?}
    OK -->|no| WAIT
    OK -->|yes, isDeployed| EX[executeTrade]
    OK -->|yes, monitor-only| LOG[log opportunity]
```

## Atomic execution — start on Sushiswap

```mermaid
sequenceDiagram
    autonumber
    participant B as Bot (owner)
    participant A as ArbitrageV4
    participant PM as v4 PoolManager
    participant S as Sushiswap
    B->>A: executeTrade(startOnUniswap = false, amount, minProfit)
    A->>PM: unlock(data)
    PM->>A: unlockCallback(data)
    A->>PM: take(WETH, amount)  — owed, not yet paid
    A->>S: swap WETH → token
    A->>PM: swap token → WETH (v4 pool)
    A->>PM: settle(WETH) — net only
    alt profit < minProfit
        A-->>B: revert (only gas lost)
    else
        A-->>B: profit stays in contract for owner
    end
```

Starting on Uniswap mirrors this: the v4 swap itself acts as the loan and is settled after the Sushiswap leg.
