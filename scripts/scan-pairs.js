require("dotenv").config()

const fs = require("fs")
const path = require("path")
const ethers = require("ethers")

const config = require("../config.json")
const { getPoolId } = require("../helpers/helpers")

/**
 * Pair scanner: finds and ranks WETH pairs that can be arbitraged between
 * Uniswap v4 and Sushiswap by the bot.
 *
 * Strategy: enumerate every Sushiswap pair containing WETH with meaningful
 * reserves, then derive the candidate v4 PoolIds for the same token directly
 * (hookless pools across the 4 standard fee tiers, in both native-ETH and
 * WETH flavors) and probe them via StateView -- no event scanning needed.
 * For each (Sushi pair, v4 pool) match it measures:
 *   - depth on both venues
 *   - the round-trip fee hurdle (v4 fee + 0.30% Sushi fee + gas)
 *   - the current spread and a probe round-trip via the V4Quoter
 *   - how often the spread cleared the hurdle over the past N days (archive samples)
 *
 * Usage: node scripts/scan-pairs.js
 * Env knobs: MIN_WETH_RESERVE (default 3), PROBE_AMOUNT (default 0.5),
 *            SAMPLE_DAYS (default 14)
 */

// -- CONFIGURE VALUES HERE -- //
const MIN_WETH_RESERVE = ethers.parseEther(process.env.MIN_WETH_RESERVE || "3")
const PROBE_AMOUNT = ethers.parseEther(process.env.PROBE_AMOUNT || "0.5")
const SAMPLE_DAYS = Number(process.env.SAMPLE_DAYS || 14)
const BLOCKS_PER_DAY = 7160 // ~12s blocks
const GAS_PER_TRADE = 600000n

const WETH = config.TOKENS.WETH
const NATIVE = "0x0000000000000000000000000000000000000000"
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"

const FEE_TIERS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
]

// A probe round trip worse than this means one side is too thin to actually
// trade at PROBE_AMOUNT; the "spread" there is a mirage.
const THIN_POOL_RT_PCT = -5

// Tokens the bot's contract cannot safely trade (rebasing / fee-on-transfer).
// Grow this list as the scanner surfaces new candidates.
const UNSAFE_TOKENS = {
  "0xD46bA6D942050d489DBd938a2C909A5d5039A161": "AMPL (rebasing)",
}

