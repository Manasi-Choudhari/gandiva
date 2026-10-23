// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IUSDC, SellerStakeV2} from "../../contracts/SellerStakeV2.sol";
import {DeploySellerStakeV2} from "../script/DeploySellerStakeV2.s.sol";
import {StakeSigning} from "./StakeBase.sol";

interface IUSDCDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// The whole life of a bond against the real USDC contract on a local copy of Base Sepolia. Spends nothing: changes stay in
/// the fork. Skipped unless FORK_RPC is set, e.g. FORK_RPC=https://sepolia.base.org forge test --match-path "*fork*"
contract SellerStakeV2ForkTest is StakeSigning {
    IUSDC internal constant USDC = IUSDC(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    bytes32 internal constant RECEIVE_TYPEHASH =
        keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    uint256 internal constant COOLDOWN = 2 hours;

    SellerStakeV2 internal stake;
    uint256[3] internal keys;
    address internal seller;
    uint256 internal sellerKey;
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);
        (seller, sellerKey) = makeAddrAndKey("seller");
        address[3] memory vs;
        for (uint256 i; i < 3; ++i) {
            (vs[i], keys[i]) = makeAddrAndKey(string.concat("verifier-", vm.toString(i)));
        }
        vm.setEnv("VERIFIER_ADDRESSES", string.concat(vm.toString(vs[0]), ",", vm.toString(vs[1]), ",", vm.toString(vs[2])));
        stake = new DeploySellerStakeV2().run();
        deal(address(USDC), seller, 1_000_000);
    }

    function _authorize(address from, uint256 key, uint256 value, bytes32 nonce) private view returns (uint8, bytes32, bytes32) {
        bytes32 structHash = keccak256(abi.encode(RECEIVE_TYPEHASH, from, address(stake), value, 0, block.timestamp + 1 hours, nonce));
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", IUSDCDomain(address(USDC)).DOMAIN_SEPARATOR(), structHash)));
    }

    function _stake(uint256 value, bytes32 nonce) private {
        (uint8 v, bytes32 r, bytes32 s) = _authorize(seller, sellerKey, value, nonce);
        stake.stakeWithAuthorization(seller, value, 0, block.timestamp + 1 hours, nonce, v, r, s);
    }

    function test_Fork_DeployScriptPointsAtRealUSDC() public view {
        assertEq(address(stake.usdc()), address(USDC));
        assertEq(stake.cooldown(), COOLDOWN);
    }

    function test_Fork_StakeSlashAndWithdrawMoveRealUSDC() public {
        _stake(50_000, keccak256("stake"));
        assertEq(USDC.balanceOf(address(stake)), 50_000);
        assertEq(USDC.balanceOf(seller), 950_000);

        _register(stake, seller, sellerKey, makeAddr("receipt-signer"));
        SellerStakeV2.Claim memory c = SellerStakeV2.Claim({
            seller: seller,
            buyer: buyer,
            amount: 40_000,
            paymentNonce: keccak256("payment"),
            evidence: keccak256("evidence"),
            kind: 1,
            deadline: block.timestamp + 10 minutes
        });
        bytes32 id = stake.proposeSlash(c, _sigs(stake, _pair(keys[0], keys[1]), _claimHash(c)));
        vm.warp(block.timestamp + 30 minutes);
        assertEq(stake.executeSlash(id), 40_000);
        assertEq(USDC.balanceOf(buyer), 40_000);

        vm.prank(seller);
        stake.requestUnstake();
        vm.warp(block.timestamp + COOLDOWN);
        stake.withdraw(seller);
        assertEq(USDC.balanceOf(seller), 960_000);
        assertEq(USDC.balanceOf(address(stake)), 0);
        assertEq(stake.totalStaked(), 0);
    }

    function test_Fork_RealUSDCRefusesAForgedOrReplayedAuthorization() public {
        bytes32 nonce = keccak256("stake");
        (uint8 v, bytes32 r, bytes32 s) = _authorize(seller, keys[0], 50_000, nonce); // signed by someone else
        vm.expectRevert();
        stake.stakeWithAuthorization(seller, 50_000, 0, block.timestamp + 1 hours, nonce, v, r, s);
        assertEq(stake.totalStaked(), 0);

        _stake(50_000, nonce);
        (v, r, s) = _authorize(seller, sellerKey, 50_000, nonce);
        vm.expectRevert();
        stake.stakeWithAuthorization(seller, 50_000, 0, block.timestamp + 1 hours, nonce, v, r, s);
        assertEq(stake.totalStaked(), 50_000);
    }
}
