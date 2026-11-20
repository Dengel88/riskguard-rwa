import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WORKSPACE_ROOT } from './config.js'
import type { FullScanReport, TokenScanResult } from './scanner.js'

export interface PaperSignal {
  timestamp: string
  blockNumber: number
  symbol: string
  action: 'BUY_ON_DEX_DISCOUNT' | 'SELL_ON_DEX_PREMIUM' | 'WATCH_ONLY_SPREAD'
  tradeSizeUsd: number
  oraclePriceUsd: number
  executableDexPriceUsd: number
  netSpreadBps: number
  estimatedGrossEdgeUsd: number
  poolAddress: string
  poolQuote: 'USDG' | 'WETH'
  poolFeeBps: number
  poolTvlUsd: number
  uiMultiplier: number
  rationale: string
}

export interface PaperPosition {
  id: string
  symbol: string
  side: 'LONG_DISCOUNT' | 'SHORT_PREMIUM'
  status: 'OPEN' | 'CLOSED'
  sizeUsd: number
  tokensQty: number
  openedAt: string
  openBlock: number
  entryDexPriceUsd: number
  entryOraclePriceUsd: number
  entrySpreadBps: number
  closedAt?: string
  closeBlock?: number
  exitDexPriceUsd?: number
  exitOraclePriceUsd?: number
  realizedNetPnlUsd?: number
  holdingMinutes?: number
}

export interface PaperLedger {
  updatedAt: string
  totalScans: number
  signalsLogged: number
  openPositionsCount: number
  closedTradesCount: number
  cumulativeRealizedPnlUsd: number
  openPositions: PaperPosition[]
  closedPositions: PaperPosition[]
  signals: PaperSignal[]
}

const LEDGER_PATH = resolve(WORKSPACE_ROOT, 'data', 'paper_ledger.json')
const EST_L2_ROUNDTRIP_GAS_USD = 0.02

export function evaluateActionableSignals(
  report: FullScanReport,
  minExecutableEdgeBps = 50,
): {
  actionable: PaperSignal[]
  blockedByRiskGuard: { symbol: string; reason: string }[]
} {
  const actionable: PaperSignal[] = []
  const blockedByRiskGuard: { symbol: string; reason: string }[] = []

  for (const t of report.tokens) {
    if (!t.bestPool || !t.oracleTokenPriceUsd || t.totalDexTvlUsd < 100) continue

    const fatalGuard = evaluateRiskGuard(t)
    if (fatalGuard) {
      if (t.midSpreadVsOracleBps !== null && Math.abs(t.midSpreadVsOracleBps) >= 100) {
        blockedByRiskGuard.push({ symbol: t.symbol, reason: fatalGuard })
      }
      continue
    }

    for (const q of t.executableQuotes) {
      if (
        q.buyPriceUsd !== null &&
        q.buySpreadVsOracleBps !== null &&
        q.buySpreadVsOracleBps <= -minExecutableEdgeBps
      ) {
        const edgeBps = Math.abs(q.buySpreadVsOracleBps)
        actionable.push({
          timestamp: report.scannedAtIso,
          blockNumber: report.blockNumber,
          symbol: t.symbol,
          action: 'BUY_ON_DEX_DISCOUNT',
          tradeSizeUsd: q.tradeSizeUsd,
          oraclePriceUsd: t.oracleTokenPriceUsd,
          executableDexPriceUsd: q.buyPriceUsd,
          netSpreadBps: q.buySpreadVsOracleBps,
          estimatedGrossEdgeUsd: Number(((q.tradeSizeUsd * edgeBps) / 10_000).toFixed(2)),
          poolAddress: t.bestPool.poolAddress,
          poolQuote: t.bestPool.quoteSymbol,
          poolFeeBps: t.bestPool.fee / 100,
          poolTvlUsd: Number(t.bestPool.tvlUsd.toFixed(2)),
          uiMultiplier: t.uiMultiplier,
          rationale: `${t.symbol} executable buy ($${q.tradeSizeUsd}) on Uniswap v3 (${t.bestPool.quoteSymbol} ${t.bestPool.fee / 10000}%) is ${edgeBps} bps below Chainlink token price ($${t.oracleTokenPriceUsd.toFixed(2)}).`,
        })
      }

      if (
        q.sellPriceUsd !== null &&
        q.sellSpreadVsOracleBps !== null &&
        q.sellSpreadVsOracleBps >= minExecutableEdgeBps
      ) {
        const edgeBps = q.sellSpreadVsOracleBps
        actionable.push({
          timestamp: report.scannedAtIso,
          blockNumber: report.blockNumber,
          symbol: t.symbol,
          action: 'SELL_ON_DEX_PREMIUM',
          tradeSizeUsd: q.tradeSizeUsd,
          oraclePriceUsd: t.oracleTokenPriceUsd,
          executableDexPriceUsd: q.sellPriceUsd,
          netSpreadBps: q.sellSpreadVsOracleBps,
          estimatedGrossEdgeUsd: Number(((q.tradeSizeUsd * edgeBps) / 10_000).toFixed(2)),
          poolAddress: t.bestPool.poolAddress,
          poolQuote: t.bestPool.quoteSymbol,
          poolFeeBps: t.bestPool.fee / 100,
          poolTvlUsd: Number(t.bestPool.tvlUsd.toFixed(2)),
          uiMultiplier: t.uiMultiplier,
          rationale: `${t.symbol} executable sell ($${q.tradeSizeUsd}) on Uniswap v3 (${t.bestPool.quoteSymbol} ${t.bestPool.fee / 10000}%) yields +${edgeBps} bps above Chainlink token price ($${t.oracleTokenPriceUsd.toFixed(2)}).`,
        })
      }
    }
  }

  actionable.sort((a, b) => Math.abs(b.netSpreadBps) - Math.abs(a.netSpreadBps))
  return { actionable, blockedByRiskGuard }
}

