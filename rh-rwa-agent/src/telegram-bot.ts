import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WORKSPACE_ROOT } from './config.js'
import { inspectWalletReadiness, scanEcosystemAndLayerZero } from './ecosystem.js'
import { loadDotEnv } from './env.js'
import {
  evaluateActionableSignals,
  loadPaperLedger,
  stepPaperPortfolio,
  type PaperPosition,
  type PaperSignal,
} from './paper-trader.js'
import { runFullRwaScan, type FullScanReport } from './scanner.js'

loadDotEnv()

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim()
const SCAN_INTERVAL_SEC = Math.max(20, Number(process.env.SCAN_INTERVAL_SEC ?? 60))
const DEFAULT_ALERT_BPS = Math.max(25, Number(process.env.ALERT_MIN_BPS ?? 60))

const STATE_PATH = resolve(WORKSPACE_ROOT, 'data', 'tg_bot_state.json')

interface SubscriberProfile {
  chatId: number
  username?: string
  alertsEnabled: boolean
  minBps: number
  joinedAt: string
}

interface BotState {
  adminChatId: number | null
  subscribers: Record<string, SubscriberProfile>
}

function loadBotState(): BotState {
  const envAdmin = process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : null
  if (existsSync(STATE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as Partial<BotState>
      return {
        adminChatId: envAdmin ?? parsed.adminChatId ?? null,
        subscribers: parsed.subscribers ?? {},
      }
    } catch {
      // reset if malformed
    }
  }
  return { adminChatId: envAdmin, subscribers: {} }
}

function saveBotState(state: BotState): void {
  mkdirSync(resolve(WORKSPACE_ROOT, 'data'), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
}

const botState = loadBotState()
const userRateLimit = new Map<number, number>()
const alertCooldowns = new Map<string, { sentAtMs: number; lastBps: number }>()
let latestScan: FullScanReport | null = null

function ensureSubscriber(chatId: number, username?: string): SubscriberProfile {
  const key = String(chatId)
  let sub = botState.subscribers[key]
  if (!sub) {
    sub = {
      chatId,
      username,
      alertsEnabled: true,
      minBps: DEFAULT_ALERT_BPS,
      joinedAt: new Date().toISOString(),
    }
    botState.subscribers[key] = sub
    if (botState.adminChatId === null) {
      botState.adminChatId = chatId
      console.log(`👑 First user bound as Admin: chat_id=${chatId}`)
    }
    saveBotState(botState)
  } else if (username && sub.username !== username) {
    sub.username = username
    saveBotState(botState)
  }
  return sub
}

async function tgApi<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { ok: boolean; result: T; description?: string }
  if (!json.ok) {
    throw new Error(`Telegram API ${method} failed: ${json.description ?? res.statusText}`)
  }
  return json.result
}

