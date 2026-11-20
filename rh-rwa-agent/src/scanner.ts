import { createPublicClient, formatUnits, http, zeroAddress, type Address } from 'viem'
import {
  ABIS,
  ADDRESSES,
  FEE_TIERS,
  loadStockRegistry,
  robinhoodMainnet,
  STOCK_DECIMALS,
  USDG_DECIMALS,
  WETH_DECIMALS,
} from './config.js'

export interface PoolSnapshot {
  poolAddress: Address
  quoteSymbol: 'USDG' | 'WETH'
  quoteToken: Address
  fee: number
  liquidity: string
  dexMidPriceUsd: number
  stockReserve: number
  quoteReserve: number
  tvlUsd: number
}

export interface ExecutableQuote {
  tradeSizeUsd: number
  buyPriceUsd: number | null
  sellPriceUsd: number | null
  buySpreadVsOracleBps: number | null
  sellSpreadVsOracleBps: number | null
}

export interface TokenScanResult {
  symbol: string
  name: string
  address: Address
  totalSupplyTokens: number
  totalSupplySharesUI: number
  marketCapUsd: number | null
  uiMultiplier: number
  newUiMultiplier: number
  effectiveAt: number
  hasScheduledCorporateAction: boolean
  hasHistoricalMultiplierDrift: boolean
  doubleCountTrapBps: number
  paused: boolean
  oraclePaused: boolean
  feedAddress: Address | null
  oracleTokenPriceUsd: number | null
  underlyingSharePriceUsd: number | null
  oracleAgeHours: number | null
  oracleWeekendMode: boolean
  bestPool: PoolSnapshot | null
  allPools: PoolSnapshot[]
  totalDexTvlUsd: number
  midSpreadVsOracleBps: number | null
  executableQuotes: ExecutableQuote[]
  riskFlags: string[]
}

export interface FullScanReport {
  scannedAtIso: string
  blockNumber: number
  wethPriceUsd: number
  summary: {
    totalTokens: number
    pricedByChainlink: number
    tokensWithActivePools: number
    totalOnchainRwaMarketCapUsd: number
    totalDexRwaTvlUsd: number
    tokensWithMultiplierDrift: number
    scheduledCorporateActions: number
    riskAlertsCount: number
  }
  topOpportunities: TokenScanResult[]
  tokens: TokenScanResult[]
}

function computeV3SpotPrice(
  baseToken: Address,
  baseDecimals: number,
  quoteToken: Address,
  quoteDecimals: number,
  sqrtPriceX96: bigint,
): number {
  if (sqrtPriceX96 === 0n) return 0
  const baseIsToken0 = baseToken.toLowerCase() < quoteToken.toLowerCase()
  const dec0 = baseIsToken0 ? baseDecimals : quoteDecimals
  const dec1 = baseIsToken0 ? quoteDecimals : baseDecimals

  const ratioSqrt = Number(sqrtPriceX96) / 2 ** 96
  const price0In1 = ratioSqrt * ratioSqrt * 10 ** (dec0 - dec1)
  if (!Number.isFinite(price0In1) || price0In1 <= 0) return 0
  return baseIsToken0 ? price0In1 : 1 / price0In1
}

