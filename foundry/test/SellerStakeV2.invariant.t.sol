// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {IUSDC, SellerStakeV2} from "../../contracts/SellerStakeV2.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {StakeSigning} from "./StakeBase.sol";

/// Random stake / unstake / withdraw / propose / veto / execute / rotate / time-warp calls, each checked against a plain
/// model of the contract: every call must succeed exactly when the model says it should. A wrong answer is recorded in
/// `broken` and failed by the invariant below, because a revert inside a handler would be ignored as a skipped call.
contract StakeHandler is StakeSigning {
    enum State {
        None,
        Pending,
        Executed,
        Vetoed
    }

    struct Ghost {
        address seller;
        uint256 amount;
        uint256 executeAfter;
        State state;
    }

    uint256 public constant MAX = 100_000;
    uint256 public constant WINDOW = 30 minutes;
    uint256 public constant COOLDOWN = 2 hours;
    uint256 public constant FEE = 20_000;
    uint256 public constant SLOTS = 3;

    MockUSDC public immutable usdc;
    SellerStakeV2 public immutable stake;
    address public immutable buyer = makeAddr("buyer");
    address[3] public sellers;
    uint256[3] private sellerKeys;
    uint256[6] private verifierKeys; // the first three start as the verifier set, the rest come in by rotation
    uint256[3] private current; // indexes into verifierKeys

    mapping(address => uint256) public modelStake;
    mapping(address => uint256) public modelUnlock;
    mapping(address => uint256) public modelPending;
    mapping(address => uint256[]) private proposedAt;
    mapping(bytes32 => Ghost) public ghosts;
    bytes32[] public ids;
    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public refunded;
    uint256 public feesPaid;
    uint256 public largestRefund;
    uint256 public mostInAWindow;
    string public broken;
    uint256 private nonce;

    uint256 public staked;
    uint256 public proposed;
    uint256 public vetoed;
    uint256 public executed;
    uint256 public released;
    uint256 public rotated;
    uint256 public refused;

    constructor() {
        vm.warp(1_800_000_000);
        for (uint256 i; i < 6; ++i) {
            (, verifierKeys[i]) = makeAddrAndKey(string.concat("verifier-", vm.toString(i)));
        }
        current = [0, 1, 2];
        usdc = new MockUSDC();
        stake = new SellerStakeV2(IUSDC(address(usdc)), [_verifier(0), _verifier(1), _verifier(2)], COOLDOWN, FEE, FEE);
        for (uint256 i; i < 3; ++i) {
            (sellers[i], sellerKeys[i]) = makeAddrAndKey(string.concat("seller-", vm.toString(i)));
            usdc.mint(sellers[i], 1e12);
        }
        // The third seller never registers a receipt signer, so it must stay unslashable.
        _register(stake, sellers[0], sellerKeys[0], makeAddr("receipt-0"));
        _register(stake, sellers[1], sellerKeys[1], makeAddr("receipt-1"));
    }

    function _verifier(uint256 i) private view returns (address) {
        return vm.addr(verifierKeys[i]);
    }

    function _isCurrent(uint256 i) private view returns (bool) {
        return current[0] == i || current[1] == i || current[2] == i;
    }

    function _check(bool ok, string memory what) private {
        if (!ok && bytes(broken).length == 0) broken = what;
    }

    /// The slash fee the model expects: what is set, or what the bond still holds. Checks the sender got it.
    function _modelFee(address s, uint256 feesBefore) private returns (uint256 fee) {
        uint256 left = modelStake[s];
        fee = FEE < left ? FEE : left;
        modelStake[s] = left - fee;
        feesPaid += fee;
        _check(usdc.balanceOf(address(this)) - feesBefore == fee, "paid the sender the wrong fee");
    }

    /// How many claims against `s` were proposed in the last window: each of them still holds a slot.
    function _recentClaims(address s) private view returns (uint256 count) {
        uint256[] storage times = proposedAt[s];
        for (uint256 i = times.length; i > 0 && block.timestamp < times[i - 1] + WINDOW; --i) {
            count++;
        }
    }

    function stakeBond(uint256 who, uint256 value) external {
        address s = sellers[who % 3];
        value = bound(value, FEE + 1, FEE + 60_000);
        uint256 feesBefore = usdc.balanceOf(address(this));
        stake.stakeWithAuthorization(s, value, 0, block.timestamp + 1 hours, bytes32(++nonce), 27, 0, 0);
        _check(usdc.balanceOf(address(this)) - feesBefore == FEE, "stake paid the sender the wrong fee");
        modelStake[s] += value - FEE;
        modelUnlock[s] = 0;
        deposited += value;
        feesPaid += FEE;
        staked++;
    }

    function requestUnstake(uint256 who) external {
        address s = sellers[who % 3];
        vm.prank(s);
        try stake.requestUnstake() {
            _check(modelStake[s] > 0, "unstaked with nothing staked");
            modelUnlock[s] = block.timestamp + COOLDOWN;
        } catch {
            _check(modelStake[s] == 0, "refused a valid unstake");
            refused++;
        }
    }

    function withdraw(uint256 who) external {
        address s = sellers[who % 3];
        uint256 before = usdc.balanceOf(s);
        uint256 t = modelUnlock[s];
        bool allowed = t != 0 && block.timestamp >= t && modelPending[s] == 0;
        try stake.withdraw(s) {
            _check(allowed, "released a bond it should have held");
            _check(usdc.balanceOf(s) - before == modelStake[s], "released the wrong amount");
            withdrawn += modelStake[s];
            modelStake[s] = 0;
            modelUnlock[s] = 0;
            released++;
        } catch {
            _check(!allowed, "refused a valid withdraw");
            refused++;
        }
    }

    function propose(uint256 who, uint256 payment, uint256 amount, uint256 kind, uint256 mask) external {
        // Mostly valid claims, so slashing gets real depth; 1 in 8 tries a bad amount, a bad kind or the unregistered seller.
        bool wild = kind % 8 == 0;
        address s = wild ? sellers[who % 3] : sellers[who % 2];
        SellerStakeV2.Claim memory c = SellerStakeV2.Claim({
            seller: s,
            buyer: buyer,
            amount: bound(amount, wild ? 0 : 1, wild ? 120_000 : MAX),
            paymentNonce: bytes32(payment % 32),
            evidence: keccak256(abi.encode(payment)),
            kind: wild ? uint8((kind >> 3) % 4) : uint8(kind % 2 + 1),
            deadline: block.timestamp + 10 minutes
        });
        // Bias towards two current verifiers; the rest of the time any subset of the six, rotated-out ones included.
        mask = mask % 4 != 0 ? (1 << current[mask % 3]) | (1 << current[(mask % 3 + 1) % 3]) : (mask >> 2) % 64;
        uint256 count;
        bool inSet = true;
        for (uint256 i; i < 6; ++i) {
            if (mask & (1 << i) != 0) {
                count++;
                inSet = inSet && _isCurrent(i);
            }
        }
        uint256[] memory keys = new uint256[](count);
        uint256 n;
        for (uint256 i; i < 6; ++i) {
            if (mask & (1 << i) != 0) keys[n++] = verifierKeys[i];
        }

        bytes32 id = stake.claimId(c.seller, c.buyer, c.paymentNonce);
        bool allowed = inSet && count >= 2 && c.amount > 0 && c.amount <= MAX && (c.kind == 1 || c.kind == 2) && s != sellers[2]
            && ghosts[id].state == State.None && _recentClaims(s) < SLOTS;
        try stake.proposeSlash(c, _sigs(stake, keys, _claimHash(c))) {
            _check(allowed, "accepted a claim it should have refused");
            ghosts[id] = Ghost(s, c.amount, block.timestamp + WINDOW, State.Pending);
            ids.push(id);
            proposedAt[s].push(block.timestamp);
            mostInAWindow = _recentClaims(s) > mostInAWindow ? _recentClaims(s) : mostInAWindow;
            modelPending[s]++;
            proposed++;
        } catch {
            _check(!allowed, "refused a valid claim");
            refused++;
        }
    }

    function veto(uint256 pick) external {
        if (ids.length == 0) return;
        bytes32 id = ids[pick % ids.length];
        Ghost storage g = ghosts[id];
        uint256 deadline = block.timestamp + 10 minutes;
        bytes[] memory sigs = _sigs(stake, _pair(verifierKeys[current[1]], verifierKeys[current[2]]), _vetoHash(id, deadline));
        bool allowed = g.state == State.Pending;
        uint256 feesBefore = usdc.balanceOf(address(this));
        try stake.vetoSlash(id, deadline, sigs) {
            _check(allowed, "vetoed a closed claim");
            g.state = State.Vetoed;
            modelPending[g.seller]--;
            _modelFee(g.seller, feesBefore);
            vetoed++;
        } catch {
            _check(!allowed, "refused a valid veto");
            refused++;
        }
    }

    function execute(uint256 pick) external {
        if (ids.length == 0) return;
        bytes32 id = ids[pick % ids.length];
        Ghost storage g = ghosts[id];
        uint256 before = usdc.balanceOf(buyer);
        uint256 feesBefore = usdc.balanceOf(address(this));
        bool allowed = g.state == State.Pending && block.timestamp >= g.executeAfter;
        try stake.executeSlash(id) returns (uint256 paid) {
            _check(allowed, "executed a claim it should have held");
            uint256 left = modelStake[g.seller];
            _check(paid == (g.amount < left ? g.amount : left), "paid the wrong refund");
            _check(usdc.balanceOf(buyer) - before == paid, "the buyer did not get the refund");
            modelStake[g.seller] = left - paid;
            modelPending[g.seller]--;
            g.state = State.Executed;
            _modelFee(g.seller, feesBefore);
            refunded += paid;
            if (paid > largestRefund) largestRefund = paid;
            executed++;
        } catch {
            _check(!allowed, "refused a valid execute");
            refused++;
        }
    }

    function rotate(uint256 slot, uint256 incoming) external {
        slot %= 3;
        incoming %= 6;
        if (_isCurrent(incoming)) return;
        uint256[3] memory next = current;
        next[slot] = incoming;
        address[3] memory set = [_verifier(next[0]), _verifier(next[1]), _verifier(next[2])];
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 hash = _rotateHash(set, stake.rotationNonce(), deadline);
        try stake.rotateVerifiers(set, deadline, _sigs(stake, _pair(verifierKeys[current[0]], verifierKeys[current[2]]), hash)) {
            current = next;
            rotated++;
        } catch {
            _check(false, "refused a valid rotation");
        }
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 3 hours));
    }
}

