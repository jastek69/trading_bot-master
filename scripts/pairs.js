require("dotenv").config();

const ethers = require("ethers")

const Big = require('big.js')

// const config = require('../config.json')
// const IUniswapV2Pair = require("@uniswap/v2-core/build/IUniswapV2Pair.json")
const IUniswapV2Factory = require("@uniswap/v2-core/build/IUniswapV2Factory.json")

const IERC20 = require('@openzeppelin/contracts/build/contracts/ERC20.json')
const { factory } = require("typescript")


const provider = new hre.ethers.WebSocketProvider(`wss://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`)


//Factory
const SUSHI_FACTORY = '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac'
const UNI_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
const CAKE_FACTORY = '0x1097053Fd2ea711dad45caCcc45EfF7548fCB362'

//Tokens
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const CAKE = '0x152649eA73beAb28c5b49B26eb48f7EAD6d4c898'


const SUSHI_V2_ROUTER_02_ADDRESS = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'
const UNI_V2_ROUTER_02_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const CAKE_V2_ROUTER_02_ADDRESS = '0xEfF92A263d31888d860bD50809A8D171709b7b1c'


const sushiFactory = new ethers.Contract(SUSHI_FACTORY, IUniswapV2Factory.abi, provider)
const uniFactory = new ethers.Contract(UNI_FACTORY, IUniswapV2Factory.abi, provider)
const cakeFactory = new ethers.Contract(CAKE_FACTORY, IUniswapV2Factory.abi, provider)


const main = async () => {
    // getPair on Sushiswap Factroy: function getPair(address tokenA, address tokenB) external view returns (address pair);

    const sushiPair = await sushiFactory.getPair(USDC, WETH)
    const uniPair = await uniFactory.getPair(USDC, WETH)
    const cakePair = await cakeFactory.getPair(WETH, CAKE) 
    console.log('sushiPair', sushiPair)
    console.log('uniPair', uniPair)
    console.log('cakePair', cakePair)
}

main ()
