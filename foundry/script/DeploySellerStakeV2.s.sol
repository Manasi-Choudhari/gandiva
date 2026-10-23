// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IUSDC, SellerStakeV2} from "../../contracts/SellerStakeV2.sol";

/// Deploys SellerStakeV2 to Base Sepolia. The script holds no key: Foundry signs with the account given on the command line
/// (see docs/STAKE.md), and the deployer has no powers afterwards. Addresses only in VERIFIER_ADDRESSES; each key stays on
/// its own host. STAKE_COOLDOWN (seconds), STAKE_FEE and SLASH_FEE (USDC units) are optional. The fees cannot change after
/// deploy, so check them against docs/STAKE.md first.
contract DeploySellerStakeV2 is Script {
    uint256 private constant BASE_SEPOLIA = 84532;
    IUSDC private constant USDC = IUSDC(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    uint256 private constant DEFAULT_FEE = 20_000; // 0.02 USDC

    function run() external returns (SellerStakeV2 stake) {
        require(block.chainid == BASE_SEPOLIA, "testnet only: Base Sepolia");
        address[] memory v = vm.envAddress("VERIFIER_ADDRESSES", ",");
        require(v.length == 3, "VERIFIER_ADDRESSES must list 3 addresses");
        uint256 cooldown = vm.envOr("STAKE_COOLDOWN", uint256(2 hours));
        uint256 stakeFee = vm.envOr("STAKE_FEE", DEFAULT_FEE);
        uint256 slashFee = vm.envOr("SLASH_FEE", DEFAULT_FEE);

        vm.startBroadcast();
        stake = new SellerStakeV2(USDC, [v[0], v[1], v[2]], cooldown, stakeFee, slashFee);
        vm.stopBroadcast();
        console.log("SellerStakeV2 deployed at", address(stake));
    }
}