async function sendMessage(chatId: number, text: string, withMenu = false): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }
  if (withMenu) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          { text: '⚡ Скан сети', callback_data: 'cmd_scan' },
          { text: '🎯 Сигналы', callback_data: 'cmd_signals' },
        ],
        [
          { text: '📈 Paper-Стата', callback_data: 'cmd_stats' },
          { text: '🛡️ Дрейф ERC-8056', callback_data: 'cmd_drift' },
        ],
        [
          { text: '🌐 L0 & Поинты', callback_data: 'cmd_lz' },
          { text: '🔔 Вкл/Выкл пуши', callback_data: 'cmd_toggle_alerts' },
        ],
      ],
    }
  }
  try {
    await tgApi('sendMessage', payload)
  } catch (err) {
    const msg = String(err)
    if (msg.includes('blocked') || msg.includes('chat not found')) {
      const sub = botState.subscribers[String(chatId)]
      if (sub) {
        sub.alertsEnabled = false
        saveBotState(botState)
      }
    } else {
      console.error(`Send failed to ${chatId}:`, msg)
    }
  }
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 10_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function formatSummaryMessage(r: FullScanReport): string {
  const s = r.summary
  const top5 = [...r.tokens]
    .filter((t) => t.totalDexTvlUsd > 0)
    .sort((a, b) => b.totalDexTvlUsd - a.totalDexTvlUsd)
    .slice(0, 6)
    .map((t) => {
      const sp =
        t.midSpreadVsOracleBps !== null
          ? `${t.midSpreadVsOracleBps > 0 ? '+' : ''}${t.midSpreadVsOracleBps} bps`
          : 'no feed'
      return `• <b>${t.symbol}</b>: TVL ${fmtUsd(t.totalDexTvlUsd)} | DEX ${fmtUsd(t.bestPool?.dexMidPriceUsd)} vs Orcl ${fmtUsd(t.oracleTokenPriceUsd)} (${sp})`
    })
    .join('\n')

  return [
    `⚡ <b>RiskGuard RWA — Robinhood Chain (4663)</b>`,
    `Блок: <code>#${r.blockNumber}</code> | WETH: <b>${fmtUsd(r.wethPriceUsd)}</b>`,
    ``,
    `• Капа RWA ончейн: <b>${fmtUsd(s.totalOnchainRwaMarketCapUsd)}</b>`,
    `• TVL пулов Uniswap v3: <b>${fmtUsd(s.totalDexRwaTvlUsd)}</b> (${s.tokensWithActivePools} пулов)`,
    `• Токенов / Фидов: <b>${s.totalTokens} / ${s.pricedByChainlink}</b>`,
    `• Дрейф uiMultiplier: <b>${s.tokensWithMultiplierDrift}</b> | Сплиты в очереди: <b>${s.scheduledCorporateActions}</b>`,
    ``,
    `<b>Топ пулов по ликвидности:</b>`,
    top5,
  ].join('\n')
}

function formatSignalsMessage(r: FullScanReport, userMinBps: number): string {
  const { actionable, blockedByRiskGuard } = evaluateActionableSignals(r, 35)
  const lines = [
    `🎯 <b>Исполнимые сигналы QuoterV2 (ваш порог пуша: ${userMinBps} bps)</b>`,
    `Блок: <code>#${r.blockNumber}</code>`,
    ``,
  ]
  if (actionable.length === 0) {
    lines.push(`Сейчас чистых спредов >= 35 bps после комиссии пула нет — рынок сбалансирован.`)
  } else {
    for (const sig of actionable.slice(0, 8)) {
      lines.push(
        `• <b>${sig.symbol}</b> [$${sig.tradeSizeUsd}] <code>${sig.action}</code>\n  Oracle: ${fmtUsd(sig.oraclePriceUsd)} | Exec DEX: ${fmtUsd(sig.executableDexPriceUsd)} | <b>${sig.netSpreadBps > 0 ? '+' : ''}${sig.netSpreadBps} bps</b> (~$${sig.estimatedGrossEdgeUsd}) | TVL ${fmtUsd(sig.poolTvlUsd)}`,
      )
    }
  }
  if (blockedByRiskGuard.length > 0) {
    lines.push(``, `🛡️ <b>Заблокировано RiskGuard:</b>`)
    for (const b of blockedByRiskGuard.slice(0, 5)) {
      lines.push(`• <b>${b.symbol}</b>: ${b.reason}`)
    }
  }
  return lines.join('\n')
}

function formatClosedExecution(c: PaperPosition, withTag: boolean): string {
  const isLong = c.side === 'LONG_DISCOUNT'
  const prefix = isLong
    ? withTag
      ? '🟢 LONG [Дисконт]: '
      : '🟢 LONG: '
    : withTag
      ? '🟠 SHORT/Rebalance [Премия]: '
      : '🟠 SHORT/Rebalance: '
  const verbs = isLong
    ? `куплено ${fmtUsd(c.entryDexPriceUsd)} → продано ${fmtUsd(c.exitDexPriceUsd)}`
    : `продано ${fmtUsd(c.entryDexPriceUsd)} → откуплено ${fmtUsd(c.exitDexPriceUsd)}`
  return `${prefix}${verbs}`
}

