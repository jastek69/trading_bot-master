// -- HANDLE INITIAL SETUP -- //
require('./helpers/server')
require("dotenv").config();

const ethers = require("ethers")
const config = require('./config.json')
const { getTokenAndContract, getPairContract, buildPoolKey, getPoolId, calculateV4Price, calculateSushiPrice, simulate } = require('./helpers/helpers')
const { provider, poolManager, stateView, quoter, sRouter, sFactory, arbitrage } = require('./helpers/initialization')
const { EVENT_TYPES, emitDefiEvent, isTradingHalted, SOAR_ENABLED } = require('./helpers/soar')

// -- .ENV VALUES HERE -- //
const arbFor = process.env.ARB_FOR // This is the address of token we are attempting to arbitrage (WETH)
const arbAgainst = process.env.ARB_AGAINST // USDC
const units = process.env.UNITS // Used for price display/reporting
const difference = process.env.PRICE_DIFFERENCE
const arbAmount = process.env.ARB_AMOUNT || "0.5" // WETH traded into the first leg
const gasLimit = process.env.GAS_LIMIT
const gasPrice = process.env.GAS_PRICE

let poolKey, poolId, baseIsZero, sPair, weth, token, amount
let isExecuting = false

const main = async () => {
  const { token0Contract: wethContract, token0: wethToken, token1: quoteToken } = await getTokenAndContract(arbFor, arbAgainst, provider)
  weth = wethToken
  token = quoteToken

  // Uniswap v4 pool (identified by its PoolKey/PoolId, not a pair contract)
  const pool = buildPoolKey(weth.address, token.address, config.UNISWAP_V4.POOL)
  poolKey = pool.key
  baseIsZero = pool.baseIsZero
  poolId = getPoolId(poolKey)

  const [sqrtPriceX96] = await stateView.getSlot0(poolId)
  if (sqrtPriceX96 === 0n) {
    throw new Error(`Uniswap v4 pool ${poolId} is not initialized. Check UNISWAP_V4.POOL settings in config.json`)
  }

  // Sushiswap still uses V2 pair contracts
  sPair = await getPairContract(sFactory, weth.address, token.address, provider)

  console.log(`Uniswap v4 PoolId: ${poolId}`)
  console.log(`sPair Address: ${await sPair.getAddress()}\n`)

  // v4 emits all Swap events from the PoolManager singleton, filtered by PoolId
  poolManager.on(poolManager.filters.Swap(poolId), async () => {
    await handleSwapEvent('Uniswap v4')
  })

  sPair.on('Swap', async () => {
    await handleSwapEvent('Sushiswap')
  })

  console.log("Waiting for swap event...")
}

const handleSwapEvent = async (_exchange) => {
  if (!isExecuting) {
    isExecuting = true

    const priceDifference = await checkPrice(_exchange)
    const startOnUniswap = await determineDirection(priceDifference)

    if (startOnUniswap === null) {
      console.log(`No Arbitrage Currently Available\n`)
      console.log(`-----------------------------------------\n`)
      isExecuting = false
      return
    }

    const isProfitable = await determineProfitability(startOnUniswap)

    if (!isProfitable) {
      console.log(`No Arbitrage Currently Available\n`)
      console.log(`-----------------------------------------\n`)
      isExecuting = false
      return
    }

    // The SOAR stack sets this flag when it raises a CRITICAL finding for
    // this bot. Clearing it is a human action.
    if (await isTradingHalted()) {
      console.log(`Trading halted by SOAR - skipping execution\n`)
      console.log(`-----------------------------------------\n`)
      isExecuting = false
      return
    }

    await executeTrade(startOnUniswap)

    isExecuting = false
  }
}

const checkPrice = async (_exchange) => {
  isExecuting = true

  console.log(`Swap Initiated on ${_exchange}, Checking Price...\n`)

  const currentBlock = await provider.getBlockNumber()

  const uPrice = await calculateV4Price(stateView, poolId, baseIsZero, weth.decimals, token.decimals)
  const sPrice = await calculateSushiPrice(sPair, weth, token)

  const uFPrice = Number(uPrice).toFixed(units)
  const sFPrice = Number(sPrice).toFixed(units)
  const priceDifference = (((uFPrice - sFPrice) / sFPrice) * 100).toFixed(2)

  console.log(`Current Block: ${currentBlock}`)
  console.log(`-----------------------------------------`)
  console.log(`UNISWAP V4 | ${token.symbol}/${weth.symbol}\t | ${uFPrice}`)
  console.log(`SUSHISWAP  | ${token.symbol}/${weth.symbol}\t | ${sFPrice}\n`)
  console.log(`Percentage Difference: ${priceDifference}%\n`)

  return priceDifference
}

