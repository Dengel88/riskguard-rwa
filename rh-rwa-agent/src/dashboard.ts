import { createServer } from 'node:http'
import { inspectWalletReadiness, scanEcosystemAndLayerZero, type EcosystemReport } from './ecosystem.js'
import { evaluateActionableSignals, getMicroCapitalPlaybook, loadPaperLedger } from './paper-trader.js'
import { runFullRwaScan, type FullScanReport } from './scanner.js'
import { buildGuardedSwapPayload, buildX402Challenge, verifyX402PaymentOnChain } from './x402.js'

const PORT = Number(process.env.PORT ?? 3847)
let cachedReport: FullScanReport | null = null
let cachedEco: EcosystemReport | null = null
let lastFetchMs = 0

async function getScanCached(force = false): Promise<{ report: FullScanReport; eco: EcosystemReport }> {
  if (!force && cachedReport && cachedEco && Date.now() - lastFetchMs < 20_000) {
    return { report: cachedReport, eco: cachedEco }
  }
  const report = await runFullRwaScan()
  const eco = await scanEcosystemAndLayerZero(report.wethPriceUsd)
  cachedReport = report
  cachedEco = eco
  lastFetchMs = Date.now()
  return { report, eco }
}

const HTML_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>RiskGuard RWA — Robinhood Chain (4663) Terminal</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: #0b0f17;
      --panel: #121826;
      --border: #1f2a40;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --accent: #00dc82;
      --warn: #f59e0b;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 24px; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
    h1 { font-size: 20px; margin: 0; display: flex; align-items: center; gap: 10px; }
    .badge { background: rgba(0,220,130,0.14); color: var(--accent); border: 1px solid rgba(0,220,130,0.35); padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    button { background: var(--accent); color: #04130c; border: 0; padding: 8px 16px; border-radius: 8px; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: wait; }
    input { background: #0d1320; color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; width: 360px; max-width: 100%; font-family: monospace; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(185px, 1fr)); gap: 12px; margin-bottom: 22px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
    .card .label { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .card .val { font-size: 21px; font-weight: 700; }
    h2 { font-size: 15px; margin: 22px 0 10px; color: #cbd5e1; }
    .table-wrap { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow-x: auto; margin-bottom: 18px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
    th { color: var(--muted); font-weight: 600; background: rgba(255,255,255,0.02); }
    .pos { color: var(--accent); font-weight: 600; }
    .neg { color: #60a5fa; font-weight: 600; }
    .flag { display: inline-block; padding: 2px 7px; border-radius: 6px; font-size: 11px; margin-right: 4px; background: rgba(245,158,11,0.15); color: var(--warn); }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>RiskGuard RWA & Ecosystem Terminal <span class="badge">Chain ID 4663 • LZ EID 30416</span></h1>
      <div id="meta" style="color:var(--muted);font-size:12px;margin-top:4px;">Loading live mainnet state...</div>
    </div>
    <button id="refreshBtn" onclick="loadData(true)">Refresh On-Chain Scan</button>
  </header>

  <div class="grid" id="kpis"></div>

  <h2>🌉 LayerZero V2 Corridors & Ecosystem Points (Lighter / Arcus)</h2>
  <div class="table-wrap"><table id="ecoTable"><thead><tr>
    <th>Protocol / Route</th><th>Status</th><th>Live On-Chain Metric</th><th>Low-Capital Strategy</th>
  </tr></thead><tbody></tbody></table></div>

  <h2>👛 Wallet Readiness & RWA Portfolio Inspector</h2>
  <div class="card" style="margin-bottom:18px;">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <input id="walletInput" placeholder="0x... Enter EVM wallet to inspect gas, RWA & L0/Lighter approvals" />
      <button onclick="checkWallet()">Inspect Wallet</button>
    </div>
    <div id="walletResult" style="margin-top:12px;font-size:13px;color:var(--muted);"></div>
  </div>

  <h2>⚡ x402 Pay-Per-Verification &amp; Guarded Execution Payload API (Router 0xE890...690F)</h2>
  <div class="card" style="margin-bottom:18px;">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <input id="x402Symbol" value="NVDA" style="width:110px;" placeholder="Ticker" />
      <input id="x402Size" value="50" type="number" style="width:110px;" placeholder="USD Size" />
      <button onclick="testX402(false)">Test HTTP 402 Challenge</button>
      <button onclick="testX402(true)" style="background:#38bdf8;color:#04101a;">Build Guarded Swap Calldata</button>
    </div>
    <pre id="x402Output" style="margin:12px 0 0;padding:12px;background:#090d14;border:1px solid var(--border);border-radius:8px;font-size:12px;overflow-x:auto;color:#93c5fd;display:none;"></pre>
  </div>

  <h2>🎯 Actionable QuoterV2 Signals (After Uniswap Fee & Price Impact)</h2>
  <div class="table-wrap"><table id="signalsTable"><thead><tr>
    <th>Signal</th><th>Ticker</th><th>Size</th><th>Oracle Token USD</th><th>Exec DEX USD</th><th>Net Spread</th><th>Est. Gross Edge</th><th>Pool</th>
  </tr></thead><tbody></tbody></table></div>

  <h2>📈 Live RWA Dislocation Telemetry &amp; Convergence Benchmark (Block-Verified)</h2>
  <div id="paperSummary" style="color:var(--muted);font-size:13px;margin:-4px 0 10px;">Loading paper ledger...</div>
  <div class="table-wrap"><table id="paperTable"><thead><tr>
    <th>Status / Direction</th><th>Ticker</th><th>Size</th><th>Execution Path (Entry → Exit)</th><th>Hold</th><th>Net PnL</th><th>Blocks</th>
  </tr></thead><tbody></tbody></table></div>

  <h2>📊 Liquid Stock Token Markets & ERC-8056 Multiplier Guard</h2>
  <div class="table-wrap"><table id="marketsTable"><thead><tr>
    <th>Ticker</th><th>DEX TVL</th><th>Best Pool</th><th>Oracle USD</th><th>DEX Mid USD</th><th>Mid Spread</th><th>uiMultiplier</th><th>On-Chain Cap</th><th>Risk Guard</th>
  </tr></thead><tbody></tbody></table></div>

  <script>
    const fmt = (n, d=2) => n == null ? '—' : Math.abs(n)>=1e6 ? '$'+(n/1e6).toFixed(2)+'M' : Math.abs(n)>=1e4 ? '$'+(n/1e3).toFixed(1)+'K' : '$'+Number(n).toFixed(d);
    async function checkWallet() {
      const addr = document.getElementById('walletInput').value.trim();
      const box = document.getElementById('walletResult');
      if (!addr) return;
      box.textContent = 'Scanning 95 Stock Tokens & approvals on 4663...';
      const res = await fetch('/api/wallet?address=' + encodeURIComponent(addr));
      const w = await res.json();
      if (w.error) { box.textContent = w.error; return; }
      box.innerHTML = '<b>Tx Count:</b> ' + w.txCountOnRobinhood +
        ' • <b>Gas ETH:</b> ' + w.nativeEth.toFixed(5) + ' (' + fmt(w.nativeEthUsd) + ', ~' + w.estimatedSwapsGasRunway + ' swaps)' +
        ' • <b>USDG:</b> ' + fmt(w.usdgBalance) + ' • <b>Total:</b> ' + fmt(w.totalPortfolioUsd) +
        '<br/><b>Approvals:</b> Uniswap=' + (w.approvals.usdgToSwapRouter?'✅':'➖') +
        ' | LayerZero OFT=' + (w.approvals.usdgToLzOft?'✅':'➖') +
        ' | Lighter=' + (w.approvals.usdgToLighter?'✅':'➖') +
        '<br/><b>Next Steps:</b> ' + w.recommendedNextSteps.join(' | ');
    }
    async function testX402(preview) {
      const sym = encodeURIComponent((document.getElementById('x402Symbol').value || 'NVDA').trim().toUpperCase());
      const size = encodeURIComponent(document.getElementById('x402Size').value || '50');
      const out = document.getElementById('x402Output');
      out.style.display = 'block';
      out.textContent = 'Querying /api/x402/execute-payload...';
      const res = await fetch('/api/x402/execute-payload?symbol=' + sym + '&sizeUsd=' + size + (preview ? '&preview=1' : ''));
      const json = await res.json();
      out.textContent = 'HTTP ' + res.status + ' ' + res.statusText + '\\n' + JSON.stringify(json, null, 2);
    }
    async function loadData(force=false) {
      const btn = document.getElementById('refreshBtn');
      btn.disabled = true; btn.textContent = 'Scanning 4663...';
      try {
        const res = await fetch('/api/scan' + (force ? '?force=1' : ''));
        const data = await res.json();
        const r = data.report; const s = r.summary; const e = data.eco;
        document.getElementById('meta').textContent = 'Block #' + r.blockNumber + ' • Gas: ' + e.gasPriceGwei.toFixed(4) + ' gwei • WETH: ' + fmt(r.wethPriceUsd) + ' • Scanned ' + r.scannedAtIso;
        document.getElementById('kpis').innerHTML = [
          ['USDG Total Supply', fmt(e.usdgTotalSupplyUsd)],
          ['Lighter Vault TVL', fmt(e.lighterVaultUsdgUsd)],
          ['On-Chain RWA Cap', fmt(s.totalOnchainRwaMarketCapUsd)],
          ['Uniswap v3 RWA TVL', fmt(s.totalDexRwaTvlUsd)],
          ['Active DEX Markets', s.tokensWithActivePools + ' / ' + s.totalTokens],
          ['ERC-8056 Drift', s.tokensWithMultiplierDrift + ' tokens'],
        ].map(([l,v]) => '<div class="card"><div class="label">'+l+'</div><div class="val">'+v+'</div></div>').join('');

        const lzRows = e.layerZero.activeCorridors.map(c => '<tr><td><b>LayerZero USDG OFT → ' + c.chainName + '</b></td><td><span class="badge">EID ' + c.dstEid + '</span></td><td>$50 Bridge Fee: <b>$' + (c.quote50UsdgFeeUsd??0).toFixed(2) + '</b></td><td>Official omnichain USDG route from/to Robinhood EID 30416</td></tr>');
        const ptRows = e.pointsProtocols.map(p => '<tr><td><b>' + p.name + '</b></td><td><span class="flag">' + p.status + '</span></td><td>' + p.onchainMetric + '</td><td style="white-space:normal;max-width:420px;">' + p.lowBudgetPlay + '</td></tr>');
        document.querySelector('#ecoTable tbody').innerHTML = [...lzRows, ...ptRows].join('');

        const sigBody = document.querySelector('#signalsTable tbody');
        sigBody.innerHTML = data.signals.actionable.length === 0
          ? '<tr><td colspan="8" style="color:var(--muted)">No executable spreads >= 40 bps at current block.</td></tr>'
          : data.signals.actionable.slice(0, 15).map(x => '<tr>' +
              '<td><span class="flag">' + x.action + '</span></td>' +
              '<td><b>' + x.symbol + '</b></td>' +
              '<td>$' + x.tradeSizeUsd + '</td>' +
              '<td>' + fmt(x.oraclePriceUsd) + '</td>' +
              '<td>' + fmt(x.executableDexPriceUsd) + '</td>' +
              '<td class="' + (x.netSpreadBps < 0 ? 'pos' : 'neg') + '">' + (x.netSpreadBps>0?'+':'') + x.netSpreadBps + ' bps</td>' +
              '<td>$' + x.estimatedGrossEdgeUsd.toFixed(2) + '</td>' +
              '<td>' + x.symbol + '/' + x.poolQuote + ' (' + (x.poolFeeBps/100) + '%)</td></tr>'
            ).join('');

        const mktBody = document.querySelector('#marketsTable tbody');
        const led = data.ledger || { totalScans: 0, closedTradesCount: 0, openPositionsCount: 0, cumulativeRealizedPnlUsd: 0, closedPositions: [], openPositions: [] };
        document.getElementById('paperSummary').innerHTML =
          '<b>Total Scans:</b> ' + led.totalScans +
          ' • <b>Closed Trades:</b> ' + led.closedTradesCount +
          ' • <b>Open Positions:</b> ' + led.openPositionsCount +
          ' • <b>Cumulative Net PnL (after DEX fees &amp; gas):</b> <span class="pos">+$' + Number(led.cumulativeRealizedPnlUsd || 0).toFixed(2) + '</span>';
        const formatDir = (p) => p.side === 'LONG_DISCOUNT'
          ? '🟢 LONG (Bought Discount → Sold)'
          : '🟠 SHORT/Rebalance (Sold Premium → Bought Back)';
        const formatExec = (p) => {
          if (p.status === 'OPEN') {
            return (p.side === 'LONG_DISCOUNT' ? 'Bought ' : 'Sold ') + fmt(p.entryDexPriceUsd) + ' (Oracle ' + fmt(p.entryOraclePriceUsd) + ', ' + p.entrySpreadBps + ' bps)';
          }
          return p.side === 'LONG_DISCOUNT'
            ? 'Bought ' + fmt(p.entryDexPriceUsd) + ' → Sold ' + fmt(p.exitDexPriceUsd)
            : 'Sold ' + fmt(p.entryDexPriceUsd) + ' → Bought Back ' + fmt(p.exitDexPriceUsd);
        };
        const paperRows = [...(led.openPositions || []).slice(0, 6), ...(led.closedPositions || []).slice(0, 14)];
        const paperBody = document.querySelector('#paperTable tbody');
        paperBody.innerHTML = paperRows.length === 0
          ? '<tr><td colspan="7" style="color:var(--muted)">No paper positions recorded yet.</td></tr>'
          : paperRows.map(p => '<tr>' +
              '<td><span class="flag" style="' + (p.status === 'OPEN' ? '' : 'background:rgba(0,220,130,0.14);color:var(--accent);') + '">' + p.status + '</span> ' + formatDir(p) + '</td>' +
              '<td><b>' + p.symbol + '</b></td>' +
              '<td>$' + p.sizeUsd + '</td>' +
              '<td>' + formatExec(p) + '</td>' +
              '<td>' + (p.status === 'OPEN' ? 'Active' : (p.holdingMinutes ?? 0) + ' min') + '</td>' +
              '<td class="' + ((p.realizedNetPnlUsd || 0) >= 0 ? 'pos' : 'neg') + '">' + (p.status === 'OPEN' ? '—' : '+$' + Number(p.realizedNetPnlUsd || 0).toFixed(2)) + '</td>' +
              '<td>#' + p.openBlock + (p.closeBlock ? ' → #' + p.closeBlock : '') + '</td>' +
            '</tr>').join('');
        const rows = r.tokens.filter(t => t.totalDexTvlUsd > 0 || (t.marketCapUsd||0) > 0).sort((a,b) => b.totalDexTvlUsd - a.totalDexTvlUsd).slice(0, 40);
        mktBody.innerHTML = rows.map(t => '<tr>' +
          '<td><b>' + t.symbol + '</b> <span style="color:var(--muted);font-size:11px">' + t.name.replace(' • Robinhood Token','') + '</span></td>' +
          '<td>' + fmt(t.totalDexTvlUsd) + '</td>' +
          '<td>' + (t.bestPool ? t.symbol+'/'+t.bestPool.quoteSymbol+' ('+(t.bestPool.fee/10000)+'%)' : '—') + '</td>' +
          '<td>' + fmt(t.oracleTokenPriceUsd) + '</td>' +
          '<td>' + fmt(t.bestPool?.dexMidPriceUsd) + '</td>' +
          '<td class="' + ((t.midSpreadVsOracleBps||0)<0?'pos':'neg') + '">' + (t.midSpreadVsOracleBps!=null ? (t.midSpreadVsOracleBps>0?'+':'')+t.midSpreadVsOracleBps+' bps' : '—') + '</td>' +
          '<td>' + t.uiMultiplier.toFixed(6) + 'x</td>' +
          '<td>' + fmt(t.marketCapUsd) + '</td>' +
          '<td>' + (t.riskFlags.length ? t.riskFlags.map(f=>'<span class="flag">'+f+'</span>').join('') : '<span style="color:var(--accent)">OK</span>') + '</td>' +
        '</tr>').join('');
      } finally {
        btn.disabled = false; btn.textContent = 'Refresh On-Chain Scan';
      }
    }
    loadData(false);
  </script>
  <footer style="margin-top:28px;padding:14px 16px;border-top:1px solid var(--border);color:var(--muted);font-size:12px;line-height:1.5;">
    <b>Compliance &amp; Non-Custodial Scope:</b> RiskGuard RWA provides stateless on-chain oracle safety verification, ERC-8056 multiplier guards, and telemetry only (no custody of funds, no financial or investment advice). Canonical Stock Tokens (issued by Robinhood Assets (Jersey) Ltd) are tokenized debt securities restricted for US, UK, Canadian, and Swiss persons.
  </footer>
</body>
</html>`

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
    if (url.pathname === '/api/scan') {
      const force = url.searchParams.get('force') === '1'
      const { report, eco } = await getScanCached(force)
      const signals = evaluateActionableSignals(report, 40)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ report, eco, signals, playbook: getMicroCapitalPlaybook(), ledger: loadPaperLedger() }))
      return
    }
    if (url.pathname === '/api/wallet') {
      const address = url.searchParams.get('address') ?? ''
      const w = await inspectWalletReadiness(address, cachedReport?.wethPriceUsd)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(w))
      return
    }
    if (url.pathname === '/api/x402/execute-payload') {
      const symbol = (url.searchParams.get('symbol') ?? 'NVDA').trim().toUpperCase()
      const sizeUsd = Number(url.searchParams.get('sizeUsd') ?? '50')
      const preview = url.searchParams.get('preview') === '1'
      const paymentTxHeader = req.headers['x-payment-tx']
      const paymentTx =
        (Array.isArray(paymentTxHeader) ? paymentTxHeader[0] : paymentTxHeader) ??
        url.searchParams.get('paymentTx') ??
        ''

      if (!preview) {
        if (!paymentTx) {
          res.writeHead(402, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Payment-Required': 'x402/1.0',
          })
          res.end(JSON.stringify(buildX402Challenge(url.pathname + url.search), null, 2))
          return
        }
        const verified = await verifyX402PaymentOnChain(paymentTx)
        if (!verified.valid) {
          res.writeHead(402, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Payment-Required': 'x402/1.0',
          })
          res.end(
            JSON.stringify(
              {
                ...buildX402Challenge(url.pathname + url.search),
                verificationError: verified.reason,
              },
              null,
              2,
            ),
          )
          return
        }
      }

      const { report } = await getScanCached(false)
      const tok = report.tokens.find((t) => t.symbol.toUpperCase() === symbol)
      if (!tok) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: `Ticker ${symbol} not found in Robinhood Chain registry.` }))
        return
      }
      const payload = buildGuardedSwapPayload(tok, sizeUsd)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ mode: preview ? 'dashboard_preview' : 'x402_paid', payload }, null, 2))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML_PAGE)
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
})

server.listen(PORT, () => {
  console.log(`\n🚀 RiskGuard RWA Terminal live at: http://localhost:${PORT}\n`)
})
