// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

// Isolated EVM fixture only. These contracts are never deployed on Robinhood.
contract CaliburMockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }
    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract CaliburMockRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    address public failOutput;
    uint256 public completedSteps;
    function setFailOutput(address token) external { failOutput = token; }
    function multicall(uint256 deadline, bytes[] calldata data) external returns (bytes[] memory results) {
        require(block.timestamp <= deadline, "expired");
        results = new bytes[](data.length);
        for (uint256 i; i < data.length; ++i) {
            (bool ok, bytes memory result) = address(this).delegatecall(data[i]);
            if (!ok) assembly { revert(add(result, 0x20), mload(result)) }
            results[i] = result;
        }
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external returns (uint256 amountOut) {
        // A deterministic 1:1 fixture, not an AMM or a quote approximation.
        if (p.tokenOut == failOutput) revert("late purchase failure");
        amountOut = p.amountIn;
        require(amountOut >= p.amountOutMinimum, "minimum");
        require(CaliburMockToken(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn));
        require(CaliburMockToken(p.tokenOut).transfer(p.recipient, amountOut));
        completedSteps += 1;
    }
}
