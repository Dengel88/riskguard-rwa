// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function decimals() external view returns (uint8);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IStockGuard {
    function paused() external view returns (bool);
    function oraclePaused() external view returns (bool);
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface ISwapRouterClassic {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title RiskGuardRouter
/// @notice Atomic ERC-8056 Corporate-Action & Chainlink Deviation Guarded Router for Robinhood Chain Stock Tokens.
/// @dev Protects retail traders and autonomous AI agents from trading halted RWA tokens, stale 24/5 feeds,
///      imminent stock splits/dividends, and illiquid DEX price dislocations.
contract RiskGuardRouter {
    address public immutable SWAP_ROUTER;
    bool public immutable IS_ROUTER_02;

    error ZeroAddress();
    error InvalidParameters();
    error StockTokenPaused(address stockToken);
    error StockOraclePaused(address stockToken);
    error PendingCorporateAction(address stockToken, uint256 currentMultiplier, uint256 newMultiplier, uint256 effectiveAt);
    error InvalidOracleAnswer(address feed, int256 answer);
    error StaleOracleFeed(address feed, uint256 updatedAt, uint256 maxOracleAge);
    error DeadlineExpired(uint256 deadline, uint256 currentTimestamp);
    error OracleDeviationExceeded(uint256 execPrice18, uint256 boundPrice18, uint256 maxDeviationBps);
    error TransferFailed();

    event GuardedStockSwap(
        address indexed trader,
        address indexed stockToken,
        address indexed quoteToken,
        bool isBuy,
        uint256 amountIn,
        uint256 amountOut,
        uint256 oracleTokenPrice18,
        uint256 uiMultiplier
    );

    struct GuardParams {
        address stockToken;
        address quoteToken;
        address stockOracleFeed;
        address quoteOracleFeed; // address(0) when quoteToken is a $1 USD stablecoin (e.g. USDG)
        uint24 poolFee;
        bool isBuy; // true: quoteToken -> stockToken; false: stockToken -> quoteToken
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 maxDeviationBps; // max adverse deviation vs Chainlink token price (e.g. 100 = 1.00%)
        uint256 maxOracleAge; // max allowed Chainlink feed age in seconds (e.g. 3600 during market hours)
        uint256 deadline;
        bool blockPendingCorporateAction;
    }

    struct SafetyStatus {
        bool isSafe;
        bool tokenPaused;
        bool oraclePaused;
        bool hasPendingCorporateAction;
        bool oracleStale;
        uint256 uiMultiplier;
        uint256 oracleTokenPrice18;
        uint256 underlyingSharePrice18;
        uint256 oracleAgeSeconds;
    }

    constructor(address swapRouter, bool isRouter02) {
        if (swapRouter == address(0)) revert ZeroAddress();
        SWAP_ROUTER = swapRouter;
        IS_ROUTER_02 = isRouter02;
    }

    /// @notice Read-only ERC-8056 + Chainlink safety inspection for AI agents & UI frontends.
    function inspectStockSafety(address stockToken, address stockOracleFeed, uint256 maxOracleAge)
        external
        view
        returns (SafetyStatus memory status)
    {
        IStockGuard stock = IStockGuard(stockToken);
        status.tokenPaused = stock.paused();
        status.oraclePaused = stock.oraclePaused();
        status.uiMultiplier = stock.uiMultiplier();

        uint256 eff = stock.effectiveAt();
        uint256 nextMult = stock.newUIMultiplier();
        status.hasPendingCorporateAction = (eff > block.timestamp && nextMult != status.uiMultiplier);

        if (stockOracleFeed != address(0)) {
            (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(stockOracleFeed).latestRoundData();
            if (answer > 0 && updatedAt > 0) {
                uint8 feedDec = IAggregatorV3(stockOracleFeed).decimals();
                status.oracleTokenPrice18 = _scaleTo18(uint256(answer), feedDec);
                if (status.uiMultiplier > 0) {
                    status.underlyingSharePrice18 = (status.oracleTokenPrice18 * 1e18) / status.uiMultiplier;
                }
                status.oracleAgeSeconds = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
                status.oracleStale = status.oracleAgeSeconds > maxOracleAge;
            } else {
                status.oracleStale = true;
            }
        }

        status.isSafe = !status.tokenPaused && !status.oraclePaused && !status.hasPendingCorporateAction && !status.oracleStale;
    }

    /// @notice Execute a Uniswap v3 swap strictly gated by ERC-8056 corporate-action & Chainlink oracle bounds.
    function swapExactInputGuarded(GuardParams calldata p) external returns (uint256 amountOut) {
        if (block.timestamp > p.deadline) revert DeadlineExpired(p.deadline, block.timestamp);
        if (p.stockToken == address(0) || p.quoteToken == address(0) || p.stockOracleFeed == address(0)) {
            revert ZeroAddress();
        }
        if (p.amountIn == 0 || p.maxDeviationBps >= 10_000) revert InvalidParameters();

        // 1. Verify Stock Token pause & ERC-8056 corporate-action safety
        IStockGuard stock = IStockGuard(p.stockToken);
        if (stock.paused()) revert StockTokenPaused(p.stockToken);
        if (stock.oraclePaused()) revert StockOraclePaused(p.stockToken);

        uint256 currentMult = stock.uiMultiplier();
        if (p.blockPendingCorporateAction) {
            uint256 eff = stock.effectiveAt();
            uint256 nextMult = stock.newUIMultiplier();
            if (eff > block.timestamp && nextMult != currentMult) {
                revert PendingCorporateAction(p.stockToken, currentMult, nextMult, eff);
            }
        }

        // 2. Read multiplier-adjusted Stock Token USD price (1e18) from Chainlink
        uint256 stockOracleUsd18 = _readVerifiedFeed18(p.stockOracleFeed, p.maxOracleAge);
        uint256 quoteOracleUsd18 =
            p.quoteOracleFeed == address(0) ? 1e18 : _readVerifiedFeed18(p.quoteOracleFeed, p.maxOracleAge);

        // 3. Pull exact input tokens & route through Uniswap v3 directly to msg.sender
        address tokenIn = p.isBuy ? p.quoteToken : p.stockToken;
        address tokenOut = p.isBuy ? p.stockToken : p.quoteToken;

        if (!IERC20Minimal(tokenIn).transferFrom(msg.sender, address(this), p.amountIn)) revert TransferFailed();
        if (!IERC20Minimal(tokenIn).approve(SWAP_ROUTER, p.amountIn)) revert TransferFailed();

        if (IS_ROUTER_02) {
            amountOut = ISwapRouter02(SWAP_ROUTER).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: p.poolFee,
                    recipient: msg.sender,
                    amountIn: p.amountIn,
                    amountOutMinimum: p.minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            amountOut = ISwapRouterClassic(SWAP_ROUTER).exactInputSingle(
                ISwapRouterClassic.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: p.poolFee,
                    recipient: msg.sender,
                    deadline: p.deadline,
                    amountIn: p.amountIn,
                    amountOutMinimum: p.minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        // 4. Enforce realized execution price against Chainlink oracle band (no ERC-8056 double-counting)
        uint8 quoteDecimals = IERC20Minimal(p.quoteToken).decimals();
        if (p.isBuy) {
            // amountIn is quoteToken, amountOut is stockToken (18 dec)
            uint256 spentUsd18 = (_scaleTo18(p.amountIn, quoteDecimals) * quoteOracleUsd18) / 1e18;
            uint256 execBuyPrice18 = (spentUsd18 * 1e18) / amountOut;
            uint256 maxAllowedBuyPrice18 = (stockOracleUsd18 * (10_000 + p.maxDeviationBps)) / 10_000;
            if (execBuyPrice18 > maxAllowedBuyPrice18) {
                revert OracleDeviationExceeded(execBuyPrice18, maxAllowedBuyPrice18, p.maxDeviationBps);
            }
        } else {
            // amountIn is stockToken (18 dec), amountOut is quoteToken
            uint256 receivedUsd18 = (_scaleTo18(amountOut, quoteDecimals) * quoteOracleUsd18) / 1e18;
            uint256 execSellPrice18 = (receivedUsd18 * 1e18) / p.amountIn;
            uint256 minAllowedSellPrice18 = (stockOracleUsd18 * (10_000 - p.maxDeviationBps)) / 10_000;
            if (execSellPrice18 < minAllowedSellPrice18) {
                revert OracleDeviationExceeded(execSellPrice18, minAllowedSellPrice18, p.maxDeviationBps);
            }
        }

        emit GuardedStockSwap(
            msg.sender, p.stockToken, p.quoteToken, p.isBuy, p.amountIn, amountOut, stockOracleUsd18, currentMult
        );
    }

    function _readVerifiedFeed18(address feed, uint256 maxAge) internal view returns (uint256) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            IAggregatorV3(feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) {
            revert InvalidOracleAnswer(feed, answer);
        }
        if (block.timestamp > updatedAt && block.timestamp - updatedAt > maxAge) {
            revert StaleOracleFeed(feed, updatedAt, maxAge);
        }
        return _scaleTo18(uint256(answer), IAggregatorV3(feed).decimals());
    }

    function _scaleTo18(uint256 amount, uint8 dec) internal pure returns (uint256) {
        if (dec == 18) return amount;
        if (dec < 18) return amount * (10 ** (18 - dec));
        return amount / (10 ** (dec - 18));
    }
}