function formatStatsMessage(): string {
  const ledger = loadPaperLedger()
  const lines = [
    `📈 <b>RiskGuard Paper-Trading & Трек-рекорд</b>`,
    `• Всего сканов сети: <b>${ledger.totalScans}</b>`,
    `• Зафиксировано сигналов: <b>${ledger.signalsLogged}</b>`,
    `• Открытых виртуальных позиций ($50): <b>${ledger.openPositions.length}</b>`,
    `• Закрытых по схождению к оракулу: <b>${ledger.closedPositions.length}</b>`,
    `• Чистый реализованный PnL (после комиссий и газа): <b>$${ledger.cumulativeRealizedPnlUsd.toFixed(2)}</b>`,
  ]
  if (ledger.openPositions.length > 0) {
    lines.push(``, `<b>Открытые Paper-позиции:</b>`)
    for (const p of ledger.openPositions.slice(0, 6)) {
      const sideLabel =
        p.side === 'LONG_DISCOUNT'
          ? '🟢 LONG [Куплено на дисконте]'
          : '🟠 SHORT/Rebalance [Продано на премии]'
      lines.push(
        `• <b>${p.symbol}</b> ${sideLabel} по ${fmtUsd(p.entryDexPriceUsd)} при оракуле ${fmtUsd(p.entryOraclePriceUsd)} (${p.entrySpreadBps} bps, блок #${p.openBlock})`,
      )
    }
  }
  if (ledger.closedPositions.length > 0) {
    lines.push(``, `<b>Последние закрытые сделки:</b>`)
    for (const c of ledger.closedPositions.slice(0, 8)) {
      lines.push(
        `• ✅ <b>${c.symbol}</b> PnL: <b>+$${(c.realizedNetPnlUsd ?? 0).toFixed(2)}</b> за ${c.holdingMinutes} мин (${formatClosedExecution(c, false)}, #${c.openBlock} → #${c.closeBlock})`,
      )
    }
  }
  return lines.join('\n')
}

function formatDriftMessage(r: FullScanReport): string {
  const drifted = [...r.tokens]
    .filter((t) => Math.abs(t.doubleCountTrapBps) >= 5)
    .sort((a, b) => Math.abs(b.doubleCountTrapBps) - Math.abs(a.doubleCountTrapBps))
    .slice(0, 10)

  const lines = [
    `🛡️ <b>ERC-8056 Multiplier Drift (Сплиты и дивиденды)</b>`,
    `Токенов с uiMultiplier != 1.0x: <b>${r.summary.tokensWithMultiplierDrift}</b>`,
    ``,
  ]
  for (const d of drifted) {
    lines.push(
      `• <b>${d.symbol}</b>: <code>${d.uiMultiplier.toFixed(6)}x</code> (ошибка при двойном учёте оракула: <b>+${(d.doubleCountTrapBps / 100).toFixed(2)}%</b>)`,
    )
  }
  return lines.join('\n')
}

