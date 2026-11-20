import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { ADDRESSES, robinhoodMainnet, STOCK_DECIMALS, USDG_DECIMALS } from './config.js'
import type { TokenScanResult } from './scanner.js'

export const X402_PRICE_USDG_RAW = 50_000n // 0.05 USDG (6 decimals)
export const X402_PRICE_DISPLAY = '0.05 USDG'
export const X402_DEFAULT_PAY_TO = (process.env.X402_PAY_TO ??
  '0x153EA79Afbe848529D9F2323a22775aCD3A5828f') as Address

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

const RISK_GUARD_ROUTER_ABI = parseAbi([
  'function swapExactInputGuarded((address stockToken, address quoteToken, address stockOracleFeed, address quoteOracleFeed, uint24 poolFee, bool isBuy, uint256 amountIn, uint256 minAmountOut, uint256 maxDeviationBps, uint256 maxOracleAge, uint256 deadline, bool blockPendingCorporateAction) params) returns (uint256 amountOut)',
])

const consumedPaymentTxHashes = new Set<string>()

export interface X402Challenge {
  x402Version: 1
  error: string
  resource: string
  accepts: [
    {
      scheme: 'exact'
      network: 'eip155:4663'
      chainName: 'Robinhood Chain'
      asset: Address
      assetSymbol: 'USDG'
      maxAmountRequired: string
      amountDisplay: string
      payTo: Address
      paymentHeader: 'X-Payment-Tx'
      description: string
    },
  ]
}

export interface X402VerificationResult {
  valid: boolean
  reason?: string
  payer?: Address
  amountRaw?: string
  blockNumber?: number
}

export interface GuardedSwapCalldataPayload {
  router: Address
  chainId: number
  symbol: string
  direction: 'BUY' | 'SELL'
  sizeUsd: number
  poolAddress: Address
  poolFee: number
  oraclePriceUsd: number | null
  dexMidPriceUsd: number | null
  spreadBps: number | null
  uiMultiplier: number
  complianceNotice: string
  guardParams: {
    stockToken: Address
    quoteToken: Address
    stockOracleFeed: Address
    quoteOracleFeed: Address
    poolFee: number
    isBuy: boolean
    amountIn: string
    minAmountOut: string
    maxDeviationBps: string
    maxOracleAge: string
    deadline: string
    blockPendingCorporateAction: boolean
  }
  calldata: Hex
}

export function buildX402Challenge(resourceUrl: string): X402Challenge {
  return {
    x402Version: 1,
    error: 'Payment Required: send 0.05 USDG on Robinhood Chain (eip155:4663) and retry with header X-Payment-Tx: <txHash>',
    resource: resourceUrl,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:4663',
        chainName: 'Robinhood Chain',
        asset: ADDRESSES.usdg,
        assetSymbol: 'USDG',
        maxAmountRequired: X402_PRICE_USDG_RAW.toString(),
        amountDisplay: X402_PRICE_DISPLAY,
        payTo: X402_DEFAULT_PAY_TO,
        paymentHeader: 'X-Payment-Tx',
        description:
          'Pay-per-verification guarded execution calldata encoded for RiskGuardRouter (0xE890...690F) on Robinhood Chain (non-custodial oracle & ERC-8056 circuit-breaker).',
      },
    ],
  }
}

export async function verifyX402PaymentOnChain(
  txHashRaw: string,
  rpcUrl?: string,
): Promise<X402VerificationResult> {
  const normalized = txHashRaw.trim().toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    return { valid: false, reason: 'Malformed X-Payment-Tx transaction hash.' }
  }
  if (consumedPaymentTxHashes.has(normalized)) {
    return { valid: false, reason: 'Payment transaction hash already consumed (replay blocked).' }
  }

  const client = createPublicClient({
    chain: robinhoodMainnet,
    transport: http(rpcUrl ?? robinhoodMainnet.rpcUrls.default.http[0], { timeout: 20_000 }),
  })

  try {
    const receipt = await client.getTransactionReceipt({ hash: normalized as Hex })
    if (receipt.status !== 'success') {
      return { valid: false, reason: 'Transaction reverted on-chain.' }
    }

    const expectedRecipient = X402_DEFAULT_PAY_TO.toLowerCase()
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== ADDRESSES.usdg.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics,
        })
        const toAddr = (decoded.args.to as Address).toLowerCase()
        const value = decoded.args.value as bigint
        if (toAddr === expectedRecipient && value >= X402_PRICE_USDG_RAW) {
          consumedPaymentTxHashes.add(normalized)
          return {
            valid: true,
            payer: decoded.args.from as Address,
            amountRaw: value.toString(),
            blockNumber: Number(receipt.blockNumber),
          }
        }
      } catch {
        // Not a Transfer log
      }
    }

    return {
      valid: false,
      reason: `No USDG Transfer >= ${X402_PRICE_USDG_RAW.toString()} raw units to ${X402_DEFAULT_PAY_TO} found in receipt.`,
    }
  } catch (err) {
    return { valid: false, reason: `RPC receipt lookup failed: ${String(err)}` }
  }
}