function evaluateRiskGuard(t: TokenScanResult): string | null {
  if (t.paused) return 'Token transfers paused on-chain (Stock.paused() == true)'
  if (t.oraclePaused) return 'Oracle paused for corporate action (Stock.oraclePaused() == true)'
  if (t.hasScheduledCorporateAction) {
    return `Scheduled ERC-8056 multiplier transition (${t.uiMultiplier} -> ${t.newUiMultiplier} at ts=${t.effectiveAt})`
  }
  if (t.oracleAgeHours !== null && t.oracleAgeHours > 72) {
    return `Chainlink feed stale (${t.oracleAgeHours.toFixed(1)}h > 72h limit)`
  }
  return null
}

export function loadPaperLedger(): PaperLedger {
  const empty: PaperLedger = {
    updatedAt: new Date().toISOString(),
    totalScans: 0,
    signalsLogged: 0,
    openPositionsCount: 0,
    closedTradesCount: 0,
    cumulativeRealizedPnlUsd: 0,
    openPositions: [],
    closedPositions: [],
    signals: [],
  }
  if (!existsSync(LEDGER_PATH)) return empty
  try {
    const raw = JSON.parse(readFileSync(LEDGER_PATH, 'utf-8')) as Partial<PaperLedger>
    return {
      ...empty,
      ...raw,
      openPositions: raw.openPositions ?? [],
      closedPositions: raw.closedPositions ?? [],
      signals: raw.signals ?? [],
    }
  } catch {
    return empty
  }
}