const determineDirection = async (_priceDifference) => {
  console.log(`Determining Direction...\n`)

  if (_priceDifference >= difference) {

    // WETH is more expensive on Uniswap v4: sell it there first
    console.log(`Potential Arbitrage Direction:\n`)
    console.log(`Sell\t -->\t Uniswap V4`)
    console.log(`Buy\t -->\t Sushiswap\n`)
    return true

  } else if (_priceDifference <= -(difference)) {

    // WETH is more expensive on Sushiswap: sell it there first
    console.log(`Potential Arbitrage Direction:\n`)
    console.log(`Sell\t -->\t Sushiswap`)
    console.log(`Buy\t -->\t Uniswap V4\n`)
    return false

  } else {
    return null
  }
}

const determineProfitability = async (_startOnUniswap) => {
  console.log(`Determining Profitability...\n`)

  // This is where you can customize your conditions on whether a profitable trade is possible...

  try {

    const amountIn = ethers.parseUnits(arbAmount, 'ether')

    const { amountIn: wethIn, amountOut: wethOut } = await simulate(amountIn, _startOnUniswap, {
      quoter,
      key: poolKey,
      baseIsZero,
      sRouter,
      wethAddress: weth.address,
      tokenAddress: token.address
    })

    const amountDifference = wethOut - wethIn
    const estimatedGasCost = gasLimit * gasPrice

    // Fetch account
    const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider)
    const ethBalanceBefore = ethers.formatUnits(await provider.getBalance(account.address), 'ether')

    const data = {
      'WETH In': wethIn,
      'WETH Out': wethOut,
      'WETH Gained/Lost': amountDifference,
      '-': {},
      'ETH Balance': ethBalanceBefore,
      'ETH Spent (gas)': estimatedGasCost,
      'Total Gained/Lost': amountDifference - estimatedGasCost
    }

    console.table(data)
    console.log()

    if (Number(wethOut) - Number(wethIn) <= estimatedGasCost) {
      return false
    }

    amount = amountIn
    return true

  } catch (error) {
    console.log(error)
    console.log(`\nError occurred while trying to determine profitability...\n`)
    console.log(`This can typically happen because of liquidity issues, see README for more information.\n`)

    await emitDefiEvent({
      type: EVENT_TYPES.BOT_ERROR,
      pair: `${weth.symbol}/${token.symbol}`,
      detail: `Profitability simulation failed: ${error.shortMessage || error.message}`,
    })

    return false
  }
}

const executeTrade = async (_startOnUniswap) => {
  console.log(`Attempting Arbitrage...\n`)

  // Create Signer
  const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

  // Profit accrues inside the arbitrage contract (as WETH or native ETH)
  const arbitrageAddress = await arbitrage.getAddress()
  const wethContract = new ethers.Contract(weth.address, ["function balanceOf(address) view returns (uint256)"], provider)

  const contractBalanceBefore = await wethContract.balanceOf(arbitrageAddress) + await provider.getBalance(arbitrageAddress)
  const ethBalanceBefore = await provider.getBalance(account.address)

  if (config.PROJECT_SETTINGS.isDeployed) {
    try {
      const transaction = await arbitrage.connect(account).executeTrade(
        {
          key: poolKey,
          startOnUniswap: _startOnUniswap,
          amountIn: amount,
          minProfit: 0
        },
        { gasLimit: process.env.GAS_LIMIT }
      )

      await transaction.wait()
    } catch (error) {
      // A revert here is the routine outcome of losing the race, so this is
      // not an error path for the bot - but the SOAR correlation agent needs
      // the signal to spot a run of them.
      console.log(`Trade failed: ${error.shortMessage || error.message}\n`)

      await emitDefiEvent({
        type: EVENT_TYPES.TRADE_REVERTED,
        pair: `${weth.symbol}/${token.symbol}`,
        txHash: error.transaction?.hash || error.receipt?.hash,
        valueUsd: undefined,
        detail: `${_startOnUniswap ? 'v4->Sushi' : 'Sushi->v4'}: ${error.shortMessage || error.message}`,
      })

      return
    }
  }

  console.log(`Trade Complete:\n`)

  const contractBalanceAfter = await wethContract.balanceOf(arbitrageAddress) + await provider.getBalance(arbitrageAddress)
  const ethBalanceAfter = await provider.getBalance(account.address)

  const contractBalanceDifference = contractBalanceAfter - contractBalanceBefore
  const ethBalanceDifference = ethBalanceBefore - ethBalanceAfter

  const data = {
    'ETH Balance Before': ethers.formatUnits(ethBalanceBefore, 'ether'),
    'ETH Balance After': ethers.formatUnits(ethBalanceAfter, 'ether'),
    'ETH Spent (gas)': ethers.formatUnits(ethBalanceDifference.toString(), 'ether'),
    '-': {},
    'Contract WETH+ETH Before': ethers.formatUnits(contractBalanceBefore, 'ether'),
    'Contract WETH+ETH After': ethers.formatUnits(contractBalanceAfter, 'ether'),
    'WETH Gained/Lost': ethers.formatUnits(contractBalanceDifference.toString(), 'ether'),
    '-': {},
    'Total Gained/Lost': `${ethers.formatUnits((contractBalanceDifference - ethBalanceDifference).toString(), 'ether')} ETH`
  }

  console.table(data)
}

main()
