// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockERC20} from "./MockERC20.sol";

contract FeeOnTransferMockERC20 is MockERC20 {
    uint256 public immutable feeBps;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 feeBps_)
        MockERC20(name_, symbol_, decimals_)
    {
        require(feeBps_ <= 10_000, "FEE");
        feeBps = feeBps_;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = amount * feeBps / 10_000;
        uint256 received = amount - fee;

        super._transfer(from, to, received);
        if (fee > 0) {
            _burn(from, fee);
        }
    }
}
