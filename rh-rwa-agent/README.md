# Robinhood Chain RWA & Agentic Risk Terminal (`rh-rwa-agent`)

AI-native on-chain intelligence engine, **ERC-8056 Corporate-Action Risk Guard**, **Uniswap v3 vs. Chainlink Dislocation Scanner**, **Paper-Trading Simulator**, and **MCP Server** built natively for **Robinhood Chain (`chainId: 4663`)**.

---

## Быстрый запуск (на русском)

Все команды запускаются из папки `rh-rwa-agent`:

```powershell
cd d:\AI\Crypto\Robinhood\rh-rwa-agent

# 1. Разовый полный скан мейннета (95 Stock Tokens, 34 Chainlink-фида, пулы Uniswap v3)
npm run scan

# 2. Скан + запись сигналов в журнал paper-trading (data/paper_ledger.json)
npm run paper

# 3. Запуск живого локального веб-терминала (http://localhost:3847)
npm run dashboard

# 4. Запуск MCP-сервера (для подключения к Claude Desktop / Antigravity / Cursor)
npm run mcp
```

---

## Architecture & Grant Value Proposition (Arbitrum Orbit / Robinhood Chain)

1. **High-Throughput Multicall3 Indexing (`src/scanner.ts`):**
   - Resolves `WETH/USDG` spot, all **95 canonical Stock Tokens**, **34 Chainlink 24/5 feeds**, and **760 candidate Uniswap v3 pools** (`USDG` & `WETH` across `0.01%`, `0.05%`, `0.3%`, `1%` tiers) in a few batched `Multicall3` round-trips.
2. **ERC-8056 Multiplier & Corporate-Action Risk Guard:**
   - Detects `uiMultiplier()` drift from reinvested dividends/splits, upcoming scheduled `effectiveAt()` corporate actions (`newUIMultiplier()`), `oraclePaused()` states, and **double-counting valuation traps** (since Robinhood Chainlink feeds already price *per-token* rather than *per-share*).
3. **Executable QuoterV2 Dislocation & Paper-Trading (`src/paper-trader.ts`):**
   - Simulates real `$50` and `$500` swaps through canonical `QuoterV2` (`0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`) to measure **net executable spreads** after pool fees and price impact, gated by `RiskGuard`.
4. **Native Model Context Protocol Server (`src/mcp-server.ts`):**
   - Exposes `scan_robinhood_rwa_markets`, `inspect_stock_token_risk`, `get_actionable_rwa_signals`, `get_ecosystem_points_routes`, `inspect_wallet_readiness`, and `build_guarded_swap_calldata` to any MCP-compatible AI agent.
5. **`x402` Pay-Per-Signal API (`src/x402.ts`) & Bounded Agent Vault (`../foundry-lab/src/RiskGuardAgentVault.sol`):**
   - Exposes `/api/x402/execute-payload` returning HTTP `402 Payment Required` (`0.05 USDG` on `eip155:4663`) with on-chain receipt verification, and pairs with `RiskGuardAgentVault.sol` so autonomous trading keys only swap whitelisted Stock Tokens inside strict per-trade and 24h limits through `RiskGuardRouter` (`0xE890D81346C465fAE5bCa38ad825669dE448690F`).