export function stepPaperPortfolio(
  report: FullScanReport,
  signals: PaperSignal[],
  entryMinBps = 60,
): {
  ledger: PaperLedger
  newlyOpened: PaperPosition[]
  newlyClosed: PaperPosition[]
} {
  mkdirSync(resolve(WORKSPACE_ROOT, 'data'), { recursive: true })
  const ledger = loadPaperLedger()
  const newlyOpened: PaperPosition[] = []
  const newlyClosed: PaperPosition[] = []

  const tokenBySym = new Map(report.tokens.map((t) => [t.symbol, t]))
  const stillOpen: PaperPosition[] = []

  // 1. Check if any open positions can be profitably closed on executable round-trip convergence
  for (const pos of ledger.openPositions) {
    const tok = tokenBySym.get(pos.symbol)
    const quote = tok?.executableQuotes.find((q) => q.tradeSizeUsd === pos.sizeUsd)
    if (!tok || !quote || !tok.oracleTokenPriceUsd) {
      stillOpen.push(pos)
      continue
    }

    if (pos.side === 'LONG_DISCOUNT' && quote.sellPriceUsd !== null) {
      const grossProceeds = pos.tokensQty * quote.sellPriceUsd
      const netPnl = grossProceeds - pos.sizeUsd - EST_L2_ROUNDTRIP_GAS_USD
      if (netPnl >= 0.08) {
        const closed: PaperPosition = {
          ...pos,
          status: 'CLOSED',
          closedAt: report.scannedAtIso,
          closeBlock: report.blockNumber,
          exitDexPriceUsd: quote.sellPriceUsd,
          exitOraclePriceUsd: tok.oracleTokenPriceUsd,
          realizedNetPnlUsd: Number(netPnl.toFixed(3)),
          holdingMinutes: Number(
            ((Date.parse(report.scannedAtIso) - Date.parse(pos.openedAt)) / 60_000).toFixed(1),
          ),
        }
        newlyClosed.push(closed)
        ledger.closedPositions.unshift(closed)
        ledger.cumulativeRealizedPnlUsd = Number(
          (ledger.cumulativeRealizedPnlUsd + closed.realizedNetPnlUsd!).toFixed(3),
        )
        continue
      }
    } else if (pos.side === 'SHORT_PREMIUM' && quote.buyPriceUsd !== null) {
      const repurchaseCost = pos.tokensQty * quote.buyPriceUsd
      const netPnl = pos.sizeUsd - repurchaseCost - EST_L2_ROUNDTRIP_GAS_USD
      if (netPnl >= 0.08) {
        const closed: PaperPosition = {
          ...pos,
          status: 'CLOSED',
          closedAt: report.scannedAtIso,
          closeBlock: report.blockNumber,
          exitDexPriceUsd: quote.buyPriceUsd,
          exitOraclePriceUsd: tok.oracleTokenPriceUsd,
          realizedNetPnlUsd: Number(netPnl.toFixed(3)),
          holdingMinutes: Number(
            ((Date.parse(report.scannedAtIso) - Date.parse(pos.openedAt)) / 60_000).toFixed(1),
          ),
        }
        newlyClosed.push(closed)
        ledger.closedPositions.unshift(closed)
        ledger.cumulativeRealizedPnlUsd = Number(
          (ledger.cumulativeRealizedPnlUsd + closed.realizedNetPnlUsd!).toFixed(3),
        )
        continue
      }
    }
    stillOpen.push(pos)
  }

  ledger.openPositions = stillOpen

  // 2. Open virtual $50 paper trades on strong dislocations not already open
  for (const sig of signals) {
    if (sig.tradeSizeUsd !== 50 || Math.abs(sig.netSpreadBps) < entryMinBps) continue
    const alreadyOpen = ledger.openPositions.some((p) => p.symbol === sig.symbol)
    if (alreadyOpen || ledger.openPositions.length >= 12) continue

    const side = sig.action === 'BUY_ON_DEX_DISCOUNT' ? 'LONG_DISCOUNT' : 'SHORT_PREMIUM'
    const opened: PaperPosition = {
      id: `${sig.symbol}-${report.blockNumber}`,
      symbol: sig.symbol,
      side,
      status: 'OPEN',
      sizeUsd: sig.tradeSizeUsd,
      tokensQty: sig.tradeSizeUsd / sig.executableDexPriceUsd,
      openedAt: report.scannedAtIso,
      openBlock: report.blockNumber,
      entryDexPriceUsd: sig.executableDexPriceUsd,
      entryOraclePriceUsd: sig.oraclePriceUsd,
      entrySpreadBps: sig.netSpreadBps,
    }
    ledger.openPositions.push(opened)
    newlyOpened.push(opened)
  }

  ledger.updatedAt = new Date().toISOString()
  ledger.totalScans += 1
  ledger.signals.unshift(...signals.slice(0, 10))
  ledger.signals = ledger.signals.slice(0, 200)
  ledger.closedPositions = ledger.closedPositions.slice(0, 200)
  ledger.signalsLogged = ledger.signals.length
  ledger.openPositionsCount = ledger.openPositions.length
  ledger.closedTradesCount = ledger.closedPositions.length

  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf-8')
  return { ledger, newlyOpened, newlyClosed }
}

export function appendToPaperLedger(signals: PaperSignal[], report?: FullScanReport): PaperLedger {
  if (report) {
    return stepPaperPortfolio(report, signals, 55).ledger
  }
  mkdirSync(resolve(WORKSPACE_ROOT, 'data'), { recursive: true })
  const ledger = loadPaperLedger()
  ledger.updatedAt = new Date().toISOString()
  ledger.totalScans += 1
  ledger.signals.unshift(...signals.slice(0, 10))
  ledger.signals = ledger.signals.slice(0, 200)
  ledger.signalsLogged = ledger.signals.length
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf-8')
  return ledger
}

export function getMicroCapitalPlaybook() {
  return [
    {
      protocol: 'LayerZero -> Robinhood Chain Bridge Route',
      category: 'Cross-Chain / Organic Footprint',
      capitalNeededUsd: '$20 - $50',
      strategy:
        'Bridge working ETH/stable liquidity via LayerZero-powered OFT/messaging paths rather than isolated faucets to stack organic cross-chain history alongside Robinhood Chain mainnet activity.',
    },
    {
      protocol: 'Uniswap v3 RWA Mean-Reversion ($50 Sizing)',
      category: 'On-Chain RWA Dislocation',
      capitalNeededUsd: '$25 - $100',
      strategy:
        'Target liquid StockToken/USDG or StockToken/WETH pools only when QuoterV2 net executable spread exceeds +75/-75 bps vs Chainlink during market hours (oracleAge < 1h) with RiskGuard clear.',
    },
    {
      protocol: 'Arcus (Season 1 Points) & Lighter ($LIT Incentives)',
      category: 'Perps & RWA P2P Points',
      capitalNeededUsd: '$30 - $100',
      strategy:
        'Use delta-neutral or tight-stop RWA/crypto hedges (e.g., spot Stock Token vs perp or low-leverage limit maker orders) to generate real volume points without directional blowup.',
    },
  ]
}
