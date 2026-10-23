// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IUSDC, SellerStakeV2} from "../../contracts/SellerStakeV2.sol";

/// Deploys SellerStakeV2 to Base Sepolia. The script holds no key: Foundry signs with the account given on the command line
/// (see docs/STAKE.md), and the deployer has no powers afterwards. Addresses only in VERIFIER_ADDRESSES; each key stays on
/// its own host. STAKE_COOLDOWN (seconds) is optional.
contract DeploySellerStakeV2 is Script {
    uint256 private constant BASE_SEPOLIA = 84532;
    IUSDC private constant USDC = IUSDC(0x036CbD53842c5426634e7929541eC2318f3dCF7e);

    function run() external returns (SellerStakeV2 stake) {
        require(block.chainid == BASE_SEPOLIA, "testnet only: Base Sepolia");
        address[] memory v = vm.envAddress("VERIFIER_ADDRESSES", ",");
        require(v.length == 3, "VERIFIER_ADDRESSES must list 3 addresses");
        uint256 cooldown = vm.envOr("STAKE_COOLDOWN", uint256(2 hours));

        vm.startBroadcast();
        stake = new SellerStakeV2(USDC, [v[0], v[1], v[2]], cooldown);
        vm.stopBroadcast();
        console.log("SellerStakeV2 deployed at", address(stake));
    }
}
