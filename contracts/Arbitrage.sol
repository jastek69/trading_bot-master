//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "hardhat/console.sol";

interface IDODO {
    function flashLoan(
        uint256 baseAmount,
        uint256 quoteAmount,
        address assetTo,
        bytes calldata data
    ) external;

    function _BASE_TOKEN_() external view returns (address);
}

contract Flashloan {    
    address constant flashLoanPool = 0x5333Eb1E32522F1893B7C9feA3c263807A02d561;
    IUniswapV2Router02 public immutable sRouter;
    IUniswapV2Router02 public immutable uRouter;

    address public owner;

    
    constructor(address _sRouter, address _uRouter) {
        sRouter = IUniswapV2Router02(_sRouter); // Sushiswap
        uRouter = IUniswapV2Router02(_uRouter); // Uniswap
        owner = msg.sender; // NOTE: Can place in Ethereum address of Eth wallet
    }

    // Note: CallBack function executed by DODOV2(DVM) flashLoan pool
    // Dodo Vending Machine Factory --> 0x79887f65f83bdf15Bcc8736b5e5BcDB48fb8fE13
    function DVMFlashLoanCall(
        address sender,
        uint256 baseAmount,
        uint256 quoteAmount,
        bytes calldata data
    ) external {
        console.log("Vending Machine Pool Called...");
        _flashLoanCallBack(sender, baseAmount, quoteAmount, data);
    }

    // Note: CallBack function executed by DODOV2(DPP) flashLoan pool
    // Dodo Private Pool Factory --> 0xd24153244066F0afA9415563bFC7Ba248bfB7a51
    function DPPFlashLoanCall(
        address sender,
        uint256 baseAmount,
        uint256 quoteAmount,
        bytes calldata data
    ) external {
        console.log("Private Pool Called...");
        _flashLoanCallBack(sender, baseAmount, quoteAmount, data);
    }

    // Note: Realize your own logic using the token from flashLoan pool.
    // Arbitrage with DODO Flashloan
    
    function executeTrade(    //takes the data and encodes it packing it up to be sent out and be used.
        bool _startOnUniswap,
        address _token0,  // Pass in a different Token address to customize
        address _token1, // Pass in a different Token address to customize
        uint256 flashAmount
    ) external {
        uint256 balanceBefore = IERC20(_token0).balanceOf(address(this));
    
        bytes memory data = abi.encode(
            _startOnUniswap,
            _token0,
            _token1,
            flashAmount,
            balanceBefore
        );    
    
    address flashLoanBase = IDODO(flashLoanPool)._BASE_TOKEN_(); // DODO Flashloan code

     if (flashLoanBase == _token0) {
            IDODO(flashLoanPool).flashLoan(flashAmount, 0, address(this), data);
        } else {
            IDODO(flashLoanPool).flashLoan(0, flashAmount, address(this), data);
        }
    }
    

     function _swapOnUniswap(
        address[] memory _path,
        uint256 _amountIn,
        uint256 _amountOut
    ) internal {
        require(
            IERC20(_path[0]).approve(address(uRouter), _amountIn),
            "Uniswap approval failed."
        );

        uRouter.swapExactTokensForTokens(
            _amountIn,
            _amountOut,
            _path,
            address(this),
            (block.timestamp + 1200)
        );
    }

    function _swapOnSushiswap(
        address[] memory _path,
        uint256 _amountIn,
        uint256 _amountOut
    ) internal {
        require(
            IERC20(_path[0]).approve(address(sRouter), _amountIn),
            "Sushiswap approval failed."
        );

        sRouter.swapExactTokensForTokens(
            _amountIn,
            _amountOut,
            _path,
            address(this),
            (block.timestamp + 1200)
        );
    }


function _flashLoanCallBack(
        address sender, // address of sender
        uint256,        // base amount
        uint256,        // quote amount
        bytes calldata data
    ) internal {
        (bool startOnUniSwap, address token0, address token1 , uint256 flashAmount, uint256 _balanceBefore) = abi.decode(data, (bool, address, address, uint256, uint256));

        require(
            sender == address(this) && msg.sender == flashLoanPool,
            "HANDLE_FLASH_NENIED"
        );

    address[] memory path = new address[](2);
    
        path[0] = token0;
        path[1] = token1;

        if (startOnUniswap) { //Buy on UniSwap
            _swapOnUniswap(path, flashAmount, 0);

            path[0] = token1;
            path[1] = token0;

            _swapOnSushiswap(  //Sell on Sushiswap
                path,
                IERC20(token1).balanceOf(address(this)),
                (flashAmount + 1)
            );
        } else {
            _swapOnSushiswap(path, flashAmount, 0);  //Buy on SushiSwap

            path[0] = token1;
            path[1] = token0;

            _swapOnUniswap(     // Sell on Uniswap
                path,
                IERC20(token1).balanceOf(address(this)),
                (flashAmount + 1)
            );
        }
  
        IERC20(token0).transfer(
            owner,
            IERC20(token0).balanceOf(address(this)) - (flashAmount + 1)
        );

        // Return funds
        IERC20(token0).transfer(flashLoanPool, flashAmount);
    }

}