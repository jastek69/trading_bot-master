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

    function _flashLoanCallBack(
        address sender,
        uint256,
        uint256,
        bytes calldata data
    ) internal {
        (address flashLoanPool, address loanToken, uint256 loanAmount) = abi
            .decode(data, (address, address, uint256));

        require(
            sender == address(this) && msg.sender == flashLoanPool,
            "HANDLE_FLASH_NENIED"
        );

    flashloan(_token0, _flashAmount, data); //execution for to 'callFunction'
    // Return funds
        IERC20(loanToken).transfer(flashLoanPool, loanAmount);

    }    
    
    // Note: Realize your own logic using the token from flashLoan pool.
    // Arbitrage with DODO Flashloan
    
    function executeTrade(    //takes the data and encodes it packing it up to be sent out and be used.
        bool _startOnUniswap,
        address _token0,  // Pass in a different Token address to customize
        address _token1, // Pass in a different Token address to customize
        uint256 _flashAmount
    ) external {
        uint256 balanceBefore = IERC20(_token0).balanceOf(address(this));
    
        bytes memory data = abi.encode(
            _startOnUniswap,
            _token0,
            _token1,
            _flashAmount,
            balanceBefore
        );    
    
    address flashLoanBase = IDODO(flashLoanPool)._BASE_TOKEN_(); // DODO Flashloan code

     if (flashLoanBase == loanToken) {
            IDODO(flashLoanPool).flashLoan(loanAmount, 0, address(this), data);
        } else {
            IDODO(flashLoanPool).flashLoan(0, loanAmount, address(this), data);
        }
    }
}