export function buildGuardedSwapPayload(
  token: TokenScanResult,
  sizeUsd = 50,
  direction?: 'buy' | 'sell',
  maxDeviationBps = 150,
): GuardedSwapCalldataPayload {
  if (!token.feedAddress || !token.oracleTokenPriceUsd) {
    throw new Error(`Ticker ${token.symbol} has no Chainlink feed in registry (required by RiskGuardRouter).`)
  }
  const usdgPool =
    token.allPools.find((p) => p.quoteSymbol === 'USDG' && p.tvlUsd >= 100) ??
    (token.bestPool?.quoteSymbol === 'USDG' ? token.bestPool : null)

  if (!usdgPool) {
    throw new Error(
      `No liquid ${token.symbol}/USDG Uniswap v3 pool found for USD-pegged RiskGuardRouter calldata.`,
    )
  }
  if (sizeUsd <= 0 || sizeUsd > 50_000) {
    throw new Error(`Invalid sizeUsd=${sizeUsd}. Allowed range: 1..50000.`)
  }

  const resolvedDirection: 'buy' | 'sell' =
    direction ?? (token.midSpreadVsOracleBps !== null && token.midSpreadVsOracleBps > 0 ? 'sell' : 'buy')
  const isBuy = resolvedDirection === 'buy'

  const amountIn = isBuy
    ? BigInt(Math.round(sizeUsd * 10 ** USDG_DECIMALS))
    : BigInt(Math.round((sizeUsd / token.oracleTokenPriceUsd) * 10 ** STOCK_DECIMALS))

  const expectedOutFloat = isBuy ? sizeUsd / token.oracleTokenPriceUsd : sizeUsd
  const outDecimals = isBuy ? STOCK_DECIMALS : USDG_DECIMALS
  const minAmountOut = BigInt(
    Math.floor(expectedOutFloat * ((10_000 - maxDeviationBps) / 10_000) * 10 ** outDecimals),
  )

  const maxOracleAge = token.oracleWeekendMode ? 259_200n : 7_200n
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)

  const guardParamsTuple = {
    stockToken: token.address,
    quoteToken: ADDRESSES.usdg,
    stockOracleFeed: token.feedAddress,
    quoteOracleFeed: zeroAddress,
    poolFee: usdgPool.fee,
    isBuy,
    amountIn,
    minAmountOut,
    maxDeviationBps: BigInt(maxDeviationBps),
    maxOracleAge,
    deadline,
    blockPendingCorporateAction: true,
  }

  const calldata = encodeFunctionData({
    abi: RISK_GUARD_ROUTER_ABI,
    functionName: 'swapExactInputGuarded',
    args: [guardParamsTuple],
  })

  return {
    router: ADDRESSES.riskGuardRouter,
    chainId: robinhoodMainnet.id,
    symbol: token.symbol,
    direction: isBuy ? 'BUY' : 'SELL',
    sizeUsd,
    poolAddress: usdgPool.poolAddress,
    poolFee: usdgPool.fee,
    oraclePriceUsd: token.oracleTokenPriceUsd,
    dexMidPriceUsd: usdgPool.dexMidPriceUsd,
    spreadBps: token.midSpreadVsOracleBps,
    uiMultiplier: token.uiMultiplier,
    complianceNotice:
      'Non-custodial oracle & ERC-8056 circuit-breaker verification only (not investment advice). Stock Tokens (Robinhood Assets (Jersey) Ltd) are not available to US, UK, CA, or CH persons.',
    guardParams: {
      stockToken: guardParamsTuple.stockToken,
      quoteToken: guardParamsTuple.quoteToken,
      stockOracleFeed: guardParamsTuple.stockOracleFeed,
      quoteOracleFeed: guardParamsTuple.quoteOracleFeed,
      poolFee: guardParamsTuple.poolFee,
      isBuy: guardParamsTuple.isBuy,
      amountIn: guardParamsTuple.amountIn.toString(),
      minAmountOut: guardParamsTuple.minAmountOut.toString(),
      maxDeviationBps: guardParamsTuple.maxDeviationBps.toString(),
      maxOracleAge: guardParamsTuple.maxOracleAge.toString(),
      deadline: guardParamsTuple.deadline.toString(),
      blockPendingCorporateAction: guardParamsTuple.blockPendingCorporateAction,
    },
    calldata,
  }
}
