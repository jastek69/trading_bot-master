const hre = require("hardhat")
require("dotenv").config()

/**
 * Initializes the main contracts the bot interacts with:
 * the Uniswap v4 PoolManager (events) + StateView/Quoter lenses,
 * the Sushiswap V2 factory & router, and the ArbitrageV4 contract.
 */

const config = require('../config.json')
const IUniswapV2Router02 = require('@uniswap/v2-periphery/build/IUniswapV2Router02.json')
const IUniswapV2Factory = require("@uniswap/v2-core/build/IUniswapV2Factory.json")
const IPoolManager = require('../artifacts/@uniswap/v4-core/src/interfaces/IPoolManager.sol/IPoolManager.json')
const IArbitrage = require('../artifacts/contracts/ArbitrageV4.sol/ArbitrageV4.json')

// Minimal ABIs for the v4 periphery lens contracts
const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity)"
]

const QUOTER_ABI = [
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) external returns (uint256 amountOut, uint256 gasEstimate)"
]

let provider

if (config.PROJECT_SETTINGS.isLocal) {
  provider = new hre.ethers.WebSocketProvider(`ws://127.0.0.1:8545/`)
} else {
  provider = new hre.ethers.WebSocketProvider(`wss://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`)
}

// -- SETUP UNISWAP V4 CONTRACTS -- //
const poolManager = new hre.ethers.Contract(config.UNISWAP_V4.POOL_MANAGER_ADDRESS, IPoolManager.abi, provider)
const stateView = new hre.ethers.Contract(config.UNISWAP_V4.STATE_VIEW_ADDRESS, STATE_VIEW_ABI, provider)
const quoter = new hre.ethers.Contract(config.UNISWAP_V4.QUOTER_ADDRESS, QUOTER_ABI, provider)

// -- SETUP SUSHISWAP (V2) CONTRACTS -- //
const sFactory = new hre.ethers.Contract(config.SUSHISWAP.FACTORY_ADDRESS, IUniswapV2Factory.abi, provider)
const sRouter = new hre.ethers.Contract(config.SUSHISWAP.V2_ROUTER_02_ADDRESS, IUniswapV2Router02.abi, provider)

// -- SETUP ARBITRAGE CONTRACT -- //
const arbitrage = new hre.ethers.Contract(config.PROJECT_SETTINGS.ARBITRAGE_ADDRESS, IArbitrage.abi, provider)

module.exports = {
  provider,
  poolManager,
  stateView,
  quoter,
  sFactory,
  sRouter,
  arbitrage
}