contract SellerStakeV2InvariantTest is StakeSigning {
    StakeHandler internal handler;

    function setUp() public {
        handler = new StakeHandler();
        targetContract(address(handler));
    }

    function _stake() private view returns (SellerStakeV2) {
        return handler.stake();
    }

    /// Every call matched the model, so stakes, unlock times, claims and refunds all behaved.
    function invariant_EveryCallMatchedTheModel() public view {
        assertEq(handler.broken(), "");
    }

    function invariant_ContractHoldsExactlyTheBonds() public view {
        assertEq(handler.usdc().balanceOf(address(_stake())), _stake().totalStaked());
    }

    function invariant_TotalIsTheSumOfTheBonds() public view {
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            sum += _stake().stakeOf(handler.sellers(i));
        }
        assertEq(_stake().totalStaked(), sum);
    }

    function invariant_NoMoneyAppearsOrVanishes() public view {
        assertEq(handler.deposited(), _stake().totalStaked() + handler.withdrawn() + handler.refunded() + handler.feesPaid());
    }

    /// The handler sends every call, so every fee must have reached it and nowhere else.
    function invariant_EveryFeeReachedTheSender() public view {
        assertEq(handler.usdc().balanceOf(address(handler)), handler.feesPaid());
    }

    function invariant_BondsAndPendingCountsMatchTheModel() public view {
        for (uint256 i; i < 3; ++i) {
            address s = handler.sellers(i);
            assertEq(_stake().stakeOf(s), handler.modelStake(s));
            assertEq(_stake().unlockAt(s), handler.modelUnlock(s));
            assertEq(_stake().pendingCount(s), handler.modelPending(s));
        }
    }

    function invariant_NoRefundAboveTheCap() public view {
        assertLe(handler.largestRefund(), handler.MAX());
    }

    function invariant_NoSellerGetsMoreClaimsThanItsSlotsInAWindow() public view {
        assertLe(handler.mostInAWindow(), handler.SLOTS());
    }

    /// A seller with no receipt signer can never lose money or have a claim open.
    function invariant_UnregisteredSellerIsNeverSlashed() public view {
        assertEq(_stake().pendingCount(handler.sellers(2)), 0);
    }

    function afterInvariant() public view {
        console.log("staked", handler.staked());
        console.log("proposed", handler.proposed());
        console.log("vetoed", handler.vetoed());
        console.log("executed", handler.executed());
        console.log("released", handler.released());
        console.log("rotated", handler.rotated());
        console.log("refused", handler.refused());
    }
}