function formatTokenCard(r: FullScanReport, rawSym: string): string {
  const sym = rawSym.trim().toUpperCase()
  const t = r.tokens.find((x) => x.symbol.toUpperCase() === sym)
  if (!t) return `Тикер <b>${sym}</b> не найден среди 95 Stock Tokens.`

  const qLines = t.executableQuotes.map(
    (q) =>
      `  • $${q.tradeSizeUsd}: Buy ${fmtUsd(q.buyPriceUsd)} (${q.buySpreadVsOracleBps ?? '—'} bps) | Sell ${fmtUsd(q.sellPriceUsd)} (${q.sellSpreadVsOracleBps ?? '—'} bps)`,
  )
  return [
    `🔎 <b>${t.symbol}</b> — ${t.name}`,
    `Адрес: <code>${t.address}</code>`,
    `• Chainlink Token USD: <b>${fmtUsd(t.oracleTokenPriceUsd)}</b> (возраст фида: ${t.oracleAgeHours !== null ? t.oracleAgeHours.toFixed(2) + 'ч' : 'нет фида'})`,
    `• Цена базовой акции (1 share): <b>${fmtUsd(t.underlyingSharePriceUsd)}</b>`,
    `• DEX Mid USD: <b>${fmtUsd(t.bestPool?.dexMidPriceUsd)}</b> (${t.midSpreadVsOracleBps !== null ? (t.midSpreadVsOracleBps > 0 ? '+' : '') + t.midSpreadVsOracleBps + ' bps' : '—'})`,
    `• TVL пулов DEX: <b>${fmtUsd(t.totalDexTvlUsd)}</b> | Ончейн капа: <b>${fmtUsd(t.marketCapUsd)}</b>`,
    `• ERC-8056 uiMultiplier: <code>${t.uiMultiplier.toFixed(6)}x</code>`,
    `• RiskGuard: <b>${t.riskFlags.join(', ') || 'OK'}</b>`,
    ...(qLines.length ? [``, `<b>QuoterV2 исполнение:</b>`, ...qLines] : []),
  ].join('\n')
}

