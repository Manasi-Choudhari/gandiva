// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// The part of Circle's FiatToken v2.2 (USDC) that plain ERC-20 does not have.
interface IUSDC is IERC20 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// Sellers lock USDC as a bond behind their listings. A slash needs signatures from 2 of 3 independent verifiers, is capped
/// at 0.10 USDC, waits out a 30 minute window in which the verifiers can veto it, and refunds the harmed buyer. There is no
/// owner or arbiter: the verifier set changes only by 2-of-3 of itself, and every call can be relayed by anyone, so sellers
/// never need gas.
contract SellerStakeV2 is EIP712, ReentrancyGuardTransient {
    IUSDC public immutable usdc;
    /// Delay between asking to unstake and withdrawing. Longer than the claim deadline plus the window, so a seller cannot
    /// pull its bond ahead of a claim for its last sale.
    uint256 public immutable cooldown;

    // Slither "timestamp" is accepted: deadlines and windows are minutes to hours, validators can only skew seconds.
    uint256 public constant MAX_SLASH = 100_000; // 0.10 USDC, the per-call price cap
    uint256 public constant SLASH_DELAY = 30 minutes;
    /// Verifiers only sign claims filed within this long after the payment (checked off chain).
    uint256 public constant CLAIM_DEADLINE = 1 hours;
    uint256 public constant THRESHOLD = 2;

    bytes32 private constant UNSTAKE_TYPEHASH = keccak256("Unstake(address seller,uint256 nonce,uint256 deadline)");
    bytes32 private constant RECEIPT_SIGNER_TYPEHASH =
        keccak256("SetReceiptSigner(address seller,address signer,uint256 nonce,uint256 deadline)");
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(address seller,address buyer,uint256 amount,bytes32 paymentNonce,bytes32 evidence,uint8 kind,uint256 deadline)"
    );
    bytes32 private constant VETO_TYPEHASH = keccak256("Veto(bytes32 id,uint256 deadline)");
    bytes32 private constant ROTATE_TYPEHASH =
        keccak256("Rotate(address verifier1,address verifier2,address verifier3,uint256 nonce,uint256 deadline)");

    enum Status {
        None,
        Pending,
        Executed,
        Vetoed
    }

    /// kind 1 = output broke the listed schema (backed by a seller-signed receipt); kind 2 = paid, no valid receipt came back.
    /// `evidence` is the hash of the evidence bundle anyone can fetch and re-check.
    struct Claim {
        address seller;
        address buyer;
        uint256 amount;
        bytes32 paymentNonce;
        bytes32 evidence;
        uint8 kind;
        uint256 deadline;
    }

    struct ClaimState {
        address seller;
        address buyer;
        uint256 amount;
        uint256 executeAfter;
        Status status;
    }

    address[3] public verifiers;
    uint256 public rotationNonce;

    mapping(address => uint256) public stakeOf;
    /// 0 = not unstaking; otherwise the time after which withdraw() releases the bond.
    mapping(address => uint256) public unlockAt;
    /// Per-seller nonce for its Unstake and SetReceiptSigner signatures.
    mapping(address => uint256) public nonces;
    uint256 public totalStaked;
    /// Hot key that signs the seller's response receipts. Only sellers with one can be slashed.
    mapping(address => address) public receiptSigner;
    /// Keyed by claimId(seller, buyer, paymentNonce), so a payment can back at most one claim, ever.
    mapping(bytes32 => ClaimState) public claims;
    mapping(address => uint256) public pendingCount;

    event Staked(address indexed seller, uint256 amount, uint256 total);
    event UnstakeRequested(address indexed seller, uint256 unlockAt);
    event Withdrawn(address indexed seller, uint256 amount);
    /// `previous` lets a verifier rebuild the signer at a past block from recent events alone (no archive node needed).
    event ReceiptSignerSet(address indexed seller, address signer, address previous);
    event SlashProposed(
        bytes32 indexed id, address indexed seller, address indexed buyer, uint256 amount, bytes32 evidence, uint8 kind, uint256 executeAfter
    );
    event SlashVetoed(bytes32 indexed id);
    event Slashed(bytes32 indexed id, address indexed seller, address indexed to, uint256 amount);
    event VerifiersRotated(address[3] verifiers, uint256 rotationNonce);

    constructor(IUSDC usdc_, address[3] memory verifiers_, uint256 cooldown_) EIP712("Gandiva SellerStake", "2") {
        require(cooldown_ > CLAIM_DEADLINE + SLASH_DELAY, "cooldown too short");
        usdc = usdc_;
        cooldown = cooldown_;
        _setVerifiers(verifiers_);
    }

    // slither-disable-next-line naming-convention (the EIP-712 / EIP-2612 name wallets and tools look for)
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---- staking (same as V1, except withdraw waits for open claims) ----

    /// Pulls `value` USDC from `seller` with its signed ReceiveWithAuthorization (to = this contract). Staking again cancels a pending unstake.
    function stakeWithAuthorization(
        address seller,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        require(value > 0, "zero stake");
        stakeOf[seller] += value;
        totalStaked += value;
        unlockAt[seller] = 0;
        emit Staked(seller, value, stakeOf[seller]);
        // Effects first; if USDC refuses the authorisation the whole call reverts.
        usdc.receiveWithAuthorization(seller, address(this), value, validAfter, validBefore, nonce, v, r, s);
    }

    /// Starts the cooldown with the seller's EIP-712 Unstake signature (relayed by anyone).
    function requestUnstakeWithSig(address seller, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        require(block.timestamp <= deadline, "signature expired");
        bytes32 structHash = keccak256(abi.encode(UNSTAKE_TYPEHASH, seller, nonces[seller]++, deadline));
        require(_signerOf(structHash, v, r, s) == seller, "bad signature");
        _requestUnstake(seller);
    }

    function requestUnstake() external {
        _requestUnstake(msg.sender);
    }

    function _requestUnstake(address seller) private {
        require(stakeOf[seller] > 0, "nothing staked");
        unlockAt[seller] = block.timestamp + cooldown;
        emit UnstakeRequested(seller, unlockAt[seller]);
    }

    /// Anyone may trigger it once the cooldown is over and no claim is open; the bond only ever goes back to the seller.
    function withdraw(address seller) external nonReentrant {
        uint256 t = unlockAt[seller];
        require(t != 0 && block.timestamp >= t, "still locked");
        require(pendingCount[seller] == 0, "claims pending");
        uint256 amount = stakeOf[seller];
        stakeOf[seller] = 0;
        unlockAt[seller] = 0;
        totalStaked -= amount;
        emit Withdrawn(seller, amount);
        SafeERC20.safeTransfer(usdc, seller, amount);
    }

    /// The seller (its payTo key) names the hot key that signs its receipts. It cannot be cleared, only replaced, so a seller
    /// cannot opt out of slashing ahead of a claim; verifiers check receipts against the signer at the payment's block.
    function setReceiptSignerWithSig(address seller, address signer, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        require(signer != address(0), "zero signer");
        require(block.timestamp <= deadline, "signature expired");
        bytes32 structHash = keccak256(abi.encode(RECEIPT_SIGNER_TYPEHASH, seller, signer, nonces[seller]++, deadline));
        require(_signerOf(structHash, v, r, s) == seller, "bad signature");
        emit ReceiptSignerSet(seller, signer, receiptSigner[seller]);
        receiptSigner[seller] = signer;
    }

    // ---- slashing ----

    function claimId(address seller, address buyer, bytes32 paymentNonce) public pure returns (bytes32) {
        return keccak256(abi.encode(seller, buyer, paymentNonce));
    }

    /// Opens a claim signed by at least THRESHOLD distinct verifiers (signatures sorted by signer, ascending).
    function proposeSlash(Claim calldata c, bytes[] calldata sigs) external returns (bytes32 id) {
        require(block.timestamp <= c.deadline, "signature expired");
        require(c.amount > 0 && c.amount <= MAX_SLASH, "bad amount");
        require(c.kind == 1 || c.kind == 2, "bad kind");
        require(c.buyer != address(0), "zero buyer");
        require(receiptSigner[c.seller] != address(0), "not slashable");
        id = claimId(c.seller, c.buyer, c.paymentNonce);
        require(claims[id].status == Status.None, "evidence used");
        // Claim has only static fields, so abi.encode(c) is exactly the EIP-712 encoding of its members.
        _checkVerifierSigs(keccak256(abi.encode(CLAIM_TYPEHASH, c)), sigs);
        uint256 executeAfter = block.timestamp + SLASH_DELAY;
        claims[id] = ClaimState(c.seller, c.buyer, c.amount, executeAfter, Status.Pending);
        pendingCount[c.seller]++;
        emit SlashProposed(id, c.seller, c.buyer, c.amount, c.evidence, c.kind, executeAfter);
    }

    /// Cancels an open claim: during the window (the seller rebutted it), or after it if the refund cannot be paid.
    function vetoSlash(bytes32 id, uint256 deadline, bytes[] calldata sigs) external {
        require(block.timestamp <= deadline, "signature expired");
        ClaimState storage cl = claims[id];
        require(cl.status == Status.Pending, "not pending");
        _checkVerifierSigs(keccak256(abi.encode(VETO_TYPEHASH, id, deadline)), sigs);
        cl.status = Status.Vetoed;
        pendingCount[cl.seller]--;
        emit SlashVetoed(id);
    }

    /// Anyone, once the window is over. Pays the buyer what is left of the claim from the bond; 0 still closes the claim.
    function executeSlash(bytes32 id) external nonReentrant returns (uint256 paid) {
        ClaimState storage cl = claims[id];
        require(cl.status == Status.Pending, "not pending");
        require(block.timestamp >= cl.executeAfter, "window open");
        cl.status = Status.Executed;
        address seller = cl.seller;
        pendingCount[seller]--;
        uint256 staked = stakeOf[seller];
        paid = cl.amount < staked ? cl.amount : staked;
        stakeOf[seller] = staked - paid;
        totalStaked -= paid;
        emit Slashed(id, seller, cl.buyer, paid);
        if (paid > 0) SafeERC20.safeTransfer(usdc, cl.buyer, paid);
    }

    /// Replaces the verifier set, signed by THRESHOLD of the current one.
    function rotateVerifiers(address[3] calldata newSet, uint256 deadline, bytes[] calldata sigs) external {
        require(block.timestamp <= deadline, "signature expired");
        _checkVerifierSigs(keccak256(abi.encode(ROTATE_TYPEHASH, newSet, rotationNonce, deadline)), sigs);
        rotationNonce++;
        _setVerifiers(newSet);
    }

    // ---- internals ----

    function _setVerifiers(address[3] memory set) private {
        require(set[0] != address(0) && set[1] != address(0) && set[2] != address(0), "zero verifier");
        require(set[0] != set[1] && set[0] != set[2] && set[1] != set[2], "duplicate verifier");
        verifiers = set;
        emit VerifiersRotated(set, rotationNonce);
    }

    /// Sorted ascending by signer, so each verifier counts once.
    function _checkVerifierSigs(bytes32 structHash, bytes[] calldata sigs) private view {
        require(sigs.length >= THRESHOLD, "not enough signatures");
        bytes32 digest = _hashTypedDataV4(structHash);
        address last = address(0);
        for (uint256 i; i < sigs.length; ++i) {
            // slither-disable-next-line unused-return (err is checked; the third value only details it)
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sigs[i]);
            require(err == ECDSA.RecoverError.NoError, "bad signature");
            require(signer > last, "signers not sorted");
            require(signer == verifiers[0] || signer == verifiers[1] || signer == verifiers[2], "not a verifier");
            last = signer;
        }
    }

    /// The signer of `structHash`. Rejects malleable (high-s) signatures and anything that recovers to nobody.
    function _signerOf(bytes32 structHash, uint8 v, bytes32 r, bytes32 s) private view returns (address signer) {
        ECDSA.RecoverError err;
        // slither-disable-next-line unused-return (err is checked; the third value only details it)
        (signer, err,) = ECDSA.tryRecover(_hashTypedDataV4(structHash), v, r, s);
        require(err == ECDSA.RecoverError.NoError, "bad signature");
    }
}
