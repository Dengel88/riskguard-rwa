// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Vault {
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IRiskGuardRouter {
    struct GuardParams {
        address stockToken;
        address quoteToken;
        address stockOracleFeed;
        address quoteOracleFeed;
        uint24 poolFee;
        bool isBuy;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 maxDeviationBps;
        uint256 maxOracleAge;
        uint256 deadline;
        bool blockPendingCorporateAction;
    }

    function swapExactInputGuarded(GuardParams calldata p) external returns (uint256 amountOut);
}

/// @title RiskGuardAgentVault
/// @notice Non-custodial bounded-budget vault allowing an autonomous AI trading operator to execute
///         whitelisted Stock Token swaps exclusively through `RiskGuardRouter` with strict per-trade
///         and rolling 24h USDG spending limits, while retaining all custody and withdrawal rights for `owner`.
contract RiskGuardAgentVault {
    address public owner;
    address public agentOperator;
    address public immutable ROUTER;
    address public immutable USDG;

    uint256 public maxTradeUsdg;
    uint256 public dailyLimitUsdg;
    uint256 public dayWindowStart;
    uint256 public spentInWindowUsdg;
    bool public paused;

    mapping(address => bool) public whitelistedStock;

    error Unauthorized();
    error ZeroAddress();
    error VaultPaused();
    error StockNotWhitelisted(address stockToken);
    error TradeLimitExceeded(uint256 requested, uint256 maxTrade);
    error DailyLimitExceeded(uint256 projected, uint256 dailyLimit);
    error TransferFailed();

    event AgentTradeExecuted(
        address indexed operator,
        address indexed stockToken,
        bool isBuy,
        uint256 amountIn,
        uint256 amountOut
    );
    event LimitsUpdated(uint256 maxTradeUsdg, uint256 dailyLimitUsdg);
    event StockWhitelistUpdated(address indexed stockToken, bool allowed);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event OwnerWithdrawal(address indexed asset, address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VaultPauseSet(bool paused);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != agentOperator) revert Unauthorized();
        if (paused) revert VaultPaused();
        _;
    }

    constructor(
        address owner_,
        address agentOperator_,
        address router_,
        address usdg_,
        uint256 maxTradeUsdg_,
        uint256 dailyLimitUsdg_
    ) {
        if (owner_ == address(0) || agentOperator_ == address(0) || router_ == address(0) || usdg_ == address(0)) {
            revert ZeroAddress();
        }
        owner = owner_;
        agentOperator = agentOperator_;
        ROUTER = router_;
        USDG = usdg_;
        maxTradeUsdg = maxTradeUsdg_;
        dailyLimitUsdg = dailyLimitUsdg_;
        dayWindowStart = block.timestamp;
    }

    /// @notice Execute a bounded USDG -> StockToken buy strictly through RiskGuardRouter.
    ///         All acquired Stock Tokens remain custodied inside this vault.
    function executeAgentBuy(
        address stockToken,
        address stockOracleFeed,
        uint24 poolFee,
        uint256 amountUsdg,
        uint256 minStockOut,
        uint256 maxDeviationBps,
        uint256 maxOracleAge,
        uint256 deadline
    ) external onlyOperator returns (uint256 amountOut) {
        if (!whitelistedStock[stockToken]) revert StockNotWhitelisted(stockToken);
        if (amountUsdg == 0 || amountUsdg > maxTradeUsdg) {
            revert TradeLimitExceeded(amountUsdg, maxTradeUsdg);
        }

        if (block.timestamp >= dayWindowStart + 1 days) {
            dayWindowStart = block.timestamp;
            spentInWindowUsdg = 0;
        }
        uint256 projected = spentInWindowUsdg + amountUsdg;
        if (projected > dailyLimitUsdg) {
            revert DailyLimitExceeded(projected, dailyLimitUsdg);
        }
        spentInWindowUsdg = projected;

        if (!IERC20Vault(USDG).approve(ROUTER, amountUsdg)) revert TransferFailed();

        amountOut = IRiskGuardRouter(ROUTER).swapExactInputGuarded(
            IRiskGuardRouter.GuardParams({
                stockToken: stockToken,
                quoteToken: USDG,
                stockOracleFeed: stockOracleFeed,
                quoteOracleFeed: address(0),
                poolFee: poolFee,
                isBuy: true,
                amountIn: amountUsdg,
                minAmountOut: minStockOut,
                maxDeviationBps: maxDeviationBps,
                maxOracleAge: maxOracleAge,
                deadline: deadline,
                blockPendingCorporateAction: true
            })
        );

        emit AgentTradeExecuted(msg.sender, stockToken, true, amountUsdg, amountOut);
    }

    /// @notice Execute a StockToken -> USDG sell strictly through RiskGuardRouter.
    ///         All received USDG remains custodied inside this vault.
    function executeAgentSell(
        address stockToken,
        address stockOracleFeed,
        uint24 poolFee,
        uint256 amountStock,
        uint256 minUsdgOut,
        uint256 maxDeviationBps,
        uint256 maxOracleAge,
        uint256 deadline
    ) external onlyOperator returns (uint256 amountOut) {
        if (!whitelistedStock[stockToken]) revert StockNotWhitelisted(stockToken);

        if (!IERC20Vault(stockToken).approve(ROUTER, amountStock)) revert TransferFailed();

        amountOut = IRiskGuardRouter(ROUTER).swapExactInputGuarded(
            IRiskGuardRouter.GuardParams({
                stockToken: stockToken,
                quoteToken: USDG,
                stockOracleFeed: stockOracleFeed,
                quoteOracleFeed: address(0),
                poolFee: poolFee,
                isBuy: false,
                amountIn: amountStock,
                minAmountOut: minUsdgOut,
                maxDeviationBps: maxDeviationBps,
                maxOracleAge: maxOracleAge,
                deadline: deadline,
                blockPendingCorporateAction: true
            })
        );

        emit AgentTradeExecuted(msg.sender, stockToken, false, amountStock, amountOut);
    }

    function setAgentOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorUpdated(agentOperator, newOperator);
        agentOperator = newOperator;
    }

    function setLimits(uint256 maxTradeUsdg_, uint256 dailyLimitUsdg_) external onlyOwner {
        maxTradeUsdg = maxTradeUsdg_;
        dailyLimitUsdg = dailyLimitUsdg_;
        emit LimitsUpdated(maxTradeUsdg_, dailyLimitUsdg_);
    }

    function setStockWhitelist(address stockToken, bool allowed) external onlyOwner {
        if (stockToken == address(0)) revert ZeroAddress();
        whitelistedStock[stockToken] = allowed;
        emit StockWhitelistUpdated(stockToken, allowed);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit VaultPauseSet(paused_);
    }

    function withdrawAsset(address asset, uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (!IERC20Vault(asset).transfer(to, amount)) revert TransferFailed();
        emit OwnerWithdrawal(asset, to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