async function handleCommand(chatId: number, text: string, username?: string): Promise<void> {
  const now = Date.now()
  const prevReq = userRateLimit.get(chatId) ?? 0
  if (now - prevReq < 1200) return
  userRateLimit.set(chatId, now)

  const sub = ensureSubscriber(chatId, username)
  const [cmdRaw, arg] = text.trim().split(/\s+/, 2)
  const cmd = (cmdRaw ?? '').toLowerCase().split('@')[0]

  if (cmd === '/start' || cmd === '/help') {
    sub.alertsEnabled = true
    saveBotState(botState)
    await sendMessage(
      chatId,
      [
        `🛡️ <b>Добро пожаловать в RiskGuard RWA!</b>`,
        `Ончейн-сканер спредов Stock Tokens, пулов Uniswap v3 и рисков ERC-8056 в сети <b>Robinhood Chain (4663)</b>.`,
        ``,
        `🔔 Авто-пуши: <b>${sub.alertsEnabled ? 'ВКЛЮЧЕНЫ' : 'ВЫКЛЮЧЕНЫ'}</b> (ваш порог: <b>${sub.minBps} bps</b>)`,
        ``,
        `<b>Команды:</b>`,
        `• /scan — живая сводка сети 4663`,
        `• /signals — исполнимые спреды QuoterV2`,
        `• /lz — LayerZero V2 коридоры, Lighter ($92M) и Arcus`,
        `• /wallet 0x... — аудит кошелька (газ, RWA, апрувы)`,
        `• /token NVDA — карточка любого из 95 тикеров`,
        `• /drift — дрейф мультипликаторов ERC-8056`,
        `• /stats — открытый трек-рекорд Paper-Trading`,
        `• /threshold 75 — задать свой порог пуш-уведомлений (в bps)`,
        `• /mute или /unmute — выкл/вкл авто-пуши`,
      ].join('\n'),
      true,
    )
    return
  }

  if (cmd === '/mute' || cmd === '/stop') {
    sub.alertsEnabled = false
    saveBotState(botState)
    await sendMessage(chatId, `🔕 Автоматические пуш-уведомления отключены. Включить обратно: /unmute`)
    return
  }

  if (cmd === '/unmute') {
    sub.alertsEnabled = true
    saveBotState(botState)
    await sendMessage(chatId, `🔔 Автоматические пуш-уведомления включены (порог: <b>${sub.minBps} bps</b>).`)
    return
  }

  if (cmd === '/toggle_alerts') {
    sub.alertsEnabled = !sub.alertsEnabled
    saveBotState(botState)
    await sendMessage(
      chatId,
      sub.alertsEnabled
        ? `🔔 Авто-пуши <b>ВКЛЮЧЕНЫ</b> (порог: <b>${sub.minBps} bps</b>).`
        : `🔕 Авто-пуши <b>ВЫКЛЮЧЕНЫ</b>.`,
      true,
    )
    return
  }

  if (cmd === '/threshold' && arg) {
    const val = Number(arg)
    if (Number.isFinite(val) && val >= 20 && val <= 1000) {
      sub.minBps = Math.round(val)
      saveBotState(botState)
      await sendMessage(
        chatId,
        `✅ Ваш персональный порог пуш-алертов: <b>${sub.minBps} bps</b> (${(sub.minBps / 100).toFixed(2)}%).`,
      )
    } else {
      await sendMessage(chatId, `Укажите число от 20 до 1000, например: <code>/threshold 75</code>`)
    }
    return
  }

  if (cmd === '/admin' && chatId === botState.adminChatId) {
    const subs = Object.values(botState.subscribers)
    const active = subs.filter((s) => s.alertsEnabled).length
    await sendMessage(
      chatId,
      `👑 <b>Admin Panel</b>\n• Всего пользователей бота: <b>${subs.length}</b>\n• С активной подпиской на пуши: <b>${active}</b>`,
    )
    return
  }

  if (cmd === '/lz' || cmd === '/ecosystem') {
    const eco = await scanEcosystemAndLayerZero(latestScan?.wethPriceUsd)
    const corridors = eco.layerZero.activeCorridors
      .map(
        (c) =>
          `• <b>${c.chainName}</b> (EID <code>${c.dstEid}</code>) — комиссия моста $50 USDG: <b>${c.quote50UsdgFeeUsd !== null ? '$' + c.quote50UsdgFeeUsd.toFixed(2) : '—'}</b>`,
      )
      .join('\n')
    await sendMessage(
      chatId,
      [
        `🌐 <b>Экосистема Robinhood Chain & LayerZero V2</b>`,
        `Газ сети: <code>${eco.gasPriceGwei.toFixed(4)} gwei</code> (~$0.006 за своп)`,
        `• Саплай USDG: <b>${fmtUsd(eco.usdgTotalSupplyUsd)}</b> | WETH: <b>${fmtUsd(eco.wethTotalTvlUsd)}</b>`,
        `• Lighter Vault TVL: <b>${fmtUsd(eco.lighterVaultUsdgUsd)} USDG</b>`,
        ``,
        `🌉 <b>Живые коридоры USDG OFT (LayerZero EID ${eco.layerZero.localEid}):</b>`,
        corridors || '• Нет активных коридоров',
        ``,
        `🎯 <b>Фарм поинтов (Вариант Б):</b>`,
        `• <b>Lighter ($LIT):</b> лимитные мейкер-ордера / хедж RWA ($92M+ TVL)`,
        `• <b>Arcus (Season 1):</b> 0% fee RFQ-свопы Stock Tokens + токенизированные перпы`,
      ].join('\n'),
      true,
    )
    return
  }

  if (cmd === '/wallet') {
    if (!arg) {
      await sendMessage(chatId, `Укажите EVM-адрес: <code>/wallet 0xВашКошелёк</code>`)
      return
    }
    try {
      const w = await inspectWalletReadiness(arg, latestScan?.wethPriceUsd)
      const holdingsTxt =
        w.stockHoldings.length > 0
          ? w.stockHoldings
              .slice(0, 8)
              .map((h) => `  • <b>${h.symbol}</b>: ${h.tokens} (${h.shareEquivalent} акций) = ${fmtUsd(h.valueUsd)}`)
              .join('\n')
          : '  • Нет Stock Tokens'
      await sendMessage(
        chatId,
        [
          `👛 <b>Аудит кошелька (4663)</b>`,
          `<code>${w.address}</code>`,
          `• Транзакций в сети: <b>${w.txCountOnRobinhood}</b>`,
          `• Газ ETH: <b>${w.nativeEth.toFixed(5)} ETH</b> (${fmtUsd(w.nativeEthUsd)}, запас ~${w.estimatedSwapsGasRunway} свопов)`,
          `• USDG: <b>${fmtUsd(w.usdgBalance)}</b> | WETH: <b>${fmtUsd(w.wethBalanceUsd)}</b>`,
          `• Всего портфель: <b>${fmtUsd(w.totalPortfolioUsd)}</b>`,
          `• Апрувы: Uniswap ${w.approvals.usdgToSwapRouter ? '✅' : '➖'} | L0 OFT ${w.approvals.usdgToLzOft ? '✅' : '➖'} | Lighter ${w.approvals.usdgToLighter ? '✅' : '➖'}`,
          ``,
          `<b>Stock Tokens:</b>`,
          holdingsTxt,
          ...(w.recommendedNextSteps.length
            ? [``, `<b>Рекомендации:</b>`, ...w.recommendedNextSteps.map((s) => `• ${s}`)]
            : []),
        ].join('\n'),
      )
    } catch (e) {
      await sendMessage(chatId, `Ошибка проверки адреса: ${String(e)}`)
    }
    return
  }

  // Use memory-cached scan so even 500 concurrent users cause ZERO extra RPC load
  const scan = latestScan ?? (await runFullRwaScan())
  latestScan = scan

  if (cmd === '/scan') {
    await sendMessage(chatId, formatSummaryMessage(scan), true)
  } else if (cmd === '/signals') {
    await sendMessage(chatId, formatSignalsMessage(scan, sub.minBps), true)
  } else if (cmd === '/stats') {
    await sendMessage(chatId, formatStatsMessage(), true)
  } else if (cmd === '/drift') {
    await sendMessage(chatId, formatDriftMessage(scan), true)
  } else if (cmd === '/token') {
    await sendMessage(chatId, formatTokenCard(scan, arg ?? 'NVDA'))
  } else {
    await sendMessage(chatId, `Неизвестная команда. Нажмите /help`, true)
  }
}