const provider = new ethers.JsonRpcProvider(
  `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
)

// -- INTERFACES -- //
const factoryIface = new ethers.Interface([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
])
const pairIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])", // router
])
const routerIface = new ethers.Interface([
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
])
const ercIface = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
])
const stateViewIface = new ethers.Interface([
  "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
  "function getLiquidity(bytes32) view returns (uint128)",
])
const quoterIface = new ethers.Interface([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
])

const multicall = new ethers.Contract(MULTICALL3, [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
], provider)

/** Batched aggregate3 with chunking; returns [{success, returnData}] */
async function batchCall(calls, blockTag) {
  const CHUNK = 300
  const results = []
  for (let i = 0; i < calls.length; i += CHUNK) {
    const chunk = calls.slice(i, i + CHUNK)
    const res = await multicall.aggregate3.staticCall(chunk, blockTag ? { blockTag } : {})
    results.push(...res)
    await new Promise(r => setTimeout(r, 100)) // be gentle with the RPC
  }
  return results
}

function buildKey(token, { fee, tickSpacing }, useNative) {
  const base = useNative ? NATIVE : WETH
  const [currency0, currency1] =
    BigInt(base) < BigInt(token) ? [base, token] : [token, base]
  return {
    key: { currency0, currency1, fee, tickSpacing, hooks: NATIVE },
    baseIsZero: currency0 === base,
  }
}

/** quote tokens per 1 WETH from slot0's sqrtPriceX96 */
function v4Price(sqrtPriceX96, baseIsZero, quoteDecimals) {
  const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2 // currency1 per currency0, raw units
  const adj = 10 ** (18 - quoteDecimals)
  return baseIsZero ? raw * adj : (1 / raw) * adj
}

/** quote tokens per 1 WETH from pair reserves */
function sushiPrice(pair) {
  const wethReserve = Number(pair.wethReserve) / 1e18
  const quoteReserve = Number(pair.quoteReserve) / 10 ** pair.decimals
  return quoteReserve / wethReserve
}

async function main() {
  const latestBlock = await provider.getBlockNumber()
  const feeData = await provider.getFeeData()
  const gasCostEth = Number(GAS_PER_TRADE * (feeData.gasPrice || 0n)) / 1e18
  const gasPct = (gasCostEth / Number(ethers.formatEther(PROBE_AMOUNT))) * 100

  console.log(`Block: ${latestBlock} | Gas cost/trade: ~${gasCostEth.toFixed(5)} ETH (${gasPct.toFixed(3)}% of ${ethers.formatEther(PROBE_AMOUNT)} WETH probe)\n`)

  // -- 1. ENUMERATE SUSHISWAP PAIRS -- //
  const factory = new ethers.Contract(config.SUSHISWAP.FACTORY_ADDRESS, factoryIface, provider)
  const pairCount = Number(await factory.allPairsLength())
  console.log(`Sushiswap factory reports ${pairCount} pairs. Fetching addresses...`)

  const addrCalls = []
  for (let i = 0; i < pairCount; i++) {
    addrCalls.push({
      target: config.SUSHISWAP.FACTORY_ADDRESS,
      allowFailure: false,
      callData: factoryIface.encodeFunctionData("allPairs", [i]),
    })
  }
  const pairAddresses = (await batchCall(addrCalls)).map(
    r => factoryIface.decodeFunctionResult("allPairs", r.returnData)[0]
  )

  // -- 2. TOKENS + RESERVES FOR EVERY PAIR -- //
  console.log(`Fetching tokens & reserves for ${pairAddresses.length} pairs...`)
  const metaCalls = pairAddresses.flatMap(addr => [
    { target: addr, allowFailure: true, callData: pairIface.encodeFunctionData("token0") },
    { target: addr, allowFailure: true, callData: pairIface.encodeFunctionData("token1") },
    { target: addr, allowFailure: true, callData: pairIface.encodeFunctionData("getReserves") },
  ])
  const metaResults = await batchCall(metaCalls)

  const wethLower = WETH.toLowerCase()
  const candidates = []
  for (let i = 0; i < pairAddresses.length; i++) {
    const [t0Res, t1Res, resRes] = metaResults.slice(i * 3, i * 3 + 3)
    if (!t0Res.success || !t1Res.success || !resRes.success) continue

    const token0 = pairIface.decodeFunctionResult("token0", t0Res.returnData)[0]
    const token1 = pairIface.decodeFunctionResult("token1", t1Res.returnData)[0]
    const [r0, r1] = pairIface.decodeFunctionResult("getReserves", resRes.returnData)

    let quoteToken, wethReserve, quoteReserve
    if (token0.toLowerCase() === wethLower) {
      [quoteToken, wethReserve, quoteReserve] = [token1, r0, r1]
    } else if (token1.toLowerCase() === wethLower) {
      [quoteToken, wethReserve, quoteReserve] = [token0, r1, r0]
    } else {
      continue // the bot only trades WETH-based pairs
    }

    if (wethReserve < MIN_WETH_RESERVE) continue
    candidates.push({ pairAddress: pairAddresses[i], quoteToken, wethReserve, quoteReserve })
  }
  console.log(`${candidates.length} WETH pairs with >= ${ethers.formatEther(MIN_WETH_RESERVE)} WETH in reserves\n`)

  // -- 3. TOKEN METADATA -- //
  const tokenCalls = candidates.flatMap(c => [
    { target: c.quoteToken, allowFailure: true, callData: ercIface.encodeFunctionData("symbol") },
    { target: c.quoteToken, allowFailure: true, callData: ercIface.encodeFunctionData("decimals") },
  ])
  const tokenResults = await batchCall(tokenCalls)
  for (let i = 0; i < candidates.length; i++) {
    const [symRes, decRes] = tokenResults.slice(i * 2, i * 2 + 2)
    if (!decRes.success) { candidates[i].skip = true; continue }
    candidates[i].decimals = Number(ercIface.decodeFunctionResult("decimals", decRes.returnData)[0])
    try {
      candidates[i].symbol = ercIface.decodeFunctionResult("symbol", symRes.returnData)[0]
    } catch {
      candidates[i].symbol = candidates[i].quoteToken.slice(0, 10) // bytes32-style symbols
    }
  }

  // -- 4. PROBE UNISWAP V4 FOR MATCHING POOLS -- //
  // Hookless pools only: 4 standard fee tiers x { native ETH, WETH } variants.
  const pools = []
  for (const c of candidates.filter(c => !c.skip)) {
    for (const tier of FEE_TIERS) {
      for (const useNative of [true, false]) {
        const { key, baseIsZero } = buildKey(c.quoteToken, tier, useNative)
        pools.push({ pair: c, tier, useNative, key, baseIsZero, poolId: getPoolId(key) })
      }
    }
  }

  console.log(`Probing ${pools.length} candidate v4 pools (${FEE_TIERS.length} fee tiers x native/WETH)...`)
  const liqCalls = pools.map(p => ({
    target: config.UNISWAP_V4.STATE_VIEW_ADDRESS,
    allowFailure: true,
    callData: stateViewIface.encodeFunctionData("getLiquidity", [p.poolId]),
  }))
  const liqResults = await batchCall(liqCalls)

  const livePools = []
  for (let i = 0; i < pools.length; i++) {
    if (!liqResults[i].success) continue
    const liquidity = stateViewIface.decodeFunctionResult("getLiquidity", liqResults[i].returnData)[0]
    if (liquidity > 0n) livePools.push({ ...pools[i], liquidity })
  }
  console.log(`${livePools.length} live v4 pools found\n`)

  if (livePools.length === 0) {
    console.log("No matches - try lowering MIN_WETH_RESERVE")
    return
  }

  // -- 5. CURRENT PRICES & SPREAD -- //
  const slotCalls = livePools.map(p => ({
    target: config.UNISWAP_V4.STATE_VIEW_ADDRESS,
    allowFailure: true,
    callData: stateViewIface.encodeFunctionData("getSlot0", [p.poolId]),
  }))
  const slotResults = await batchCall(slotCalls)
  for (let i = 0; i < livePools.length; i++) {
    const p = livePools[i]
    if (!slotResults[i].success) { p.skip = true; continue }
    const [sqrtPriceX96] = stateViewIface.decodeFunctionResult("getSlot0", slotResults[i].returnData)
    p.uPrice = v4Price(sqrtPriceX96, p.baseIsZero, p.pair.decimals)
    p.sPrice = sushiPrice(p.pair)
    p.spreadPct = ((p.uPrice - p.sPrice) / p.sPrice) * 100
    p.hurdlePct = (p.tier.fee / 1e6) * 100 + 0.30 + gasPct
  }

  // -- 6. PROBE ROUND TRIP (both directions) VIA QUOTER + ROUTER -- //
  console.log(`Simulating ${ethers.formatEther(PROBE_AMOUNT)} WETH round trips on ${livePools.length} pools...`)
  const rtCalls = livePools.flatMap(p => [{
    // leg 1 of "start on Uniswap": sell WETH on v4
    target: config.UNISWAP_V4.QUOTER_ADDRESS,
    allowFailure: true,
    callData: quoterIface.encodeFunctionData("quoteExactInputSingle", [{
      poolKey: p.key, zeroForOne: p.baseIsZero, exactAmount: PROBE_AMOUNT, hookData: "0x",
    }]),
  }, {
    // leg 1 of "start on Sushi": sell WETH on Sushiswap
    target: config.SUSHISWAP.V2_ROUTER_02_ADDRESS,
    allowFailure: true,
    callData: routerIface.encodeFunctionData("getAmountsOut", [PROBE_AMOUNT, [WETH, p.pair.quoteToken]]),
  }])
  const rtResults = await batchCall(rtCalls)

  // second legs depend on first-leg outputs, so a second batch
  const rt2Calls = []
  for (let i = 0; i < livePools.length; i++) {
    const p = livePools[i]
    const [v4Leg, sushiLeg] = rtResults.slice(i * 2, i * 2 + 2)
    p.v4Out = v4Leg.success ? quoterIface.decodeFunctionResult("quoteExactInputSingle", v4Leg.returnData)[0] : 0n
    p.sushiOut = sushiLeg.success ? routerIface.decodeFunctionResult("getAmountsOut", sushiLeg.returnData)[0][1] : 0n
    rt2Calls.push({
      // close "start on Uniswap": sell quote tokens on Sushi
      target: config.SUSHISWAP.V2_ROUTER_02_ADDRESS,
      allowFailure: true,
      callData: routerIface.encodeFunctionData("getAmountsOut", [p.v4Out > 0n ? p.v4Out : 1n, [p.pair.quoteToken, WETH]]),
    }, {
      // close "start on Sushi": sell quote tokens on v4
      target: config.UNISWAP_V4.QUOTER_ADDRESS,
      allowFailure: true,
      callData: quoterIface.encodeFunctionData("quoteExactInputSingle", [{
        poolKey: p.key, zeroForOne: !p.baseIsZero, exactAmount: p.sushiOut > 0n ? p.sushiOut : 1n, hookData: "0x",
      }]),
    })
  }
  const rt2Results = await batchCall(rt2Calls)
  const probe = Number(ethers.formatEther(PROBE_AMOUNT))
  for (let i = 0; i < livePools.length; i++) {
    const p = livePools[i]
    const [closeSushi, closeV4] = rt2Results.slice(i * 2, i * 2 + 2)
    const uniFirstBack = (p.v4Out > 0n && closeSushi.success)
      ? Number(ethers.formatEther(routerIface.decodeFunctionResult("getAmountsOut", closeSushi.returnData)[0][1])) : 0
    const sushiFirstBack = (p.sushiOut > 0n && closeV4.success)
      ? Number(ethers.formatEther(quoterIface.decodeFunctionResult("quoteExactInputSingle", closeV4.returnData)[0])) : 0
    p.bestRoundTripPct = ((Math.max(uniFirstBack, sushiFirstBack) - probe) / probe) * 100 - gasPct
    p.bestDirection = uniFirstBack >= sushiFirstBack ? "v4->Sushi" : "Sushi->v4"
  }

  // -- 7. HISTORICAL SPREAD SAMPLES (archive calls) -- //
  console.log(`Sampling spreads daily over the past ${SAMPLE_DAYS} days...\n`)
  for (const p of livePools) { p.daysAboveHurdle = 0; p.samples = 0 }

  for (let day = 1; day <= SAMPLE_DAYS; day++) {
    const blockTag = latestBlock - day * BLOCKS_PER_DAY
    const histCalls = livePools.flatMap(p => [{
      target: config.UNISWAP_V4.STATE_VIEW_ADDRESS,
      allowFailure: true,
      callData: stateViewIface.encodeFunctionData("getSlot0", [p.poolId]),
    }, {
      target: p.pair.pairAddress,
      allowFailure: true,
      callData: pairIface.encodeFunctionData("getReserves"),
    }])

    let histResults
    try {
      histResults = await batchCall(histCalls, blockTag)
    } catch {
      continue // archive data unavailable for this block
    }

    for (let i = 0; i < livePools.length; i++) {
      const p = livePools[i]
      const [slotRes, resRes] = histResults.slice(i * 2, i * 2 + 2)
      if (!slotRes.success || !resRes.success) continue

      const [sqrtPriceX96] = stateViewIface.decodeFunctionResult("getSlot0", slotRes.returnData)
      if (sqrtPriceX96 === 0n) continue // pool didn't exist yet
      const [r0, r1] = pairIface.decodeFunctionResult("getReserves", resRes.returnData)

      const wethIs0 = BigInt(WETH) < BigInt(p.pair.quoteToken)
      const histPair = {
        wethReserve: wethIs0 ? r0 : r1,
        quoteReserve: wethIs0 ? r1 : r0,
        decimals: p.pair.decimals,
      }
      const u = v4Price(sqrtPriceX96, p.baseIsZero, p.pair.decimals)
      const s = sushiPrice(histPair)
      const spread = Math.abs(((u - s) / s) * 100)

      p.samples++
      if (spread > p.hurdlePct) p.daysAboveHurdle++
    }
  }

  // -- 8. RANK & REPORT -- //
  // A pair is only interesting if BOTH sides are deep enough to actually
  // close the round trip (probe RT near the fee hurdle, not -90%). Rank
  // tradable pools first, then by how often the spread cleared the hurdle.
  for (const p of livePools) {
    p.tradable = p.bestRoundTripPct > THIN_POOL_RT_PCT
    p.warning = UNSAFE_TOKENS[ethers.getAddress(p.pair.quoteToken)] || null
  }

  const ranked = livePools
    .filter(p => !p.skip && p.samples > 0)
    .sort((a, b) =>
      (Number(b.tradable) - Number(a.tradable)) ||
      (b.daysAboveHurdle - a.daysAboveHurdle) ||
      (b.bestRoundTripPct - a.bestRoundTripPct) ||
      Number(b.pair.wethReserve - a.pair.wethReserve)
    )

  const rows = ranked.map((p, i) => ({
    "#": i + 1,
    Pair: `WETH/${p.pair.symbol}`,
    "v4 Pool": `${p.tier.fee / 1e4}%${p.useNative ? " (native)" : ""}`,
    "Sushi WETH Depth": Number(ethers.formatEther(p.pair.wethReserve)).toFixed(1),
    "Spread %": p.spreadPct.toFixed(3),
    "Hurdle %": p.hurdlePct.toFixed(3),
    [`Days>Hurdle (${SAMPLE_DAYS}d)`]: `${p.daysAboveHurdle}/${p.samples}`,
    "Probe RT %": p.bestRoundTripPct.toFixed(3),
    Direction: p.bestDirection,
    Note: p.warning ? `UNSAFE: ${p.warning}` : (p.tradable ? "tradable" : "thin v4 side"),
  }))
  console.table(rows)

  // Config-ready output for the top entries
  const report = ranked.map(p => ({
    pair: `WETH/${p.pair.symbol}`,
    tradable: p.tradable,
    warning: p.warning,
    sushiPair: p.pair.pairAddress,
    sushiWethReserve: ethers.formatEther(p.pair.wethReserve),
    quoteToken: p.pair.quoteToken,
    quoteDecimals: p.pair.decimals,
    v4Pool: {
      poolId: p.poolId,
      USE_NATIVE_ETH: p.useNative,
      FEE: p.tier.fee,
      TICK_SPACING: p.tier.tickSpacing,
      HOOKS_ADDRESS: NATIVE,
    },
    currentSpreadPct: p.spreadPct,
    hurdlePct: p.hurdlePct,
    daysAboveHurdle: `${p.daysAboveHurdle}/${p.samples}`,
    probeRoundTripPct: p.bestRoundTripPct,
    bestDirection: p.bestDirection,
  }))

  const outFile = path.join(__dirname, "..", "pair-report.json")
  fs.writeFileSync(outFile, JSON.stringify({ block: latestBlock, generated: new Date().toISOString(), pairs: report }, null, 2))
  console.log(`\nFull report written to ${outFile}`)
  console.log(`\nTo trade a pair: set ARB_AGAINST to its quoteToken in .env and copy its v4Pool settings into config.json (UNISWAP_V4.POOL)`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