export async function runFullRwaScan(rpcUrl?: string): Promise<FullScanReport> {
  const client = createPublicClient({
    chain: robinhoodMainnet,
    transport: http(rpcUrl ?? robinhoodMainnet.rpcUrls.default.http[0], { timeout: 25_000 }),
  })

  const registry = loadStockRegistry()
  const tokens = registry.tokens
  const nowSec = Math.floor(Date.now() / 1000)

  const blockNumber = Number(await client.getBlockNumber())

  // 1. Discover WETH/USDG pools + all StockToken/(USDG|WETH) pools in one batched Multicall
  const wethPoolQueries = FEE_TIERS.map((fee) => ({
    address: ADDRESSES.uniswapV3Factory,
    abi: ABIS.v3Factory,
    functionName: 'getPool' as const,
    args: [ADDRESSES.weth, ADDRESSES.usdg, fee] as const,
  }))

  type PoolCandidateMeta = {
    tokenIdx: number
    quoteSymbol: 'USDG' | 'WETH'
    quoteToken: Address
    quoteDecimals: number
    fee: number
  }
  const poolMetas: PoolCandidateMeta[] = []
  const stockPoolQueries: {
    address: Address
    abi: typeof ABIS.v3Factory
    functionName: 'getPool'
    args: readonly [Address, Address, number]
  }[] = []

  tokens.forEach((t, idx) => {
    for (const fee of FEE_TIERS) {
      poolMetas.push({
        tokenIdx: idx,
        quoteSymbol: 'USDG',
        quoteToken: ADDRESSES.usdg,
        quoteDecimals: USDG_DECIMALS,
        fee,
      })
      stockPoolQueries.push({
        address: ADDRESSES.uniswapV3Factory,
        abi: ABIS.v3Factory,
        functionName: 'getPool',
        args: [t.address, ADDRESSES.usdg, fee],
      })

      poolMetas.push({
        tokenIdx: idx,
        quoteSymbol: 'WETH',
        quoteToken: ADDRESSES.weth,
        quoteDecimals: WETH_DECIMALS,
        fee,
      })
      stockPoolQueries.push({
        address: ADDRESSES.uniswapV3Factory,
        abi: ABIS.v3Factory,
        functionName: 'getPool',
        args: [t.address, ADDRESSES.weth, fee],
      })
    }
  })

  const [wethPoolsRes, stockPoolsRes] = await Promise.all([
    client.multicall({ contracts: wethPoolQueries, batchSize: 4096 }),
    client.multicall({ contracts: stockPoolQueries, batchSize: 4096 }),
  ])

  // 2. Price WETH in USDG from the deepest WETH/USDG pool
  const activeWethPools: { pool: Address; fee: number }[] = []
  wethPoolsRes.forEach((r, i) => {
    if (r.status === 'success' && r.result && r.result !== zeroAddress) {
      activeWethPools.push({ pool: r.result, fee: FEE_TIERS[i]! })
    }
  })

  let wethPriceUsd = 0
  if (activeWethPools.length > 0) {
    const wethStateCalls = activeWethPools.flatMap((p) => [
      { address: p.pool, abi: ABIS.v3Pool, functionName: 'slot0' as const },
      { address: ADDRESSES.usdg, abi: ABIS.erc20, functionName: 'balanceOf' as const, args: [p.pool] as const },
    ])
    const wethState = await client.multicall({ contracts: wethStateCalls })
    let bestUsdgDepth = -1
    activeWethPools.forEach((_, idx) => {
      const slot0Res = wethState[idx * 2]
      const balRes = wethState[idx * 2 + 1]
      if (slot0Res?.status === 'success' && balRes?.status === 'success') {
        const usdgDepth = Number(formatUnits(balRes.result as bigint, USDG_DECIMALS))
        const spot = computeV3SpotPrice(
          ADDRESSES.weth,
          WETH_DECIMALS,
          ADDRESSES.usdg,
          USDG_DECIMALS,
          (slot0Res.result as readonly [bigint, ...unknown[]])[0],
        )
        if (spot > 0 && usdgDepth > bestUsdgDepth) {
          bestUsdgDepth = usdgDepth
          wethPriceUsd = spot
        }
      }
    })
  }

  // 3. Batch read StockToken on-chain state + Chainlink feeds + discovered active V3 pools
  const discoveredPools: (PoolCandidateMeta & { poolAddress: Address })[] = []
  stockPoolsRes.forEach((r, i) => {
    if (r.status === 'success' && r.result && r.result !== zeroAddress) {
      discoveredPools.push({ ...poolMetas[i]!, poolAddress: r.result })
    }
  })

  const tokenStateCalls = tokens.flatMap((t) => [
    { address: t.address, abi: ABIS.stockToken, functionName: 'totalSupply' as const },
    { address: t.address, abi: ABIS.stockToken, functionName: 'uiMultiplier' as const },
    { address: t.address, abi: ABIS.stockToken, functionName: 'newUIMultiplier' as const },
    { address: t.address, abi: ABIS.stockToken, functionName: 'effectiveAt' as const },
    { address: t.address, abi: ABIS.stockToken, functionName: 'paused' as const },
    { address: t.address, abi: ABIS.stockToken, functionName: 'oraclePaused' as const },
  ])

  const pricedTokenIndices: number[] = []
  const feedCalls = tokens.flatMap((t, idx) => {
    if (!t.feed) return []
    pricedTokenIndices.push(idx)
    return [{ address: t.feed, abi: ABIS.aggregatorV3, functionName: 'latestRoundData' as const }]
  })

  const poolDetailCalls = discoveredPools.flatMap((p) => {
    const stockAddr = tokens[p.tokenIdx]!.address
    return [
      { address: p.poolAddress, abi: ABIS.v3Pool, functionName: 'liquidity' as const },
      { address: p.poolAddress, abi: ABIS.v3Pool, functionName: 'slot0' as const },
      { address: stockAddr, abi: ABIS.erc20, functionName: 'balanceOf' as const, args: [p.poolAddress] as const },
      { address: p.quoteToken, abi: ABIS.erc20, functionName: 'balanceOf' as const, args: [p.poolAddress] as const },
    ]
  })

  const [tokenStateRes, feedRes, poolDetailRes] = await Promise.all([
    client.multicall({ contracts: tokenStateCalls, batchSize: 4096 }),
    client.multicall({ contracts: feedCalls, batchSize: 4096 }),
    discoveredPools.length > 0
      ? client.multicall({ contracts: poolDetailCalls, batchSize: 4096 })
      : Promise.resolve([]),
  ])

  const feedMap = new Map<number, { answer: bigint; updatedAt: number }>()
  pricedTokenIndices.forEach((tokIdx, callIdx) => {
    const r = feedRes[callIdx]
    if (r?.status === 'success') {
      const [, answer, , updatedAt] = r.result as readonly [bigint, bigint, bigint, bigint, bigint]
      feedMap.set(tokIdx, { answer, updatedAt: Number(updatedAt) })
    }
  })

  const poolsByToken = new Map<number, PoolSnapshot[]>()
  discoveredPools.forEach((p, idx) => {
    const liqRes = poolDetailRes[idx * 4]
    const slot0Res = poolDetailRes[idx * 4 + 1]
    const stockBalRes = poolDetailRes[idx * 4 + 2]
    const quoteBalRes = poolDetailRes[idx * 4 + 3]
    if (
      liqRes?.status !== 'success' ||
      slot0Res?.status !== 'success' ||
      stockBalRes?.status !== 'success' ||
      quoteBalRes?.status !== 'success'
    ) {
      return
    }

    const liquidity = liqRes.result as bigint
    const slot0Tuple = slot0Res.result as readonly [bigint, number, ...unknown[]]
    const sqrtPriceX96 = slot0Tuple[0]
    const currentTick = Number(slot0Tuple[1])
    const stockReserve = Number(formatUnits(stockBalRes.result as bigint, STOCK_DECIMALS))
    const quoteReserve = Number(formatUnits(quoteBalRes.result as bigint, p.quoteDecimals))

    // Skip dead/uninitialized/boundary-pinned dust pools with zero active in-range liquidity
    if (liquidity === 0n || Math.abs(currentTick) >= 880_000) {
      return
    }

    const stockAddr = tokens[p.tokenIdx]!.address
    const priceInQuote = computeV3SpotPrice(
      stockAddr,
      STOCK_DECIMALS,
      p.quoteToken,
      p.quoteDecimals,
      sqrtPriceX96,
    )
    const quoteUsd = p.quoteSymbol === 'USDG' ? 1 : wethPriceUsd
    const dexMidPriceUsd = priceInQuote * quoteUsd
    const quoteSideUsd = quoteReserve * quoteUsd

    // Require non-dust quote reserve and sane equity price bounds
    if (!Number.isFinite(dexMidPriceUsd) || dexMidPriceUsd <= 0.0001 || dexMidPriceUsd > 250_000 || quoteSideUsd < 5) {
      return
    }

    const feedEntry = feedMap.get(p.tokenIdx)
    const feedUsd =
      feedEntry && feedEntry.answer > 0n
        ? Number(formatUnits(feedEntry.answer, tokens[p.tokenIdx]!.feedDecimals ?? 8))
        : null
    const valuationPrice = feedUsd ?? dexMidPriceUsd
    const tvlUsd = stockReserve * valuationPrice + quoteSideUsd

    const snap: PoolSnapshot = {
      poolAddress: p.poolAddress,
      quoteSymbol: p.quoteSymbol,
      quoteToken: p.quoteToken,
      fee: p.fee,
      liquidity: liquidity.toString(),
      dexMidPriceUsd,
      stockReserve,
      quoteReserve,
      tvlUsd,
    }
    const list = poolsByToken.get(p.tokenIdx) ?? []
    list.push(snap)
    poolsByToken.set(p.tokenIdx, list)
  })

  // 4. Assemble TokenScanResult & identify liquid pools for exact QuoterV2 simulation
  const results: TokenScanResult[] = tokens.map((t, idx) => {
    const base = idx * 6
    const rawSupply =
      tokenStateRes[base]?.status === 'success' ? (tokenStateRes[base]!.result as bigint) : 0n
    const rawMult =
      tokenStateRes[base + 1]?.status === 'success'
        ? (tokenStateRes[base + 1]!.result as bigint)
        : 10n ** 18n
    const rawNewMult =
      tokenStateRes[base + 2]?.status === 'success'
        ? (tokenStateRes[base + 2]!.result as bigint)
        : 10n ** 18n
    const effectiveAt =
      tokenStateRes[base + 3]?.status === 'success'
        ? Number(tokenStateRes[base + 3]!.result as bigint)
        : 0
    const paused =
      tokenStateRes[base + 4]?.status === 'success'
        ? Boolean(tokenStateRes[base + 4]!.result)
        : false
    const oraclePaused =
      tokenStateRes[base + 5]?.status === 'success'
        ? Boolean(tokenStateRes[base + 5]!.result)
        : false

    const totalSupplyTokens = Number(formatUnits(rawSupply, STOCK_DECIMALS))
    const uiMultiplier = Number(formatUnits(rawMult, 18))
    const newUiMultiplier = Number(formatUnits(rawNewMult, 18))
    const totalSupplySharesUI = totalSupplyTokens * uiMultiplier

    const hasScheduledCorporateAction = effectiveAt > nowSec && Math.abs(newUiMultiplier - uiMultiplier) > 1e-12
    const hasHistoricalMultiplierDrift = Math.abs(uiMultiplier - 1) > 1e-9
    const doubleCountTrapBps = Math.round((uiMultiplier - 1) * 10_000)

    const feedInfo = feedMap.get(idx)
    let oracleTokenPriceUsd: number | null = null
    let underlyingSharePriceUsd: number | null = null
    let oracleAgeHours: number | null = null
    let oracleWeekendMode = false

    if (feedInfo && feedInfo.answer > 0n) {
      oracleTokenPriceUsd = Number(formatUnits(feedInfo.answer, t.feedDecimals ?? 8))
      underlyingSharePriceUsd = uiMultiplier > 0 ? oracleTokenPriceUsd / uiMultiplier : null
      oracleAgeHours = Math.max(0, (nowSec - feedInfo.updatedAt) / 3600)
      oracleWeekendMode = oracleAgeHours > 4 && oracleAgeHours <= 72
    }

    const allPools = (poolsByToken.get(idx) ?? []).sort((a, b) => b.tvlUsd - a.tvlUsd)
    const bestPool = allPools[0] ?? null
    const totalDexTvlUsd = allPools.reduce((acc, p) => acc + p.tvlUsd, 0)

    const referencePrice = oracleTokenPriceUsd ?? bestPool?.dexMidPriceUsd ?? null
    const marketCapUsd = referencePrice !== null ? totalSupplyTokens * referencePrice : null

    let midSpreadVsOracleBps: number | null = null
    if (bestPool && bestPool.tvlUsd >= 25 && oracleTokenPriceUsd && oracleTokenPriceUsd > 0) {
      midSpreadVsOracleBps = Math.round(
        ((bestPool.dexMidPriceUsd - oracleTokenPriceUsd) / oracleTokenPriceUsd) * 10_000,
      )
    }

    const riskFlags: string[] = []
    if (paused) riskFlags.push('TOKEN_PAUSED')
    if (oraclePaused) riskFlags.push('ORACLE_PAUSED_CORP_ACTION')
    if (hasScheduledCorporateAction) riskFlags.push('UPCOMING_MULTIPLIER_CHANGE')
    if (hasHistoricalMultiplierDrift && Math.abs(doubleCountTrapBps) >= 10) {
      riskFlags.push(`MULTIPLIER_DRIFT_${doubleCountTrapBps > 0 ? '+' : ''}${doubleCountTrapBps}BPS`)
    }
    if (oracleAgeHours !== null && oracleAgeHours > 72) {
      riskFlags.push('STALE_CHAINLINK_FEED_GT_72H')
    } else if (oracleWeekendMode) {
      riskFlags.push('ORACLE_24_5_OFF_HOURS')
    }
    if (midSpreadVsOracleBps !== null && Math.abs(midSpreadVsOracleBps) >= 150) {
      riskFlags.push(`DEX_ORACLE_DISLOCATION_${midSpreadVsOracleBps > 0 ? '+' : ''}${midSpreadVsOracleBps}BPS`)
    }

    return {
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      totalSupplyTokens,
      totalSupplySharesUI,
      marketCapUsd,
      uiMultiplier,
      newUiMultiplier,
      effectiveAt,
      hasScheduledCorporateAction,
      hasHistoricalMultiplierDrift,
      doubleCountTrapBps,
      paused,
      oraclePaused,
      feedAddress: t.feed,
      oracleTokenPriceUsd,
      underlyingSharePriceUsd,
      oracleAgeHours,
      oracleWeekendMode,
      bestPool,
      allPools,
      totalDexTvlUsd,
      midSpreadVsOracleBps,
      executableQuotes: [],
      riskFlags,
    }
  })

  // 5. Run exact QuoterV2 simulations ($50 and $500) on all liquid Chainlink-priced tokens
  const liquidPriced = results
    .filter((r) => r.bestPool && r.bestPool.tvlUsd >= 100 && (r.oracleTokenPriceUsd ?? 0) > 0)
    .sort((a, b) => b.totalDexTvlUsd - a.totalDexTvlUsd)

  const tradeSizesUsd = [50, 500]
  type QuoteJob = {
    resObj: TokenScanResult
    sizeUsd: number
    buyCallIdx: number
    sellCallIdx: number
    stockAmountIn: bigint
    quoteSymbol: 'USDG' | 'WETH'
    quoteDecimals: number
  }
  const quoteJobs: QuoteJob[] = []
  const quoterCalls: {
    address: Address
    abi: typeof ABIS.quoterV2
    functionName: 'quoteExactInputSingle'
    args: readonly [
      {
        tokenIn: Address
        tokenOut: Address
        amountIn: bigint
        fee: number
        sqrtPriceLimitX96: bigint
      },
    ]
  }[] = []

  for (const r of liquidPriced) {
    const pool = r.bestPool!
    const quoteDecimals = pool.quoteSymbol === 'USDG' ? USDG_DECIMALS : WETH_DECIMALS
    const quoteUsd = pool.quoteSymbol === 'USDG' ? 1 : wethPriceUsd
    if (quoteUsd <= 0 || !r.oracleTokenPriceUsd) continue

    for (const sizeUsd of tradeSizesUsd) {
      const quoteInFloat = sizeUsd / quoteUsd
      const quoteAmountIn = BigInt(Math.max(1, Math.floor(quoteInFloat * 10 ** quoteDecimals)))
      const stockInFloat = sizeUsd / r.oracleTokenPriceUsd
      const stockAmountIn = BigInt(Math.max(1, Math.floor(stockInFloat * 10 ** STOCK_DECIMALS)))

      const buyCallIdx = quoterCalls.length
      quoterCalls.push({
        address: ADDRESSES.quoterV2,
        abi: ABIS.quoterV2,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: pool.quoteToken,
            tokenOut: r.address,
            amountIn: quoteAmountIn,
            fee: pool.fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      })

      const sellCallIdx = quoterCalls.length
      quoterCalls.push({
        address: ADDRESSES.quoterV2,
        abi: ABIS.quoterV2,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: r.address,
            tokenOut: pool.quoteToken,
            amountIn: stockAmountIn,
            fee: pool.fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      })

      quoteJobs.push({
        resObj: r,
        sizeUsd,
        buyCallIdx,
        sellCallIdx,
        stockAmountIn,
        quoteSymbol: pool.quoteSymbol,
        quoteDecimals,
      })
    }
  }

  if (quoterCalls.length > 0) {
    const quoterRes = await client.multicall({ contracts: quoterCalls, batchSize: 2048 })
    for (const job of quoteJobs) {
      const buyRes = quoterRes[job.buyCallIdx]
      const sellRes = quoterRes[job.sellCallIdx]
      const quoteUsd = job.quoteSymbol === 'USDG' ? 1 : wethPriceUsd
      const oracle = job.resObj.oracleTokenPriceUsd!

      let buyPriceUsd: number | null = null
      let buySpreadVsOracleBps: number | null = null
      if (buyRes?.status === 'success') {
        const amountOutStock = Number(
          formatUnits((buyRes.result as readonly [bigint, ...unknown[]])[0], STOCK_DECIMALS),
        )
        if (amountOutStock > 0) {
          buyPriceUsd = job.sizeUsd / amountOutStock
          buySpreadVsOracleBps = Math.round(((buyPriceUsd - oracle) / oracle) * 10_000)
        }
      }

      let sellPriceUsd: number | null = null
      let sellSpreadVsOracleBps: number | null = null
      if (sellRes?.status === 'success') {
        const amountOutQuote = Number(
          formatUnits((sellRes.result as readonly [bigint, ...unknown[]])[0], job.quoteDecimals),
        )
        const stockSold = Number(formatUnits(job.stockAmountIn, STOCK_DECIMALS))
        if (amountOutQuote > 0 && stockSold > 0) {
          sellPriceUsd = (amountOutQuote * quoteUsd) / stockSold
          sellSpreadVsOracleBps = Math.round(((sellPriceUsd - oracle) / oracle) * 10_000)
        }
      }

      job.resObj.executableQuotes.push({
        tradeSizeUsd: job.sizeUsd,
        buyPriceUsd,
        sellPriceUsd,
        buySpreadVsOracleBps,
        sellSpreadVsOracleBps,
      })
    }
  }

  const topOpportunities = [...results]
    .filter((r) => r.midSpreadVsOracleBps !== null && r.totalDexTvlUsd >= 100)
    .sort((a, b) => Math.abs(b.midSpreadVsOracleBps!) - Math.abs(a.midSpreadVsOracleBps!))
    .slice(0, 12)

  const summary = {
    totalTokens: results.length,
    pricedByChainlink: results.filter((r) => r.oracleTokenPriceUsd !== null).length,
    tokensWithActivePools: results.filter((r) => r.allPools.length > 0).length,
    totalOnchainRwaMarketCapUsd: results.reduce((acc, r) => acc + (r.marketCapUsd ?? 0), 0),
    totalDexRwaTvlUsd: results.reduce((acc, r) => acc + r.totalDexTvlUsd, 0),
    tokensWithMultiplierDrift: results.filter((r) => r.hasHistoricalMultiplierDrift).length,
    scheduledCorporateActions: results.filter((r) => r.hasScheduledCorporateAction).length,
    riskAlertsCount: results.filter((r) => r.riskFlags.length > 0).length,
  }

  return {
    scannedAtIso: new Date().toISOString(),
    blockNumber,
    wethPriceUsd,
    summary,
    topOpportunities,
    tokens: results,
  }
}
