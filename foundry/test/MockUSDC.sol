// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The parts of USDC the stake contract calls. Authorizations are not checked here: SellerStakeV2.fork.t.sol does that
/// against the real token.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => bool) public used;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function setBlocked(address a) external {
        blocked[a] = true;
    }

    function receiveWithAuthorization(address from, address to, uint256 value, uint256, uint256, bytes32 nonce, uint8, bytes32, bytes32)
        external
    {
        require(msg.sender == to, "caller must be the payee");
        require(!used[nonce], "authorization used");
        used[nonce] = true;
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        require(!blocked[to], "blocked");
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/// A hostile token that calls back into the stake contract, once, while it pays out. Once only, so a test can tell which
/// guard stopped it: a repeat attack from inside the first would trip the inner call's own guard instead.
contract ReentrantUSDC is MockUSDC {
    address private target;
    bytes private attack;

    function arm(address target_, bytes calldata attack_) external {
        target = target_;
        attack = attack_;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (target != address(0)) {
            address victim = target;
            target = address(0);
            (bool ok, bytes memory data) = victim.call(attack);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(data, 0x20), mload(data))
                }
            }
        }
        return super.transfer(to, value);
    }
}
