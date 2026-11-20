// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBeacon {
    function implementation() external view returns (address);
}

interface IStockToken {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function uiMultiplier() external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

contract RobinhoodForkTest {
    address constant STOCK_BEACON = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address constant AAPL_TOKEN = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;

    function test_LiveBeaconAndStockTokenState() public view {
        address impl = IBeacon(STOCK_BEACON).implementation();
        require(impl != address(0), "beacon impl is zero");

        uint256 mult = IStockToken(AAPL_TOKEN).uiMultiplier();
        require(mult >= 1e18, "unexpected multiplier");

        (, int256 answer, , uint256 updatedAt, ) = IAggregatorV3(AAPL_FEED).latestRoundData();
        require(answer > 0 && updatedAt > 0, "invalid feed answer");
    }
}
