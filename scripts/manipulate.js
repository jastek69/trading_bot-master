require("dotenv").config()

const hre = require("hardhat")

// -- IMPORT HELPER FUNCTIONS & CONFIG -- //
const { getTokenAndContract, getPairContract, calculateSushiPrice } = require('../helpers/helpers')
const { provider, sFactory, sRouter } = require('../helpers/initialization.js')

/**
 * Creates an arbitrage opportunity on a local fork by dumping a large amount
 * of the quote token (USDC) into the Sushiswap pair. This pushes the WETH
 * price UP on Sushiswap relative to the Uniswap v4 pool, so the bot should
 * detect a "sell on Sushiswap, buy on Uniswap V4" opportunity.
 */

// -- CONFIGURE VALUES HERE -- //
const UNLOCKED_ACCOUNT = '0x55FE002aefF02F77364de339a1292923A15844B8' // Circle (USDC whale) to impersonate
const AMOUNT = '5000000' // 5,000,000 USDC -- converted with the token's own decimals below

async function main() {
  // Fetch contracts
  const {
    token0Contract: wethContract,
    token1Contract: tokenContract,
    token0: ARB_FOR,
    token1: ARB_AGAINST
  } = await getTokenAndContract(process.env.ARB_FOR, process.env.ARB_AGAINST, provider)

  const pair = await getPairContract(sFactory, ARB_FOR.address, ARB_AGAINST.address, provider)

  // Fetch price of USDC/WETH before we execute the swap
  const priceBefore = await calculateSushiPrice(pair, ARB_FOR, ARB_AGAINST)

  await manipulatePrice([ARB_AGAINST, ARB_FOR], tokenContract)

  // Fetch price of USDC/WETH after the swap
  const priceAfter = await calculateSushiPrice(pair, ARB_FOR, ARB_AGAINST)

  const data = {
    'Price Before': `1 WETH = ${Number(priceBefore).toFixed(2)} ${ARB_AGAINST.symbol}`,
    'Price After': `1 WETH = ${Number(priceAfter).toFixed(2)} ${ARB_AGAINST.symbol}`,
  }

  console.table(data)
}

async function manipulatePrice(_path, _tokenContract) {
  console.log(`\nBeginning Swap...\n`)

  console.log(`Input Token: ${_path[0].symbol}`)
  console.log(`Output Token: ${_path[1].symbol}\n`)

  const amount = hre.ethers.parseUnits(AMOUNT, _path[0].decimals)
  const path = [_path[0].address, _path[1].address]
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes

  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [UNLOCKED_ACCOUNT],
  })

  const signer = await hre.ethers.getSigner(UNLOCKED_ACCOUNT)

  const approval = await _tokenContract.connect(signer).approve(await sRouter.getAddress(), amount, { gasLimit: 50000 })
  await approval.wait()

  const swap = await sRouter.connect(signer).swapExactTokensForTokens(amount, 0, path, signer.address, deadline, { gasLimit: 250000 })
  await swap.wait()

  console.log(`Swap Complete!\n`)
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