async function broadcastWatcherEvents(
  report: FullScanReport,
  signals: PaperSignal[],
  newlyOpened: PaperPosition[],
  newlyClosed: PaperPosition[],
): Promise<void> {
  const activeSubs = Object.values(botState.subscribers).filter((s) => s.alertsEnabled)
  if (activeSubs.length === 0) return

  const nowMs = Date.now()
  const cooldownMs = 30 * 60_000

  const candidates = signals.filter((s) => Math.abs(s.netSpreadBps) >= 25 && s.tradeSizeUsd === 50)
  const freshSignals: PaperSignal[] = []

  for (const sig of candidates) {
    const prev = alertCooldowns.get(sig.symbol)
    const jumpedMore = prev && Math.abs(sig.netSpreadBps) >= Math.abs(prev.lastBps) + 25
    if (!prev || nowMs - prev.sentAtMs > cooldownMs || jumpedMore) {
      alertCooldowns.set(sig.symbol, { sentAtMs: nowMs, lastBps: sig.netSpreadBps })
      freshSignals.push(sig)
    }
  }

  for (const sub of activeSubs) {
    const matching = freshSignals.filter((s) => Math.abs(s.netSpreadBps) >= sub.minBps)
    if (matching.length > 0) {
      const lines = [
        `🚨 <b>RiskGuard RWA Alert (Блок #${report.blockNumber})</b>`,
        ...matching.map(
          (s) =>
            `• <b>${s.symbol}</b> [$${s.tradeSizeUsd}] <code>${s.action}</code>\n  Oracle: ${fmtUsd(s.oraclePriceUsd)} | Exec DEX: ${fmtUsd(s.executableDexPriceUsd)} | <b>${s.netSpreadBps > 0 ? '+' : ''}${s.netSpreadBps} bps</b> | TVL ${fmtUsd(s.poolTvlUsd)}`,
        ),
      ]
      if (newlyOpened.length > 0) {
        const openedTxt = newlyOpened
          .map((p) => `${p.symbol} (${p.side === 'LONG_DISCOUNT' ? 'LONG дисконт' : 'SHORT премия'})`)
          .join(', ')
        lines.push(``, `📝 Открыто в Paper-портфеле: ${openedTxt}`)
      }
      await sendMessage(sub.chatId, lines.join('\n'))
    }

    if (newlyClosed.length > 0) {
      const lines = [
        `💰 <b>RiskGuard Paper-Trade закрыт в плюс!</b>`,
        ...newlyClosed.map(
          (c) =>
            `• <b>${c.symbol}</b>: чистый PnL <b>+$${(c.realizedNetPnlUsd ?? 0).toFixed(2)}</b> на $${c.sizeUsd} за ${c.holdingMinutes} мин\n  ${formatClosedExecution(c, true)}`,
        ),
      ]
      await sendMessage(sub.chatId, lines.join('\n'))
    }
  }
}

