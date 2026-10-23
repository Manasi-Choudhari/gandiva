// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SellerStakeV2} from "../../contracts/SellerStakeV2.sol";

/// The EIP-712 hashes and signing every stake test shares. The type strings are written out again on purpose: a change in
/// the contract that src/stake/verify.ts does not know about must fail here.
abstract contract StakeSigning is Test {
    bytes32 internal constant CLAIM_TYPEHASH = keccak256(
        "Claim(address seller,address buyer,uint256 amount,bytes32 paymentNonce,bytes32 evidence,uint8 kind,uint256 deadline)"
    );
    bytes32 internal constant VETO_TYPEHASH = keccak256("Veto(bytes32 id,uint256 deadline)");
    bytes32 internal constant ROTATE_TYPEHASH =
        keccak256("Rotate(address verifier1,address verifier2,address verifier3,uint256 nonce,uint256 deadline)");
    bytes32 internal constant UNSTAKE_TYPEHASH = keccak256("Unstake(address seller,uint256 nonce,uint256 deadline)");
    bytes32 internal constant RECEIPT_SIGNER_TYPEHASH =
        keccak256("SetReceiptSigner(address seller,address signer,uint256 nonce,uint256 deadline)");
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function _signVrs(SellerStakeV2 stake, uint256 key, bytes32 structHash) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", stake.DOMAIN_SEPARATOR(), structHash)));
    }

    function _sign(SellerStakeV2 stake, uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = _signVrs(stake, key, structHash);
        return abi.encodePacked(r, s, v);
    }

    /// One signature per key, ordered by signer address as the contract wants them.
    function _sigs(SellerStakeV2 stake, uint256[] memory keys, bytes32 structHash) internal view returns (bytes[] memory out) {
        for (uint256 i = 1; i < keys.length; ++i) {
            for (uint256 j = i; j > 0 && vm.addr(keys[j - 1]) > vm.addr(keys[j]); --j) {
                (keys[j - 1], keys[j]) = (keys[j], keys[j - 1]);
            }
        }
        out = new bytes[](keys.length);
        for (uint256 i; i < keys.length; ++i) {
            out[i] = _sign(stake, keys[i], structHash);
        }
    }

    function _claimHash(SellerStakeV2.Claim memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(CLAIM_TYPEHASH, c));
    }

    function _vetoHash(bytes32 id, uint256 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(VETO_TYPEHASH, id, deadline));
    }

    function _rotateHash(address[3] memory set, uint256 nonce, uint256 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(ROTATE_TYPEHASH, set[0], set[1], set[2], nonce, deadline));
    }

    function _receiptSignerHash(address seller, address signer, uint256 nonce, uint256 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(RECEIPT_SIGNER_TYPEHASH, seller, signer, nonce, deadline));
    }

    function _unstakeHash(address seller, uint256 nonce, uint256 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(UNSTAKE_TYPEHASH, seller, nonce, deadline));
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory keys) {
        keys = new uint256[](2);
        keys[0] = a;
        keys[1] = b;
    }

    function _register(SellerStakeV2 stake, address seller, uint256 sellerKey, address signer) internal {
        uint256 deadline = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = _signVrs(stake, sellerKey, _receiptSignerHash(seller, signer, stake.nonces(seller), deadline));
        stake.setReceiptSignerWithSig(seller, signer, deadline, v, r, s);
    }
}
