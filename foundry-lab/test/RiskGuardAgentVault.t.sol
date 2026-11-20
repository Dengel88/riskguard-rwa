// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/RiskGuardAgentVault.sol";

interface VmVault {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes calldata) external;
}

interface IERC20VaultFull is IERC20Vault {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract RiskGuardAgentVaultForkTest {
    VmVault constant vm = VmVault(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Live deployed RiskGuardRouter on Robinhood Chain Mainnet (4663)
    address constant LIVE_RISK_GUARD_ROUTER = 0xE890D81346C465fAE5bCa38ad825669dE448690F;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant LIGHTER_VAULT_USDG_WHALE = 0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d;

    address constant AAPL_TOKEN = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;

    RiskGuardAgentVault vault;
    address vaultOwner = address(uint160(uint256(keccak256("riskguard.vault.owner.v1"))));
    address agentBot = address(uint160(uint256(keccak256("riskguard.vault.agent.v1"))));

    function setUp() public {
        vm.startPrank(vaultOwner);
        vault = new RiskGuardAgentVault(
            vaultOwner,
            agentBot,
            LIVE_RISK_GUARD_ROUTER,
            USDG,
            25 * 1e6, // max $25 per trade
            100 * 1e6 // max $100 per 24h
        );
        vault.setStockWhitelist(AAPL_TOKEN, true);
        vm.stopPrank();

        vm.prank(LIGHTER_VAULT_USDG_WHALE);
        IERC20VaultFull(USDG).transfer(address(vault), 200 * 1e6);
    }

    function test_AgentExecutesGuardedBuyAndSell_AgainstLiveMainnetRouter() public {
        uint256 usdgBefore = IERC20Vault(USDG).balanceOf(address(vault));
        vm.startPrank(agentBot);

        uint256 aaplBought = vault.executeAgentBuy(
            AAPL_TOKEN, AAPL_FEED, 500, 25 * 1e6, 0, 250, 72 hours, block.timestamp + 300
        );
        require(aaplBought > 0, "bought 0 AAPL");
        require(IERC20Vault(AAPL_TOKEN).balanceOf(address(vault)) == aaplBought, "AAPL not retained in vault");
        require(IERC20Vault(AAPL_TOKEN).balanceOf(agentBot) == 0, "agent must never hold custody");

        uint256 usdgBack = vault.executeAgentSell(
            AAPL_TOKEN, AAPL_FEED, 500, aaplBought, 0, 250, 72 hours, block.timestamp + 300
        );
        require(usdgBack > 24 * 1e6, "unexpected roundtrip loss");
        require(IERC20Vault(USDG).balanceOf(address(vault)) > usdgBefore - 1e6, "USDG not returned to vault");
        vm.stopPrank();
    }

    function test_RevertWhen_AgentExceedsPerTradeLimit() public {
        vm.startPrank(agentBot);
        vm.expectRevert(abi.encodeWithSelector(RiskGuardAgentVault.TradeLimitExceeded.selector, 50 * 1e6, 25 * 1e6));
        vault.executeAgentBuy(
            AAPL_TOKEN, AAPL_FEED, 500, 50 * 1e6, 0, 250, 72 hours, block.timestamp + 300
        );
        vm.stopPrank();
    }

    function test_RevertWhen_AgentAttemptsWithdraw() public {
        vm.startPrank(agentBot);
        vm.expectRevert(abi.encodeWithSelector(RiskGuardAgentVault.Unauthorized.selector));
        vault.withdrawAsset(USDG, 10 * 1e6, agentBot);
        vm.stopPrank();
    }
}
