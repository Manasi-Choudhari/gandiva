// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IUSDC, SellerStakeV2} from "../../contracts/SellerStakeV2.sol";
import {DeploySellerStakeV2} from "../script/DeploySellerStakeV2.s.sol";
import {MockUSDC, ReentrantUSDC} from "./MockUSDC.sol";
import {StakeSigning} from "./StakeBase.sol";

/// Every rule of SellerStakeV2 against a mock USDC. tests/sellerStakeV2.test.ts covers the same contract through the
/// server's own TypeScript signers; this file adds fuzzing and the attacks that need a hostile token.
contract SellerStakeV2Test is StakeSigning {
    uint256 internal constant COOLDOWN = 2 hours;
    uint256 internal constant WINDOW = 30 minutes;
    uint256 internal constant MAX = 100_000;
    uint256 internal constant FEE = 20_000;

    MockUSDC internal usdc;
    SellerStakeV2 internal stake; // no fees: the rules below are about the bond, and the fee tests deploy their own
    uint256[3] internal keys;
    address[3] internal vs;
    address internal seller;
    uint256 internal sellerKey;
    address internal buyer = makeAddr("buyer");
    address internal receiptKey = makeAddr("receipt-signer");
    uint256 internal authNonce;

    function setUp() public {
        vm.warp(1_800_000_000);
        (seller, sellerKey) = makeAddrAndKey("seller");
        for (uint256 i; i < 3; ++i) {
            (vs[i], keys[i]) = makeAddrAndKey(string.concat("verifier-", vm.toString(i)));
        }
        usdc = new MockUSDC();
        stake = _deploy(usdc);
        usdc.mint(seller, 1_000_000);
    }

    function _deploy(MockUSDC token) private returns (SellerStakeV2) {
        return new SellerStakeV2(IUSDC(address(token)), vs, COOLDOWN, 0, 0);
    }

    /// A contract with fees, bonded `value` by the seller through `relayer`, ready to be slashed.
    function _withFees(address relayer, uint256 value) private returns (SellerStakeV2 target) {
        target = new SellerStakeV2(IUSDC(address(usdc)), vs, COOLDOWN, FEE, FEE);
        stake = target;
        _register(target, seller, sellerKey, receiptKey);
        vm.prank(relayer);
        target.stakeWithAuthorization(seller, value, 0, block.timestamp + 1 hours, bytes32(++authNonce), 27, 0, 0);
    }

    function _stake(uint256 value) private {
        stake.stakeWithAuthorization(seller, value, 0, block.timestamp + 1 hours, bytes32(++authNonce), 27, 0, 0);
    }

    function _claim(bytes32 paymentNonce, uint256 amount) private view returns (SellerStakeV2.Claim memory) {
        return SellerStakeV2.Claim({
            seller: seller,
            buyer: buyer,
            amount: amount,
            paymentNonce: paymentNonce,
            evidence: keccak256("evidence"),
            kind: 1,
            deadline: block.timestamp + 10 minutes
        });
    }

    function _propose(SellerStakeV2.Claim memory c) private returns (bytes32) {
        return stake.proposeSlash(c, _sigs(stake, _pair(keys[0], keys[1]), _claimHash(c)));
    }

    function _veto(bytes32 id) private {
        uint256 deadline = block.timestamp + 10 minutes;
        stake.vetoSlash(id, deadline, _sigs(stake, _pair(keys[0], keys[2]), _vetoHash(id, deadline)));
    }

    function _status(bytes32 id) private view returns (SellerStakeV2.Status status) {
        (,,,, status) = stake.claims(id);
    }

    function _bonded(uint256 value) private {
        _register(stake, seller, sellerKey, receiptKey);
        _stake(value);
    }

    // ---- deployment ----

    function test_Domain_IsWhatTheServerSigns() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Gandiva SellerStake"),
                keccak256("2"),
                block.chainid,
                address(stake)
            )
        );
        assertEq(stake.DOMAIN_SEPARATOR(), expected);
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = stake.eip712Domain();
        assertEq(name, "Gandiva SellerStake");
        assertEq(version, "2");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(stake));
    }

    function test_RefusesShortCooldownAndBadVerifierSet() public {
        IUSDC token = IUSDC(address(usdc));
        vm.expectRevert("cooldown too short");
        new SellerStakeV2(token, vs, 90 minutes, 0, 0);
        vm.expectRevert("duplicate verifier");
        new SellerStakeV2(token, [vs[0], vs[0], vs[2]], COOLDOWN, 0, 0);
        vm.expectRevert("zero verifier");
        new SellerStakeV2(token, [vs[0], vs[1], address(0)], COOLDOWN, 0, 0);
    }

    function test_RefusesAFeeAboveTheCap() public {
        IUSDC token = IUSDC(address(usdc));
        vm.expectRevert("fee too high");
        new SellerStakeV2(token, vs, COOLDOWN, MAX + 1, 0);
        vm.expectRevert("fee too high");
        new SellerStakeV2(token, vs, COOLDOWN, 0, MAX + 1);
        SellerStakeV2 atCap = new SellerStakeV2(token, vs, COOLDOWN, MAX, MAX);
        assertEq(atCap.stakeFee(), MAX);
        assertEq(atCap.slashFee(), MAX);
    }

    function test_DeployScript_RefusesAnyChainButBaseSepolia() public {
        DeploySellerStakeV2 script = new DeploySellerStakeV2();
        vm.chainId(8453); // Base mainnet
        vm.expectRevert("testnet only: Base Sepolia");
        script.run();
    }

    // ---- receipt signer ----

    function test_ReceiptSigner_OnceAndOnlyBySeller() public {
        uint256 deadline = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = _signVrs(stake, sellerKey, _receiptSignerHash(seller, receiptKey, 0, deadline));
        stake.setReceiptSignerWithSig(seller, receiptKey, deadline, v, r, s);
        assertEq(stake.receiptSigner(seller), receiptKey);

        vm.expectRevert("bad signature");
        stake.setReceiptSignerWithSig(seller, receiptKey, deadline, v, r, s); // replay

        (v, r, s) = _signVrs(stake, keys[0], _receiptSignerHash(seller, makeAddr("evil"), 1, deadline));
        vm.expectRevert("bad signature");
        stake.setReceiptSignerWithSig(seller, makeAddr("evil"), deadline, v, r, s); // not the seller

        (v, r, s) = _signVrs(stake, sellerKey, _receiptSignerHash(seller, receiptKey, 1, deadline - 120));
        vm.expectRevert("signature expired");
        stake.setReceiptSignerWithSig(seller, receiptKey, deadline - 120, v, r, s);

        (v, r, s) = _signVrs(stake, sellerKey, _receiptSignerHash(seller, address(0), 1, deadline));
        vm.expectRevert("zero signer");
        stake.setReceiptSignerWithSig(seller, address(0), deadline, v, r, s);
    }

    function test_CannotSlashASellerWithNoReceiptSigner() public {
        _stake(50_000);
        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(1)), 40_000);
        bytes[] memory sigs = _sigs(stake, _pair(keys[0], keys[1]), _claimHash(c));
        vm.expectRevert("not slashable");
        stake.proposeSlash(c, sigs);
    }

    // ---- slashing ----

    function test_Slash_OnlyAfterWindow_RefundsBuyerOnce() public {
        _bonded(50_000);
        bytes32 id = _propose(_claim(bytes32(uint256(1)), 40_000));
        assertEq(stake.pendingCount(seller), 1);

        vm.expectRevert("window open");
        stake.executeSlash(id);

        vm.warp(block.timestamp + WINDOW);
        vm.prank(makeAddr("anyone"));
        assertEq(stake.executeSlash(id), 40_000);

        assertEq(usdc.balanceOf(buyer), 40_000);
        assertEq(stake.stakeOf(seller), 10_000);
        assertEq(stake.totalStaked(), 10_000);
        assertEq(stake.pendingCount(seller), 0);
        assertEq(uint8(_status(id)), uint8(SellerStakeV2.Status.Executed));

        vm.expectRevert("not pending");
        stake.executeSlash(id);
    }

    function test_RejectsOneDuplicateUnsortedOutsiderAndTampered() public {
        _bonded(50_000);
        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(1)), 40_000);
        bytes[] memory good = _sigs(stake, _pair(keys[0], keys[1]), _claimHash(c));

        bytes[] memory one = new bytes[](1);
        one[0] = good[0];
        vm.expectRevert("not enough signatures");
        stake.proposeSlash(c, one);

        bytes[] memory same = new bytes[](2);
        same[0] = good[0];
        same[1] = good[0];
        vm.expectRevert("signers not sorted");
        stake.proposeSlash(c, same);

        bytes[] memory swapped = new bytes[](2);
        swapped[0] = good[1];
        swapped[1] = good[0];
        vm.expectRevert("signers not sorted");
        stake.proposeSlash(c, swapped);

        (, uint256 outsider) = makeAddrAndKey("outsider");
        bytes[] memory foreign = _sigs(stake, _pair(keys[0], outsider), _claimHash(c));
        vm.expectRevert();
        stake.proposeSlash(c, foreign);

        c.amount = 99_999; // signed for 40 000
        vm.expectRevert();
        stake.proposeSlash(c, good);

        c.amount = 40_000;
        assertEq(stake.proposeSlash(c, good), stake.claimId(c.seller, c.buyer, c.paymentNonce));
    }

    function test_RejectsMalleableShortAndBadVSignatures() public {
        _bonded(50_000);
        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(1)), 40_000);
        bytes[] memory sigs = _sigs(stake, _pair(keys[0], keys[1]), _claimHash(c));
        (bytes32 r, bytes32 s, uint8 v) = _split(sigs[1]);

        sigs[1] = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert("bad signature");
        stake.proposeSlash(c, sigs); // the same signature, flipped to its high-s twin

        sigs[1] = abi.encodePacked(r, s);
        vm.expectRevert("bad signature");
        stake.proposeSlash(c, sigs);

        sigs[1] = abi.encodePacked(r, s, uint8(v - 27));
        vm.expectRevert("bad signature");
        stake.proposeSlash(c, sigs); // v of 0 or 1
    }

    function _split(bytes memory sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }

    function test_SignaturesDoNotCrossContractsOrChains() public {
        _bonded(50_000);
        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(1)), 40_000);
        bytes[] memory sigs = _sigs(stake, _pair(keys[0], keys[1]), _claimHash(c));

        SellerStakeV2 other = _deploy(usdc);
        _register(other, seller, sellerKey, receiptKey);
        vm.expectRevert("not a verifier");
        other.proposeSlash(c, sigs);

        vm.chainId(block.chainid + 1);
        vm.expectRevert("not a verifier");
        stake.proposeSlash(c, sigs);
    }

    function test_CapsASlashAndRejectsZeroKindExpiredAndNoBuyer() public {
        _bonded(500_000);
        bytes32 n = bytes32(uint256(1));

        vm.expectRevert("bad amount");
        stake.proposeSlash(_claim(n, MAX + 1), new bytes[](0));
        vm.expectRevert("bad amount");
        stake.proposeSlash(_claim(n, 0), new bytes[](0));

        SellerStakeV2.Claim memory c = _claim(n, MAX);
        c.kind = 3;
        vm.expectRevert("bad kind");
        stake.proposeSlash(c, new bytes[](0));
        c.kind = 2;
        c.deadline = block.timestamp - 1;
        vm.expectRevert("signature expired");
        stake.proposeSlash(c, new bytes[](0));
        c.deadline = block.timestamp + 1;
        c.buyer = address(0);
        vm.expectRevert("zero buyer");
        stake.proposeSlash(c, new bytes[](0));

        c.buyer = buyer;
        _propose(c);
    }

    function test_APaymentBacksOneClaim_EvenAfterAVeto() public {
        _bonded(50_000);
        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(1)), 40_000);
        bytes32 id = _propose(c);
        _veto(id);

        c.amount = 1;
        c.evidence = keccak256("other evidence");
        bytes[] memory sigs = _sigs(stake, _pair(keys[0], keys[1]), _claimHash(c));
        vm.expectRevert("evidence used");
        stake.proposeSlash(c, sigs);

        c.buyer = makeAddr("another buyer"); // a different buyer's payment is a different payment
        _propose(c);
    }

    function test_Veto_InTheWindow_AndAfterItForAStuckRefund() public {
        _bonded(50_000);
        bytes32 id1 = _propose(_claim(bytes32(uint256(1)), 40_000));

        uint256 deadline = block.timestamp + 60;
        uint256[] memory oneKey = new uint256[](1);
        oneKey[0] = keys[0];
        bytes[] memory single = _sigs(stake, oneKey, _vetoHash(id1, deadline));
        vm.expectRevert("not enough signatures");
        stake.vetoSlash(id1, deadline, single);

        _veto(id1);
        assertEq(uint8(_status(id1)), uint8(SellerStakeV2.Status.Vetoed));
        deadline = block.timestamp + 60;
        bytes[] memory again = _sigs(stake, _pair(keys[0], keys[2]), _vetoHash(id1, deadline));
        vm.expectRevert("not pending");
        stake.vetoSlash(id1, deadline, again);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert("not pending");
        stake.executeSlash(id1);

        bytes32 id2 = _propose(_claim(bytes32(uint256(2)), 40_000));
        usdc.setBlocked(buyer);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert("blocked");
        stake.executeSlash(id2);
        _veto(id2);
        assertEq(stake.pendingCount(seller), 0);
        assertEq(stake.stakeOf(seller), 50_000);
    }

    function test_PaysWhatIsLeft_AndClosesAClaimWithNothingLeft() public {
        _bonded(30_000);
        bytes32 a = _propose(_claim(bytes32(uint256(1)), 20_000));
        bytes32 b = _propose(_claim(bytes32(uint256(2)), 20_000));
        bytes32 c = _propose(_claim(bytes32(uint256(3)), 5_000));
        vm.warp(block.timestamp + WINDOW);
        assertEq(stake.executeSlash(a), 20_000);
        assertEq(stake.executeSlash(b), 10_000);
        assertEq(stake.executeSlash(c), 0);
        assertEq(usdc.balanceOf(buyer), 30_000);
        assertEq(stake.pendingCount(seller), 0);
    }

    function test_TwoStolenKeysCannotEmptyABondInOneWindow() public {
        _bonded(1_000_000);
        for (uint256 i = 1; i <= 3; ++i) {
            _propose(_claim(bytes32(i), MAX));
        }
        SellerStakeV2.Claim memory fourth = _claim(bytes32(uint256(4)), MAX);
        bytes[] memory sigs = _sigs(stake, _pair(keys[0], keys[1]), _claimHash(fourth));
        vm.expectRevert("too many claims");
        stake.proposeSlash(fourth, sigs);

        vm.warp(block.timestamp + WINDOW);
        for (uint256 i = 1; i <= 3; ++i) {
            stake.executeSlash(stake.claimId(seller, buyer, bytes32(i)));
        }
        assertEq(stake.stakeOf(seller), 1_000_000 - 3 * MAX);
    }

    /// Each veto pays a fee to its sender, so if a veto freed a slot, 2 stolen keys could loop propose and veto in one block.
    function test_TwoStolenKeysCannotDrainABondByVetoingTheirOwnClaims() public {
        SellerStakeV2 target = _withFees(makeAddr("relayer"), 520_000); // bond 500 000
        address thief = makeAddr("thief");
        for (uint256 i = 1; i <= 3; ++i) {
            bytes32 id = _propose(_claim(bytes32(i), 1));
            uint256 deadline = block.timestamp + 10 minutes;
            bytes[] memory sigs = _sigs(target, _pair(keys[0], keys[2]), _vetoHash(id, deadline));
            vm.prank(thief);
            target.vetoSlash(id, deadline, sigs);
        }
        assertEq(target.pendingCount(seller), 0);
        SellerStakeV2.Claim memory next = _claim(bytes32(uint256(4)), 1);
        bytes[] memory claimSigs = _sigs(target, _pair(keys[0], keys[1]), _claimHash(next));
        vm.expectRevert("too many claims");
        target.proposeSlash(next, claimSigs);
        assertEq(usdc.balanceOf(thief), 3 * FEE);
        assertEq(target.stakeOf(seller), 500_000 - 3 * FEE);
    }

    function test_ASlotComesBackOnlyWhenItsWindowEnds() public {
        _bonded(1_000_000);
        for (uint256 i = 1; i <= 3; ++i) {
            _propose(_claim(bytes32(i), MAX));
        }
        vm.warp(block.timestamp + WINDOW - 1);
        SellerStakeV2.Claim memory early = _claim(bytes32(uint256(4)), MAX);
        bytes[] memory sigs = _sigs(stake, _pair(keys[0], keys[1]), _claimHash(early));
        vm.expectRevert("too many claims");
        stake.proposeSlash(early, sigs);

        vm.warp(block.timestamp + 1);
        for (uint256 i = 4; i <= 6; ++i) {
            _propose(_claim(bytes32(i), MAX));
        }
        assertEq(stake.pendingCount(seller), 6);
    }

    function test_TheCapIsPerSeller() public {
        _bonded(1_000_000);
        for (uint256 i = 1; i <= 3; ++i) {
            _propose(_claim(bytes32(i), MAX));
        }
        (address other, uint256 otherKey) = makeAddrAndKey("other seller");
        _register(stake, other, otherKey, receiptKey);
        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(9)), MAX);
        c.seller = other;
        _propose(c);
        assertEq(stake.pendingCount(other), 1);
    }

    // ---- fees ----

    function test_Fee_StakeSplitsIntoBondAndSenderFee() public {
        address relayer = makeAddr("relayer");
        SellerStakeV2 target = _withFees(relayer, 70_000);
        assertEq(usdc.balanceOf(relayer), FEE);
        assertEq(target.stakeOf(seller), 50_000);
        assertEq(target.totalStaked(), 50_000);
        assertEq(usdc.balanceOf(seller), 930_000);
        assertEq(usdc.balanceOf(address(target)), 50_000);
    }

    function test_Fee_ASellerSendingItsOwnStakePaysNoFee() public {
        SellerStakeV2 target = _withFees(seller, 70_000);
        assertEq(target.stakeOf(seller), 50_000);
        assertEq(usdc.balanceOf(seller), 950_000); // the fee came straight back
    }

    function test_Fee_AStakeMustLeaveABond() public {
        SellerStakeV2 target = new SellerStakeV2(IUSDC(address(usdc)), vs, COOLDOWN, FEE, FEE);
        vm.expectRevert("stake below fee");
        target.stakeWithAuthorization(seller, FEE, 0, block.timestamp + 1 hours, bytes32(++authNonce), 27, 0, 0);
        target.stakeWithAuthorization(seller, FEE + 1, 0, block.timestamp + 1 hours, bytes32(++authNonce), 27, 0, 0);
        assertEq(target.stakeOf(seller), 1);
    }

    function test_Fee_ASlashPaysTheBuyerThenTheSender() public {
        SellerStakeV2 target = _withFees(makeAddr("relayer"), 120_000); // bond 100 000
        bytes32 id = _propose(_claim(bytes32(uint256(1)), 40_000));
        vm.warp(block.timestamp + WINDOW);
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        assertEq(target.executeSlash(id), 40_000);
        assertEq(usdc.balanceOf(buyer), 40_000);
        assertEq(usdc.balanceOf(keeper), FEE);
        assertEq(target.stakeOf(seller), 40_000);
        assertEq(usdc.balanceOf(address(target)), target.totalStaked());
    }

    function test_Fee_TheBuyerComesFirstWhenTheBondIsShort() public {
        SellerStakeV2 target = _withFees(makeAddr("relayer"), 50_000); // bond 30 000
        bytes32 id = _propose(_claim(bytes32(uint256(1)), 25_000));
        bytes32 empty = _propose(_claim(bytes32(uint256(2)), 25_000));
        vm.warp(block.timestamp + WINDOW);
        address keeper = makeAddr("keeper");
        vm.startPrank(keeper);
        assertEq(target.executeSlash(id), 25_000);
        assertEq(usdc.balanceOf(keeper), 5_000); // all that was left
        assertEq(target.executeSlash(empty), 0);
        vm.stopPrank();
        assertEq(usdc.balanceOf(keeper), 5_000);
        assertEq(usdc.balanceOf(buyer), 25_000);
        assertEq(target.totalStaked(), 0);
    }

    function test_Fee_AVetoChargesTheSellerButNeverTheBuyerRefund() public {
        SellerStakeV2 target = _withFees(makeAddr("relayer"), 120_000); // bond 100 000
        bytes32 id = _propose(_claim(bytes32(uint256(1)), 40_000));
        uint256 deadline = block.timestamp + 10 minutes;
        bytes[] memory sigs = _sigs(target, _pair(keys[0], keys[2]), _vetoHash(id, deadline));
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        target.vetoSlash(id, deadline, sigs);
        assertEq(usdc.balanceOf(keeper), FEE);
        assertEq(usdc.balanceOf(buyer), 0);
        assertEq(target.stakeOf(seller), 80_000);
        assertEq(usdc.balanceOf(address(target)), target.totalStaked());
    }

    function test_Fee_AnEmptyBondStillClosesAClaim() public {
        SellerStakeV2 target = _withFees(makeAddr("relayer"), 40_000); // bond 20 000
        bytes32 a = _propose(_claim(bytes32(uint256(1)), 20_000));
        bytes32 b = _propose(_claim(bytes32(uint256(2)), 1));
        vm.warp(block.timestamp + WINDOW);
        target.executeSlash(a);
        uint256 deadline = block.timestamp + 10 minutes;
        target.vetoSlash(b, deadline, _sigs(target, _pair(keys[0], keys[2]), _vetoHash(b, deadline)));
        assertEq(target.pendingCount(seller), 0);
    }

    function test_Fee_ASenderUsdcRefusesCannotTrapARefund() public {
        SellerStakeV2 target = _withFees(makeAddr("relayer"), 120_000);
        bytes32 id = _propose(_claim(bytes32(uint256(1)), 40_000));
        vm.warp(block.timestamp + WINDOW);
        address bad = makeAddr("blocked sender");
        usdc.setBlocked(bad);
        vm.prank(bad);
        vm.expectRevert("blocked");
        target.executeSlash(id);
        assertEq(target.executeSlash(id), 40_000); // anyone else can still close it
    }

    function testFuzz_Fee_NoFeeEverTakesMoreThanTheBondHolds(uint256 bond, uint256 amount, uint256 fee) public {
        fee = bound(fee, 0, MAX);
        bond = bound(bond, 1, 1_000_000 - fee);
        amount = bound(amount, 1, MAX);
        SellerStakeV2 target = new SellerStakeV2(IUSDC(address(usdc)), vs, COOLDOWN, fee, fee);
        stake = target;
        _register(target, seller, sellerKey, receiptKey);
        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        target.stakeWithAuthorization(seller, bond + fee, 0, block.timestamp + 1 hours, bytes32(++authNonce), 27, 0, 0);
        bytes32 id = _propose(_claim(bytes32(uint256(1)), amount));
        vm.warp(block.timestamp + WINDOW);
        uint256 paid = target.executeSlash(id);
        uint256 afterRefund = bond - (amount < bond ? amount : bond);
        uint256 taken = fee < afterRefund ? fee : afterRefund;
        assertEq(paid, amount < bond ? amount : bond);
        assertEq(target.stakeOf(seller), afterRefund - taken);
        assertEq(usdc.balanceOf(address(target)), target.totalStaked());
    }

    // ---- unstaking ----

    function test_Withdraw_BlockedWhileAClaimIsOpen() public {
        _bonded(50_000);
        bytes32 id = _propose(_claim(bytes32(uint256(1)), 40_000));
        vm.prank(seller);
        stake.requestUnstake();
        vm.warp(block.timestamp + COOLDOWN);

        vm.expectRevert("claims pending");
        stake.withdraw(seller);

        stake.executeSlash(id);
        stake.withdraw(seller);
        assertEq(usdc.balanceOf(seller), 960_000);
        assertEq(stake.stakeOf(seller), 0);
        assertEq(stake.totalStaked(), 0);
    }

    function test_Cooldown_HoldsTheBond_AndStakingAgainCancelsIt() public {
        _stake(20_000);
        vm.prank(seller);
        stake.requestUnstake();
        vm.warp(block.timestamp + COOLDOWN - 1);
        vm.expectRevert("still locked");
        stake.withdraw(seller);

        _stake(1_000);
        vm.warp(block.timestamp + COOLDOWN);
        vm.expectRevert("still locked");
        stake.withdraw(seller);

        vm.prank(seller);
        stake.requestUnstake();
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(makeAddr("anyone"));
        stake.withdraw(seller); // the money still goes to the seller
        assertEq(usdc.balanceOf(seller), 1_000_000);
    }

    function test_GaslessUnstake_Once_SharingTheNonceWithTheReceiptSigner() public {
        _bonded(20_000); // uses nonce 0
        uint256 deadline = block.timestamp + 60;

        (uint8 v, bytes32 r, bytes32 s) = _signVrs(stake, keys[0], _unstakeHash(seller, 1, deadline));
        vm.expectRevert("bad signature");
        stake.requestUnstakeWithSig(seller, deadline, v, r, s);

        (v, r, s) = _signVrs(stake, sellerKey, _unstakeHash(seller, 1, deadline));
        stake.requestUnstakeWithSig(seller, deadline, v, r, s);
        assertEq(stake.unlockAt(seller), block.timestamp + COOLDOWN);

        vm.expectRevert("bad signature");
        stake.requestUnstakeWithSig(seller, deadline, v, r, s);
    }

    function test_RequestUnstake_NeedsABond() public {
        vm.prank(seller);
        vm.expectRevert("nothing staked");
        stake.requestUnstake();
    }

    // ---- rotation ----

    function test_Rotate_Takes2Of3_AndOldVerifiersLoseTheirPower() public {
        _bonded(50_000);
        (address v4, uint256 k4) = makeAddrAndKey("verifier-4");
        address[3] memory set = [vs[0], vs[1], v4];
        uint256 deadline = block.timestamp + 60;

        uint256[] memory oneKey = new uint256[](1);
        oneKey[0] = keys[0];
        bytes[] memory single = _sigs(stake, oneKey, _rotateHash(set, 0, deadline));
        vm.expectRevert("not enough signatures");
        stake.rotateVerifiers(set, deadline, single);

        bytes[] memory sigs = _sigs(stake, _pair(keys[0], keys[2]), _rotateHash(set, 0, deadline));
        stake.rotateVerifiers(set, deadline, sigs);
        assertEq(stake.verifiers(2), v4);
        assertEq(stake.rotationNonce(), 1);

        vm.expectRevert();
        stake.rotateVerifiers(set, deadline, sigs); // replay: the nonce moved on

        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(1)), 40_000);
        bytes[] memory old = _sigs(stake, _pair(keys[0], keys[2]), _claimHash(c));
        vm.expectRevert();
        stake.proposeSlash(c, old);

        stake.proposeSlash(c, _sigs(stake, _pair(keys[1], k4), _claimHash(c)));

        address[3] memory dup = [vs[0], vs[0], v4];
        bytes[] memory dupSigs = _sigs(stake, _pair(keys[0], keys[1]), _rotateHash(dup, 1, deadline));
        vm.expectRevert("duplicate verifier");
        stake.rotateVerifiers(dup, deadline, dupSigs);
    }

    // ---- a hostile token ----

    function test_Reentrancy_WithdrawCannotReenterItself() public {
        ReentrantUSDC token = new ReentrantUSDC();
        SellerStakeV2 target = _deploy(token);
        token.mint(seller, 50_000);
        target.stakeWithAuthorization(seller, 50_000, 0, block.timestamp + 1 hours, bytes32(uint256(1)), 27, 0, 0);
        vm.prank(seller);
        target.requestUnstake();
        vm.warp(block.timestamp + COOLDOWN);

        token.arm(address(target), abi.encodeCall(SellerStakeV2.withdraw, (seller)));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        target.withdraw(seller);
        assertEq(target.stakeOf(seller), 50_000);
    }

    function test_Reentrancy_ExecuteCannotReenterWithdraw() public {
        ReentrantUSDC token = new ReentrantUSDC();
        SellerStakeV2 target = _deploy(token);
        token.mint(seller, 50_000);
        target.stakeWithAuthorization(seller, 50_000, 0, block.timestamp + 1 hours, bytes32(uint256(1)), 27, 0, 0);
        _register(target, seller, sellerKey, receiptKey);
        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(1)), 40_000);
        bytes32 id = target.proposeSlash(c, _sigs(target, _pair(keys[0], keys[1]), _claimHash(c)));
        vm.warp(block.timestamp + WINDOW);

        token.arm(address(target), abi.encodeCall(SellerStakeV2.withdraw, (seller)));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        target.executeSlash(id);
    }

    function test_Reentrancy_AFeeCannotReenterTheStakeCallOrAVeto() public {
        ReentrantUSDC token = new ReentrantUSDC();
        SellerStakeV2 target = new SellerStakeV2(IUSDC(address(token)), vs, COOLDOWN, FEE, FEE);
        token.mint(seller, 200_000);
        target.stakeWithAuthorization(seller, 100_000, 0, block.timestamp + 1 hours, bytes32(uint256(1)), 27, 0, 0);
        _register(target, seller, sellerKey, receiptKey);
        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(1)), 40_000);
        bytes32 id = target.proposeSlash(c, _sigs(target, _pair(keys[0], keys[1]), _claimHash(c)));
        vm.prank(seller);
        target.requestUnstake();
        vm.warp(block.timestamp + COOLDOWN);

        uint256 deadline = block.timestamp + 10 minutes;
        bytes[] memory sigs = _sigs(target, _pair(keys[0], keys[2]), _vetoHash(id, deadline));
        token.arm(address(target), abi.encodeCall(SellerStakeV2.withdraw, (seller)));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        target.vetoSlash(id, deadline, sigs);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        target.stakeWithAuthorization(seller, 50_000, 0, block.timestamp + 1 hours, bytes32(uint256(2)), 27, 0, 0);
    }

    // ---- fuzz ----

    function testFuzz_AmountAboveTheCapIsAlwaysRefused(uint256 amount) public {
        amount = bound(amount, MAX + 1, type(uint256).max);
        _bonded(500_000);
        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(1)), amount);
        bytes[] memory sigs = _sigs(stake, _pair(keys[0], keys[1]), _claimHash(c));
        vm.expectRevert("bad amount");
        stake.proposeSlash(c, sigs);
    }

    function testFuzz_RefundIsTheSmallerOfClaimAndBond(uint256 bond, uint256 amount) public {
        bond = bound(bond, 1, 1_000_000);
        amount = bound(amount, 1, MAX);
        _bonded(bond);
        bytes32 id = _propose(_claim(bytes32(uint256(1)), amount));
        vm.warp(block.timestamp + WINDOW);
        uint256 paid = stake.executeSlash(id);
        assertEq(paid, amount < bond ? amount : bond);
        assertEq(usdc.balanceOf(buyer), paid);
        assertEq(stake.stakeOf(seller), bond - paid);
        assertEq(usdc.balanceOf(address(stake)), stake.totalStaked());
    }

    function testFuzz_OutsideKeysCannotPropose(uint256 a, uint256 b) public {
        a = bound(a, 1, 1e30);
        b = bound(b, 1, 1e30);
        vm.assume(a != b);
        for (uint256 i; i < 3; ++i) {
            vm.assume(a != keys[i] && b != keys[i]);
        }
        _bonded(50_000);
        SellerStakeV2.Claim memory c = _claim(bytes32(uint256(1)), 40_000);
        bytes[] memory sigs = _sigs(stake, _pair(a, b), _claimHash(c));
        vm.expectRevert("not a verifier");
        stake.proposeSlash(c, sigs);
    }

    function testFuzz_ExecuteNeverBeforeTheWindowEnds(uint256 wait) public {
        wait = bound(wait, 0, WINDOW - 1);
        _bonded(50_000);
        bytes32 id = _propose(_claim(bytes32(uint256(1)), 40_000));
        vm.warp(block.timestamp + wait);
        vm.expectRevert("window open");
        stake.executeSlash(id);
    }

    function testFuzz_WithdrawNeverBeforeTheCooldownEnds(uint256 wait) public {
        wait = bound(wait, 0, COOLDOWN - 1);
        _stake(50_000);
        vm.prank(seller);
        stake.requestUnstake();
        vm.warp(block.timestamp + wait);
        vm.expectRevert("still locked");
        stake.withdraw(seller);
    }
}