async function backgroundScanLoop(): Promise<void> {
  while (true) {
    try {
      const report = await runFullRwaScan()
      latestScan = report
      writeFileSync(
        resolve(WORKSPACE_ROOT, 'data', 'latest_rwa_scan.json'),
        JSON.stringify(report, null, 2),
        'utf-8',
      )
      const { actionable } = evaluateActionableSignals(report, 35)
      const { newlyOpened, newlyClosed } = stepPaperPortfolio(report, actionable, DEFAULT_ALERT_BPS)
      await broadcastWatcherEvents(report, actionable, newlyOpened, newlyClosed)
      console.log(
        `[${new Date().toLocaleTimeString()}] Scan #${report.blockNumber} OK | signals=${actionable.length} | subs=${Object.keys(botState.subscribers).length}`,
      )
    } catch (err) {
      console.error('Background scan error:', err)
    }
    await new Promise((r) => setTimeout(r, SCAN_INTERVAL_SEC * 1000))
  }
}

async function pollUpdatesLoop(): Promise<void> {
  let offset = 0
  while (true) {
    try {
      const updates = await tgApi<
        {
          update_id: number
          message?: { chat: { id: number; username?: string }; text?: string }
          callback_query?: {
            id: string
            message?: { chat: { id: number; username?: string } }
            data?: string
          }
        }[]
      >('getUpdates', { offset, timeout: 25 })

      for (const u of updates) {
        offset = u.update_id + 1
        if (u.message?.text) {
          await handleCommand(u.message.chat.id, u.message.text, u.message.chat.username)
        } else if (u.callback_query?.data && u.callback_query.message) {
          const chat = u.callback_query.message.chat
          await tgApi('answerCallbackQuery', { callback_query_id: u.callback_query.id })
          const map: Record<string, string> = {
            cmd_scan: '/scan',
            cmd_signals: '/signals',
            cmd_stats: '/stats',
            cmd_drift: '/drift',
            cmd_lz: '/lz',
            cmd_toggle_alerts: '/toggle_alerts',
          }
          if (map[u.callback_query.data]) {
            await handleCommand(chat.id, map[u.callback_query.data]!, chat.username)
          }
        }
      }
    } catch (err) {
      console.error('Telegram polling error:', err)
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

async function main() {
  if (!BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN пуст! Впишите токен в rh-rwa-agent/.env и запустите `npm run bot`.')
    process.exit(1)
  }
  const me = await tgApi<{ username: string }>('getMe', {})
  console.log(`\n🤖 Публичный Telegram-бот @${me.username} запущен!`)
  console.log(`👥 Подписчиков в базе: ${Object.keys(botState.subscribers).length}`)

  await Promise.all([backgroundScanLoop(), pollUpdatesLoop()])
}

main().catch((err) => {
  console.error('Fatal bot error:', err)
  process.exit(1)
})
