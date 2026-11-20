import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { inspectWalletReadiness, scanEcosystemAndLayerZero } from './ecosystem.js'
import { evaluateActionableSignals, getMicroCapitalPlaybook } from './paper-trader.js'
import { runFullRwaScan } from './scanner.js'
import { buildGuardedSwapPayload } from './x402.js'

const server = new McpServer({
  name: 'robinhood-rwa-agent',
  version: '0.1.0',
})

server.tool(
  'scan_robinhood_rwa_markets',
  'Scan all 95 Stock Tokens, 34 Chainlink feeds, ERC-8056 uiMultipliers, and Uniswap v3 liquidity pools on Robinhood Chain mainnet (4663).',
  {
    minPoolTvlUsd: z.number().optional().default(50),
  },
  async ({ minPoolTvlUsd }) => {
    const report = await runFullRwaScan()
    const filtered = report.tokens
      .filter((t) => t.totalDexTvlUsd >= minPoolTvlUsd || t.oracleTokenPriceUsd !== null)
      .sort((a, b) => b.totalDexTvlUsd - a.totalDexTvlUsd)
      .slice(0, 35)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              scannedAtIso: report.scannedAtIso,
              blockNumber: report.blockNumber,
              wethPriceUsd: report.wethPriceUsd,
              summary: report.summary,
              topOpportunities: report.topOpportunities,
              markets: filtered,
            },
            null,
            2,
          ),
        },
      ],
    }
  },
)

server.tool(
  'inspect_stock_token_risk',
  'Inspect ERC-8056 corporate-action multiplier drift, double-counting oracle risk, pause flags, and executable Uniswap v3 quotes for a specific ticker (e.g. AAPL, NVDA, TSLA).',
  {
    symbol: z.string().describe('Ticker symbol such as AAPL, NVDA, TSLA, MSFT'),
  },
  async ({ symbol }) => {
    const report = await runFullRwaScan()
    const target = report.tokens.find((t) => t.symbol.toUpperCase() === symbol.trim().toUpperCase())
    if (!target) {
      return {
        content: [{ type: 'text', text: `Ticker ${symbol} not found in Robinhood Chain registry.` }],
        isError: true,
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(target, null, 2) }],
    }
  },
)

server.tool(
  'get_actionable_rwa_signals',
  'Run QuoterV2 executable spread simulation ($50 and $500) and ERC-8056 RiskGuard checks to surface safe RWA mean-reversion signals.',
  {
    minExecutableEdgeBps: z.number().optional().default(50),
  },
  async ({ minExecutableEdgeBps }) => {
    const report = await runFullRwaScan()
    const signals = evaluateActionableSignals(report, minExecutableEdgeBps)
    return {
      content: [{ type: 'text', text: JSON.stringify(signals, null, 2) }],
    }
  },
)

server.tool(
  'get_ecosystem_points_routes',
  'Scan live LayerZero V2 USDG OFT corridors (EID 30416), Lighter Vault TVL, and Arcus Season 1 points strategies on Robinhood Chain.',
  {},
  async () => {
    const eco = await scanEcosystemAndLayerZero()
    return {
      content: [{ type: 'text', text: JSON.stringify({ ecosystem: eco, playbook: getMicroCapitalPlaybook() }, null, 2) }],
    }
  },
)

server.tool(
  'inspect_wallet_readiness',
  'Inspect any EVM wallet on Robinhood Chain (4663): gas runway, USDG/WETH, all 95 Stock Token holdings (with ERC-8056 share equivalents), and LayerZero/Lighter/Uniswap approvals.',
  {
    walletAddress: z.string().describe('EVM address 0x...'),
  },
  async ({ walletAddress }) => {
    const report = await inspectWalletReadiness(walletAddress)
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
    }
  },
)

server.tool(
  'build_guarded_swap_calldata',
  'Generate ready-to-sign swapExactInputGuarded calldata targeting deployed RiskGuardRouter (0xE890D81346C465fAE5bCa38ad825669dE448690F) on Robinhood Chain (4663).',
  {
    symbol: z.string().describe('Stock Token ticker (e.g., NVDA, AAPL, SPCX, TSLA)'),
    sizeUsd: z.number().optional().default(50),
    direction: z.enum(['buy', 'sell']).optional(),
    maxDeviationBps: z.number().optional().default(150),
  },
  async ({ symbol, sizeUsd, direction, maxDeviationBps }) => {
    const report = await runFullRwaScan()
    const target = report.tokens.find((t) => t.symbol.toUpperCase() === symbol.trim().toUpperCase())
    if (!target) {
      return {
        content: [{ type: 'text', text: `Ticker ${symbol} not found in Robinhood Chain registry.` }],
        isError: true,
      }
    }
    const payload = buildGuardedSwapPayload(target, sizeUsd, direction, maxDeviationBps)
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP server fatal error:', err)
  process.exit(1)
})
