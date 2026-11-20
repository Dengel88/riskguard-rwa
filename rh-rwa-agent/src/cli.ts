import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WORKSPACE_ROOT } from './config.js'
import { inspectWalletReadiness, scanEcosystemAndLayerZero } from './ecosystem.js'
import { appendToPaperLedger, evaluateActionableSignals, getMicroCapitalPlaybook } from './paper-trader.js'
import { runFullRwaScan } from './scanner.js'

function fmtUsd(val: number | null | undefined, digits = 2): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—'
  if (Math.abs(val) >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`
  if (Math.abs(val) >= 10_000) return `$${(val / 1_000).toFixed(1)}K`
  return `$${val.toFixed(digits)}`
}

function fmtBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—'
  const sign = bps > 0 ? '+' : ''
  return `${sign}${bps} bps (${sign}${(bps / 100).toFixed(2)}%)`
}

async function main() {
  const mode = process.argv[2] ?? 'scan'
  const arg = process.argv[3]

  if (mode === 'ecosystem') {
    console.log('\n🌐 Scanning Robinhood Chain Ecosystem, Lighter Vault & LayerZero V2 Corridors...\n')
    const eco = await scanEcosystemAndLayerZero()
    mkdirSync(resolve(WORKSPACE_ROOT, 'data'), { recursive: true })
    writeFileSync(resolve(WORKSPACE_ROOT, 'data', 'latest_ecosystem.json'), JSON.stringify(eco, null, 2), 'utf-8')
    console.log(`✅ Block #${eco.blockNumber} | Gas: ${eco.gasPriceGwei.toFixed(4)} gwei`)
    console.log(`   USDG Total Supply on 4663: ${fmtUsd(eco.usdgTotalSupplyUsd)}`)
    console.log(`   WETH Total Supply on 4663: ${eco.wethTotalSupply.toFixed(2)} WETH (${fmtUsd(eco.wethTotalTvlUsd)})`)
    console.log(`   Lighter Vault USDG TVL:    ${fmtUsd(eco.lighterVaultUsdgUsd)}`)
    console.log(
      `\n🌉 LayerZero V2 (Robinhood EID ${eco.layerZero.localEid}) — Active USDG OFT Peer Corridors (${eco.layerZero.activeCorridorsCount}):`,
    )
    if (eco.layerZero.activeCorridors.length === 0) {
      console.log('   No standard EVM peers returned non-zero bytes32 on USDG OFT adapter.')
    } else {
      for (const c of eco.layerZero.activeCorridors) {
        console.log(
          `   • -> ${c.chainName.padEnd(14)} (EID ${c.dstEid}) | $50 USDG Bridge Fee: ${c.quote50UsdgFeeUsd !== null ? '$' + c.quote50UsdgFeeUsd.toFixed(4) + ` (${c.quote50UsdgFeeEth?.toFixed(6)} ETH)` : 'quote N/A'}`,
        )
      }
    }
    console.log('\n🎯 Points & Ecosystem Protocols:')
    for (const p of eco.pointsProtocols) {
      console.log(`   • ${p.name} [${p.status}]\n     On-chain: ${p.onchainMetric}\n     Strategy: ${p.lowBudgetPlay}`)
    }
    return
  }

  if (mode === 'wallet') {
    if (!arg) {
      console.error('Usage: npm run wallet -- 0xYourWalletAddress')
      process.exit(1)
    }
    const w = await inspectWalletReadiness(arg)
    console.log(`\n👛 Wallet Readiness on Robinhood Chain (4663): ${w.address}`)
    console.log(`   On-chain Tx Count: ${w.txCountOnRobinhood}`)
    console.log(`   Native ETH Gas:    ${w.nativeEth.toFixed(6)} ETH (${fmtUsd(w.nativeEthUsd)}) — ~${w.estimatedSwapsGasRunway} swaps runway`)
    console.log(`   USDG Balance:      ${fmtUsd(w.usdgBalance)} | WETH Balance: ${w.wethBalance.toFixed(6)} (${fmtUsd(w.wethBalanceUsd)})`)
    console.log(`   Total Portfolio:   ${fmtUsd(w.totalPortfolioUsd)}`)
    console.log(
      `   Protocol Approvals: Uniswap=${w.approvals.usdgToSwapRouter ? 'YES' : 'NO'} | LayerZero OFT=${w.approvals.usdgToLzOft ? 'YES' : 'NO'} | Lighter=${w.approvals.usdgToLighter ? 'YES' : 'NO'}`,
    )
    if (w.stockHoldings.length > 0) {
      console.log('   Stock Token Holdings:')
      for (const h of w.stockHoldings) {
        console.log(
          `     • ${h.symbol}: ${h.tokens} tokens (${h.shareEquivalent} shares @ ${h.uiMultiplier}x) = ${fmtUsd(h.valueUsd)}`,
        )
      }
    }
    console.log('\n📋 Recommended Action Plan (Вариант Б + LayerZero):')
    for (const step of w.recommendedNextSteps) {
      console.log(`   - ${step}`)
    }
    return
  }

  console.log(`\n⚡ Robinhood Chain (4663) RWA & Risk Intelligence Engine [mode=${mode}]`)
  console.log('Scanning 95 Stock Tokens, 34 Chainlink feeds, ERC-8056 multipliers & Uniswap v3 pools...\n')

  const t0 = Date.now()
  const report = await runFullRwaScan()
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2)

  mkdirSync(resolve(WORKSPACE_ROOT, 'data'), { recursive: true })
  const outPath = resolve(WORKSPACE_ROOT, 'data', 'latest_rwa_scan.json')
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8')

  const s = report.summary
  console.log(`✅ Scan completed in ${elapsedSec}s @ Block #${report.blockNumber}`)
  console.log(`   WETH Spot (on-chain):    ${fmtUsd(report.wethPriceUsd)}`)
  console.log(`   Stock Tokens Scanned:    ${s.totalTokens} (${s.pricedByChainlink} with Chainlink feeds)`)
  console.log(`   Tokens w/ Active Pools:  ${s.tokensWithActivePools}`)
  console.log(`   On-Chain RWA Market Cap: ${fmtUsd(s.totalOnchainRwaMarketCapUsd)}`)
  console.log(`   Uniswap v3 RWA Pool TVL: ${fmtUsd(s.totalDexRwaTvlUsd)}`)
  console.log(`   ERC-8056 Drift (>1.0x):  ${s.tokensWithMultiplierDrift} tokens | Scheduled Actions: ${s.scheduledCorporateActions}`)

  const topLiquid = [...report.tokens]
    .filter((t) => t.totalDexTvlUsd > 0 || (t.marketCapUsd ?? 0) > 0)
    .sort((a, b) => b.totalDexTvlUsd - a.totalDexTvlUsd)
    .slice(0, 15)

  console.log('\n📊 Top 15 RWA Pools by Uniswap v3 TVL:')
  console.log(
    'Ticker | DEX TVL   | Pool Pair     | Oracle USD | DEX Mid USD | Mid Spread       | uiMultiplier | Flags',
  )
  console.log('-'.repeat(112))
  for (const t of topLiquid) {
    const pair = t.bestPool ? `${t.symbol}/${t.bestPool.quoteSymbol} (${t.bestPool.fee / 10000}%)` : '—'
    console.log(
      `${t.symbol.padEnd(6)} | ${fmtUsd(t.totalDexTvlUsd).padEnd(9)} | ${pair.padEnd(13)} | ${fmtUsd(t.oracleTokenPriceUsd).padEnd(10)} | ${fmtUsd(t.bestPool?.dexMidPriceUsd).padEnd(11)} | ${fmtBps(t.midSpreadVsOracleBps).padEnd(16)} | ${t.uiMultiplier.toFixed(6).padEnd(12)} | ${t.riskFlags.join(', ') || 'OK'}`,
    )
  }

  const drifted = report.tokens
    .filter((t) => Math.abs(t.doubleCountTrapBps) >= 5)
    .sort((a, b) => Math.abs(b.doubleCountTrapBps) - Math.abs(a.doubleCountTrapBps))
    .slice(0, 8)

  if (drifted.length > 0) {
    console.log('\n🛡️ ERC-8056 Multiplier Drift & Double-Count Risk Guard (Top Tokens != 1.000000x):')
    for (const d of drifted) {
      console.log(
        `   • ${d.symbol.padEnd(6)} uiMultiplier=${d.uiMultiplier.toFixed(6)}x | Double-count error if naive protocol multiplies feed: ${fmtBps(d.doubleCountTrapBps)} | Token=${fmtUsd(d.oracleTokenPriceUsd)} vs UnderlyingShare=${fmtUsd(d.underlyingSharePriceUsd)}`,
      )
    }
  }

  const { actionable, blockedByRiskGuard } = evaluateActionableSignals(report, 40)
  console.log(`\n🎯 Executable QuoterV2 Arbitrage / Mean-Reversion Signals (${actionable.length} found):`)
  if (actionable.length === 0) {
    console.log('   No net executable spreads >= 40 bps after Uniswap v3 pool fees & price impact at this block.')
  } else {
    for (const sig of actionable.slice(0, 10)) {
      console.log(
        `   • [${sig.action}] ${sig.symbol} ($${sig.tradeSizeUsd}) | Oracle=${fmtUsd(sig.oraclePriceUsd)} vs ExecDEX=${fmtUsd(sig.executableDexPriceUsd)} | Net=${fmtBps(sig.netSpreadBps)} (~$${sig.estimatedGrossEdgeUsd}) | Pool TVL=${fmtUsd(sig.poolTvlUsd)}`,
      )
    }
  }

  if (blockedByRiskGuard.length > 0) {
    console.log('\n⚠️ Signals Blocked by RiskGuard:')
    for (const b of blockedByRiskGuard) {
      console.log(`   • ${b.symbol}: ${b.reason}`)
    }
  }

  if (mode === 'paper') {
    const ledger = appendToPaperLedger(actionable, report)
    console.log(
      `\n📝 Paper ledger updated (${ledger.signalsLogged} signals, ${ledger.openPositionsCount} open, ${ledger.closedTradesCount} closed | PnL=$${ledger.cumulativeRealizedPnlUsd.toFixed(2)}).`,
    )
    console.log('\n💡 Micro-Capital Playbook (Вариант Б + LayerZero):')
    for (const item of getMicroCapitalPlaybook()) {
      console.log(`   - ${item.protocol} [${item.capitalNeededUsd}]: ${item.strategy}`)
    }
  }

  console.log(`\nFull JSON snapshot saved to: ${outPath}\n`)
}

main().catch((err) => {
  console.error('Fatal CLI error:', err)
  process.exit(1)
})
