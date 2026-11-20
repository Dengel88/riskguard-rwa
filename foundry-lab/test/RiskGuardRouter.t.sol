// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/RiskGuardRouter.sol";

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function mockCall(address where, bytes calldata data, bytes calldata retdata) external;
    function clearMockedCalls() external;
    function expectRevert(bytes calldata) external;
}

interface IERC20Full is IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
}

contract RiskGuardRouterForkTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant LIGHTER_VAULT_USDG_WHALE = 0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d;

    address constant AAPL_TOKEN = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;

    RiskGuardRouter router;
    address trader = address(uint160(uint256(keccak256("riskguard.fork.trader.v1"))));

    function setUp() public {
        router = new RiskGuardRouter(SWAP_ROUTER_02, true);
        vm.prank(LIGHTER_VAULT_USDG_WHALE);
        IERC20Full(USDG).transfer(trader, 1_000 * 1e6);
    }

    function test_InspectStockSafety_LiveMainnetAAPL() public view {
        RiskGuardRouter.SafetyStatus memory st = router.inspectStockSafety(AAPL_TOKEN, AAPL_FEED, 72 hours);
        require(st.isSafe, "AAPL should be safe on live fork");
        require(st.oracleTokenPrice18 > 50e18, "unexpected AAPL price");
        require(st.uiMultiplier >= 1e18, "unexpected AAPL multiplier");
    }

    function test_GuardedBuyAndSell_LiveMainnetPool() public {
        uint256 beforeBal = IERC20Full(AAPL_TOKEN).balanceOf(trader);
        vm.startPrank(trader);
        IERC20Full(USDG).approve(address(router), 100 * 1e6);

        uint256 boughtAapl = router.swapExactInputGuarded(
            RiskGuardRouter.GuardParams({
                stockToken: AAPL_TOKEN,
                quoteToken: USDG,
                stockOracleFeed: AAPL_FEED,
                quoteOracleFeed: address(0),
                poolFee: 500,
                isBuy: true,
                amountIn: 50 * 1e6,
                minAmountOut: 0,
                maxDeviationBps: 250,
                maxOracleAge: 72 hours,
                deadline: block.timestamp + 300,
                blockPendingCorporateAction: true
            })
        );
        require(boughtAapl > 0, "bought 0 AAPL");
        require(IERC20Full(AAPL_TOKEN).balanceOf(trader) - beforeBal == boughtAapl, "AAPL delta mismatch");

        IERC20Full(AAPL_TOKEN).approve(address(router), boughtAapl);
        uint256 usdgBack = router.swapExactInputGuarded(
            RiskGuardRouter.GuardParams({
                stockToken: AAPL_TOKEN,
                quoteToken: USDG,
                stockOracleFeed: AAPL_FEED,
                quoteOracleFeed: address(0),
                poolFee: 500,
                isBuy: false,
                amountIn: boughtAapl,
                minAmountOut: 0,
                maxDeviationBps: 250,
                maxOracleAge: 72 hours,
                deadline: block.timestamp + 300,
                blockPendingCorporateAction: true
            })
        );
        require(usdgBack > 48 * 1e6, "unexpected roundtrip loss");
        vm.stopPrank();
    }

    function test_RevertWhen_OraclePausedForCorporateAction() public {
        vm.mockCall(AAPL_TOKEN, abi.encodeWithSelector(IStockGuard.oraclePaused.selector), abi.encode(true));
        vm.startPrank(trader);
        IERC20Full(USDG).approve(address(router), 50 * 1e6);
        vm.expectRevert(abi.encodeWithSelector(RiskGuardRouter.StockOraclePaused.selector, AAPL_TOKEN));
        router.swapExactInputGuarded(
            RiskGuardRouter.GuardParams({
                stockToken: AAPL_TOKEN,
                quoteToken: USDG,
                stockOracleFeed: AAPL_FEED,
                quoteOracleFeed: address(0),
                poolFee: 500,
                isBuy: true,
                amountIn: 50 * 1e6,
                minAmountOut: 0,
                maxDeviationBps: 250,
                maxOracleAge: 72 hours,
                deadline: block.timestamp + 300,
                blockPendingCorporateAction: true
            })
        );
        vm.stopPrank();
        vm.clearMockedCalls();
    }

    function test_RevertWhen_PendingSplitScheduled() public {
        uint256 curMult = IStockGuard(AAPL_TOKEN).uiMultiplier();
        uint256 targetEff = block.timestamp + 3600;
        vm.mockCall(AAPL_TOKEN, abi.encodeWithSelector(IStockGuard.effectiveAt.selector), abi.encode(targetEff));
        vm.mockCall(AAPL_TOKEN, abi.encodeWithSelector(IStockGuard.newUIMultiplier.selector), abi.encode(4e18));
        vm.startPrank(trader);
        IERC20Full(USDG).approve(address(router), 50 * 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(RiskGuardRouter.PendingCorporateAction.selector, AAPL_TOKEN, curMult, 4e18, targetEff)
        );
        router.swapExactInputGuarded(
            RiskGuardRouter.GuardParams({
                stockToken: AAPL_TOKEN,
                quoteToken: USDG,
                stockOracleFeed: AAPL_FEED,
                quoteOracleFeed: address(0),
                poolFee: 500,
                isBuy: true,
                amountIn: 50 * 1e6,
                minAmountOut: 0,
                maxDeviationBps: 250,
                maxOracleAge: 72 hours,
                deadline: block.timestamp + 300,
                blockPendingCorporateAction: true
            })
        );
        vm.stopPrank();
        vm.clearMockedCalls();
    }
}
