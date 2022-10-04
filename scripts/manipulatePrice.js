// -- IMPORT PACKAGES -- //
require("dotenv").config();

const Web3 = require('web3')
const {
    ChainId,
    Token,
    WETH
} = require("@uniswap/sdk")

const IUniswapV2Router02 = require('@uniswap/v2-periphery/build/IUniswapV2Router02.json')
const IUniswapV2Factory = require("@uniswap/v2-core/build/IUniswapV2Factory.json")
const IERC20 = require('@openzeppelin/contracts/build/contracts/ERC20.json')

// -- SETUP NETWORK & WEB3 -- //

const chainId = ChainId.MAINNET
const web3 = new Web3('http://127.0.0.1:7545')




// -- IMPORT HELPER FUNCTIONS -- //

const { getPairContract, calculatePrice } = require('../helpers/helpers')

// -- IMPORT & SETUP UNISWAP/SUSHISWAP CONTRACTS -- //

const config = require('../config.json')
const uFactory = new web3.eth.Contract(IUniswapV2Factory.abi, config.UNISWAP.FACTORY_ADDRESS) // UNISWAP FACTORY CONTRACT
const sFactory = new web3.eth.Contract(IUniswapV2Factory.abi, config.SUSHISWAP.FACTORY_ADDRESS) // SUSHISWAP FACTORY CONTRACT
const uRouter = new web3.eth.Contract(IUniswapV2Router02.abi, config.UNISWAP.V2_ROUTER_02_ADDRESS) // UNISWAP ROUTER CONTRACT
const sRouter = new web3.eth.Contract(IUniswapV2Router02.abi, config.SUSHISWAP.V2_ROUTER_02_ADDRESS) // UNISWAP ROUTER CONTRACT

// -- CONFIGURE VALUES HERE -- //

const V2_FACTORY_TO_USE = uFactory
const V2_ROUTER_TO_USE = uRouter

const UNLOCKED_ACCOUNT = '0xf977814e90da44bfa03b6295a0616a897441acec' // USDC Unlocked Account
const ERC20_ADDRESS = process.env.ARB_AGAINST
const AMOUNT = '15000000' // 15,000,000 USDC -- Tokens will automatically be converted to wei
const GAS = 450000

// -- SETUP ERC20 CONTRACT & TOKEN -- //

const ERC20_CONTRACT = new web3.eth.Contract(IERC20.abi, ERC20_ADDRESS)
const WETH_CONTRACT = new web3.eth.Contract(IERC20.abi, process.env.ARB_FOR)

// -- MAIN SCRIPT -- //

const main = async () => {
    const accounts = await web3.eth.getAccounts()
    const account = accounts[1] // This will be the account to receive WETH after we perform the swap to manipulate price

    const pairContract = await getPairContract(V2_FACTORY_TO_USE, ERC20_ADDRESS, process.env.ARB_FOR)
    const token = new Token(
        ChainId.MAINNET,
        ERC20_ADDRESS,
        6, // USDC so 6 instead of 18 decimals
        await ERC20_CONTRACT.methods.symbol().call(),
        await ERC20_CONTRACT.methods.name().call()
    )

    // Fetch price of USDC/WETH before we execute the swap
    const priceBefore = await calculatePrice(pairContract)

    await manipulatePrice(token, account)

    // Fetch price of USDC/WETH after the swap
    const priceAfter = await calculatePrice(pairContract)

    const data = {
        'Price Before': `1 ${WETH[chainId].symbol} = ${Number(priceBefore).toFixed(0)} ${token.symbol}`,
        'Price After': `1 ${WETH[chainId].symbol} = ${Number(priceAfter).toFixed(0)} ${token.symbol}`,
    }

    console.table(data)

    let balance = await WETH_CONTRACT.methods.balanceOf(account).call()
    balance = web3.utils.fromWei(balance.toString(), 'mwei')    //Note: Using USDC so switch to mwei instead of ether

    console.log(`\nBalance in receiver account: ${balance} WETH\n`)
}

main()

// 

async function manipulatePrice(token, account) {
    console.log(`\nBeginning Swap...\n`)

    console.log(`Input Token: ${token.symbol}`)
    console.log(`Output Token: ${WETH[chainId].symbol}\n`)

    const amountIn = new web3.utils.BN(
        web3.utils.toWei(AMOUNT, 'mwei')   // Note: Using USDC so switch to mwei instead of ether
    )

    const path = [token.address, process.env.ARB_FOR]
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes

    await ERC20_CONTRACT.methods.approve(V2_ROUTER_TO_USE._address, amountIn).send({ from: UNLOCKED_ACCOUNT })
    const receipt = await V2_ROUTER_TO_USE.methods.swapExactTokensForTokens(amountIn, 0, path, account, deadline).send({ from: UNLOCKED_ACCOUNT, gas: GAS });

    console.log(`Swap Complete!\n`)

    return receipt
}

