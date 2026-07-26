const { expect } = require("chai")
const { impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers")

const config = require("../config.json")
const { buildPoolKey, getPoolId } = require("../helpers/helpers")

// Mainnet addresses (tests run against a mainnet fork)
const WETH = config.TOKENS.WETH
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
const USDC_WHALE = "0x55FE002aefF02F77364de339a1292923A15844B8" // Circle

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)"
]

describe("ArbitrageV4", () => {
  let owner
  let arbitrage

  beforeEach(async () => {
    [owner] = await ethers.getSigners()

    arbitrage = await hre.ethers.deployContract(
      "ArbitrageV4",
      [
        config.UNISWAP_V4.POOL_MANAGER_ADDRESS,
        config.SUSHISWAP.V2_ROUTER_02_ADDRESS,
        WETH
      ]
    )

    await arbitrage.waitForDeployment()
  })

  describe("Deployment", () => {
    it("Sets the poolManager", async () => {
      expect(await arbitrage.poolManager()).to.equal(config.UNISWAP_V4.POOL_MANAGER_ADDRESS)
    })

    it("Sets the sushiRouter", async () => {
      expect(await arbitrage.sushiRouter()).to.equal(config.SUSHISWAP.V2_ROUTER_02_ADDRESS)
    })

    it("Sets the owner", async () => {
      expect(await arbitrage.owner()).to.equal(await owner.getAddress())
    })
  })

  describe("Trading", () => {
    it("Profits from a Sushiswap -> Uniswap v4 arbitrage", async () => {
      const { key } = buildPoolKey(WETH, USDC, config.UNISWAP_V4.POOL)

      // Create the price discrepancy: dump USDC into the Sushiswap pair so
      // WETH becomes more expensive on Sushiswap than on the v4 pool.
      const usdc = new ethers.Contract(USDC, ERC20_ABI, ethers.provider)
      const router = new ethers.Contract(
        config.SUSHISWAP.V2_ROUTER_02_ADDRESS,
        ["function swapExactTokensForTokens(uint256, uint256, address[], address, uint256) returns (uint256[])"],
        ethers.provider
      )

      await impersonateAccount(USDC_WHALE)
      await setBalance(USDC_WHALE, ethers.parseEther("10"))
      const whale = await ethers.getSigner(USDC_WHALE)

      const dumpAmount = ethers.parseUnits("500000", 6) // 500k USDC
      await usdc.connect(whale).approve(await router.getAddress(), dumpAmount)
      await router.connect(whale).swapExactTokensForTokens(
        dumpAmount,
        0,
        [USDC, WETH],
        USDC_WHALE,
        Math.floor(Date.now() / 1000) + 1200
      )

      // Execute: sell WETH high on Sushiswap, buy it back cheap on v4.
      // The WETH is flash-taken from the PoolManager, no upfront capital.
      await arbitrage.connect(owner).executeTrade({
        key,
        startOnUniswap: false,
        amountIn: ethers.parseEther("5"),
        minProfit: 0
      })

      const weth = new ethers.Contract(WETH, ERC20_ABI, ethers.provider)
      const arbitrageAddress = await arbitrage.getAddress()
      const profit =
        await weth.balanceOf(arbitrageAddress) +
        await ethers.provider.getBalance(arbitrageAddress)

      expect(profit).to.be.greaterThan(0)
    })

    it("Reverts when minProfit is not met", async () => {
      const { key } = buildPoolKey(WETH, USDC, config.UNISWAP_V4.POOL)

      // Whatever the live spread is, a million ETH of profit is impossible,
      // so the trade must revert instead of settling at a worse outcome.
      await expect(
        arbitrage.connect(owner).executeTrade({
          key,
          startOnUniswap: false,
          amountIn: ethers.parseEther("5"),
          minProfit: ethers.parseEther("1000000")
        })
      ).to.be.reverted
    })

    it("Blocks non-owners from trading", async () => {
      const [, attacker] = await ethers.getSigners()
      const { key } = buildPoolKey(WETH, USDC, config.UNISWAP_V4.POOL)

      await expect(
        arbitrage.connect(attacker).executeTrade({
          key,
          startOnUniswap: false,
          amountIn: ethers.parseEther("1"),
          minProfit: 0
        })
      ).to.be.revertedWithCustomError(arbitrage, "Unauthorized")
    })
  })
})
