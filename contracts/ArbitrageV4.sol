// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {IUniswapV2Router02} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

interface IWETH is IERC20Minimal {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}

/// @title ArbitrageV4
/// @notice Arbitrages a Uniswap v4 pool against a Sushiswap (V2) pair using
///         v4 flash accounting instead of an external flash loan: all swaps run
///         inside `unlockCallback` and only net balances settle at the end, so
///         no upfront capital and no flash loan fee is required.
/// @dev The v4 pool must have WETH or native ETH on one side ("base"); the
///      Sushiswap leg always trades WETH against the pool's other token
///      ("quote"). Native ETH pools are handled by wrapping/unwrapping around
///      the Sushiswap leg. Quote tokens with non-standard approve/transfer
///      (e.g. USDT) are not supported.
contract ArbitrageV4 is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    IUniswapV2Router02 public immutable sushiRouter;
    IWETH public immutable weth;
    address public owner;

    struct TradeParams {
        PoolKey key; // v4 pool to trade against Sushiswap
        bool startOnUniswap; // true: v4 -> Sushi, false: Sushi -> v4
        uint256 amountIn; // amount of base (WETH/ETH) to swap in the first leg
        uint256 minProfit; // minimum base gained or the whole trade reverts
    }

    error Unauthorized();
    error NotPoolManager();
    error NoWethSide();
    error Unprofitable(int256 delta);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _poolManager, address _sushiRouter, address _weth) {
        poolManager = IPoolManager(_poolManager);
        sushiRouter = IUniswapV2Router02(_sushiRouter);
        weth = IWETH(_weth);
        owner = msg.sender;
    }

    /// @dev Receives ETH from WETH.withdraw and PoolManager.take of native ETH.
    receive() external payable {}

    function executeTrade(TradeParams calldata params) external onlyOwner {
        uint256 balanceBefore = _baseBalance();

        poolManager.unlock(abi.encode(params));

        uint256 gained = _baseBalance() - balanceBefore;
        if (gained < params.minProfit) revert Unprofitable(int256(gained));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        TradeParams memory params = abi.decode(data, (TradeParams));
        (Currency base, Currency quote, bool baseIsZero) = _split(params.key);

        if (params.startOnUniswap) {
            // Leg 1 (v4): base -> quote. Creates a base debt with the manager,
            // paid back only after the Sushiswap leg — the "flash loan".
            uint256 quoteOut = _v4Swap(params.key, baseIsZero, params.amountIn);
            poolManager.take(quote, address(this), quoteOut);

            // Leg 2 (Sushi): quote -> WETH.
            _sushiSwap(Currency.unwrap(quote), address(weth), quoteOut);

            // Repay the base debt; leftover WETH/ETH is profit.
            _settle(base, params.amountIn);
        } else {
            // Leg 1 (Sushi): flash-take base from the manager, sell for quote.
            poolManager.take(base, address(this), params.amountIn);
            if (base.isAddressZero()) {
                weth.deposit{value: params.amountIn}();
            }
            uint256 quoteOut = _sushiSwap(address(weth), Currency.unwrap(quote), params.amountIn);

            // Leg 2 (v4): quote -> base, output stays as manager credit.
            _v4Swap(params.key, !baseIsZero, quoteOut);
            _settle(quote, quoteOut);

            // Net out the base credit against the flash-taken debt.
            int256 delta = poolManager.currencyDelta(address(this), base);
            if (delta < 0) revert Unprofitable(delta);
            if (delta > 0) {
                poolManager.take(base, address(this), uint256(delta));
            }
        }

        return "";
    }

    function withdrawToken(address token, uint256 amount) external onlyOwner {
        IERC20Minimal(token).transfer(owner, amount);
    }

    function withdrawETH(uint256 amount) external onlyOwner {
        (bool success,) = owner.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    function setOwner(address _owner) external onlyOwner {
        owner = _owner;
    }

    /// @dev Identifies which side of the pool is WETH/native ETH (base).
    function _split(PoolKey memory key) internal view returns (Currency base, Currency quote, bool baseIsZero) {
        if (key.currency0.isAddressZero() || Currency.unwrap(key.currency0) == address(weth)) {
            return (key.currency0, key.currency1, true);
        }
        if (Currency.unwrap(key.currency1) != address(weth)) revert NoWethSide();
        return (key.currency1, key.currency0, false);
    }

    function _v4Swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal returns (uint256 amountOut) {
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn), // negative = exact input
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        amountOut = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
    }

    function _sushiSwap(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 amountOut) {
        IERC20Minimal(tokenIn).approve(address(sushiRouter), amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts =
            sushiRouter.swapExactTokensForTokens(amountIn, 0, path, address(this), block.timestamp);
        amountOut = amounts[1];
    }

    /// @dev Pays `amount` of `currency` owed to the PoolManager. For native ETH
    ///      debts, unwraps WETH as needed (reverts here if the trade lost money).
    function _settle(Currency currency, uint256 amount) internal {
        if (currency.isAddressZero()) {
            uint256 ethBalance = address(this).balance;
            if (ethBalance < amount) {
                weth.withdraw(amount - ethBalance);
            }
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20Minimal(Currency.unwrap(currency)).transfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    function _baseBalance() internal view returns (uint256) {
        return address(this).balance + weth.balanceOf(address(this));
    }
}
