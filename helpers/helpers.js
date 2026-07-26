const ethers = require("ethers")
const Big = require('big.js')

Big.DP = 40

/**
 * Helper functions shared by the bot, scripts and tests.
 * The Uniswap side of the bot speaks v4 (PoolManager/StateView/Quoter),
 * the Sushiswap side still speaks V2 (pairs & reserves).
 */

const IUniswapV2Pair = require("@uniswap/v2-core/build/IUniswapV2Pair.json")
const IERC20 = require('@openzeppelin/contracts/build/contracts/ERC20.json')

const NATIVE_ETH = "0x0000000000000000000000000000000000000000"
const Q96 = Big(2).pow(96)

async function getTokenAndContract(_token0Address, _token1Address, _provider) {
    const token0Contract = new ethers.Contract(_token0Address, IERC20.abi, _provider)
    const token1Contract = new ethers.Contract(_token1Address, IERC20.abi, _provider)

    const token0 = {
        address: _token0Address,
        decimals: Number(await token0Contract.decimals()),
        symbol: await token0Contract.symbol(),
        name: await token0Contract.name()
    }

    const token1 = {
        address: _token1Address,
        decimals: Number(await token1Contract.decimals()),
        symbol: await token1Contract.symbol(),
        name: await token1Contract.name()
    }

    return { token0Contract, token1Contract, token0, token1 }
}

/**
 * Builds the Uniswap v4 PoolKey for the WETH ("base") / token ("quote") pool.
 * When USE_NATIVE_ETH is set the pool trades native ETH (currency 0x0) and the
 * arbitrage contract wraps/unwraps around the Sushiswap leg.
 * Returns { key, baseIsZero } where baseIsZero says which side WETH/ETH is on.
 */
function buildPoolKey(_wethAddress, _tokenAddress, _poolConfig) {
    const base = _poolConfig.USE_NATIVE_ETH ? NATIVE_ETH : _wethAddress

    let currency0, currency1, baseIsZero
    if (BigInt(base) < BigInt(_tokenAddress)) {
        [currency0, currency1, baseIsZero] = [base, _tokenAddress, true]
    } else {
        [currency0, currency1, baseIsZero] = [_tokenAddress, base, false]
    }

    const key = {
        currency0,
        currency1,
        fee: _poolConfig.FEE,
        tickSpacing: _poolConfig.TICK_SPACING,
        hooks: _poolConfig.HOOKS_ADDRESS
    }

    return { key, baseIsZero }
}

/**
 * PoolId = keccak256(abi.encode(PoolKey))
 */
function getPoolId(_key) {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,uint24,int24,address)"],
        [[_key.currency0, _key.currency1, _key.fee, _key.tickSpacing, _key.hooks]]
    )
    return ethers.keccak256(encoded)
}

/**
 * Price on the v4 pool expressed as quote tokens per 1 WETH/ETH,
 * derived from slot0's sqrtPriceX96.
 */
async function calculateV4Price(_stateView, _poolId, _baseIsZero, _baseDecimals, _quoteDecimals) {
    const slot0 = await _stateView.getSlot0(_poolId)
    const sqrtPriceX96 = slot0[0]

    // (sqrtPriceX96 / 2^96)^2 = currency1 per currency0, in raw token units
    const rawPrice = Big(sqrtPriceX96.toString()).div(Q96).pow(2)

    if (_baseIsZero) {
        return rawPrice.times(Big(10).pow(_baseDecimals - _quoteDecimals))
    } else {
        return Big(1).div(rawPrice).times(Big(10).pow(_baseDecimals - _quoteDecimals))
    }
}

async function getPairAddress(_V2Factory, _token0, _token1) {
    const pairAddress = await _V2Factory.getPair(_token0, _token1)
    return pairAddress
}

async function getPairContract(_V2Factory, _token0, _token1, _provider) {
    const pairAddress = await getPairAddress(_V2Factory, _token0, _token1)
    const pairContract = new ethers.Contract(pairAddress, IUniswapV2Pair.abi, _provider)
    return pairContract
}

async function getReserves(_pairContract) {
    const reserves = await _pairContract.getReserves()
    return [reserves.reserve0, reserves.reserve1]
}

/**
 * Price on the Sushiswap pair expressed as quote tokens per 1 WETH,
 * decimal-adjusted from the pair reserves.
 */
async function calculateSushiPrice(_pairContract, _base, _quote) {
    const [reserve0, reserve1] = await getReserves(_pairContract)
    const pairToken0 = await _pairContract.token0()

    const baseFirst = pairToken0.toLowerCase() === _base.address.toLowerCase()
    const baseReserve = Big((baseFirst ? reserve0 : reserve1).toString()).div(Big(10).pow(_base.decimals))
    const quoteReserve = Big((baseFirst ? reserve1 : reserve0).toString()).div(Big(10).pow(_quote.decimals))

    return quoteReserve.div(baseReserve)
}

/**
 * Simulates both legs of the arbitrage for `_amountIn` WETH/ETH and returns
 * the WETH/ETH received back, using the v4 Quoter and Sushi's getAmountsOut.
 */
async function simulate(_amountIn, _startOnUniswap, { quoter, key, baseIsZero, sRouter, wethAddress, tokenAddress }) {
    let amountOut

    if (_startOnUniswap) {
        // Leg 1: sell WETH/ETH on v4, Leg 2: sell quote token on Sushi
        const [quoteOut] = await quoter.quoteExactInputSingle.staticCall({
            poolKey: key,
            zeroForOne: baseIsZero,
            exactAmount: _amountIn,
            hookData: '0x'
        })
        const amounts = await sRouter.getAmountsOut(quoteOut, [tokenAddress, wethAddress])
        amountOut = amounts[1]
    } else {
        // Leg 1: sell WETH on Sushi, Leg 2: sell quote token on v4
        const amounts = await sRouter.getAmountsOut(_amountIn, [wethAddress, tokenAddress])
        const [baseOut] = await quoter.quoteExactInputSingle.staticCall({
            poolKey: key,
            zeroForOne: !baseIsZero,
            exactAmount: amounts[1],
            hookData: '0x'
        })
        amountOut = baseOut
    }

    return {
        amountIn: ethers.formatUnits(_amountIn, 'ether'),
        amountOut: ethers.formatUnits(amountOut, 'ether')
    }
}

module.exports = {
    NATIVE_ETH,
    getTokenAndContract,
    buildPoolKey,
    getPoolId,
    calculateV4Price,
    getPairAddress,
    getPairContract,
    getReserves,
    calculateSushiPrice,
    simulate
}
