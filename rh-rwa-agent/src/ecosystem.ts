import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
  isAddress,
  pad,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import {
  ABIS,
  ADDRESSES,
  loadStockRegistry,
  robinhoodMainnet,
  STOCK_DECIMALS,
  USDG_DECIMALS,
  WETH_DECIMALS,
} from './config.js'

export const ECOSYSTEM_CONTRACTS = {
  layerZeroEndpointV2: '0x6F475642a6e85809B1c36Fa62763669b1b48DD5B' as Address,
  usdgOftAdapter: '0x0d54755f5106BfdB43f7a35f5D49a23F940628d1' as Address,
  lighterVault: '0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d' as Address,
} as const

export const ROBINHOOD_LZ_EID = 30416

const OFT_ABI = parseAbi([
  'function peers(uint32 eid) view returns (bytes32 peer)',
  'function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee) msgFee)',
])

const ERC20_SUPPLY_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

export const CANDIDATE_LZ_CHAINS: { eid: number; name: string }[] = [
  { eid: 30101, name: 'Ethereum' },
  { eid: 30110, name: 'Arbitrum One' },
  { eid: 30184, name: 'Base' },
  { eid: 30111, name: 'Optimism' },
  { eid: 30109, name: 'Polygon' },
  { eid: 30102, name: 'BNB Chain' },
  { eid: 30106, name: 'Avalanche' },
  { eid: 30168, name: 'Solana' },
  { eid: 30183, name: 'Linea' },
  { eid: 30214, name: 'Scroll' },
  { eid: 30181, name: 'Mantle' },
  { eid: 30165, name: 'zkSync Era' },
  { eid: 30243, name: 'Blast' },
  { eid: 30280, name: 'Sei' },
  { eid: 30332, name: 'Sonic' },
  { eid: 30362, name: 'Berachain' },
  { eid: 30320, name: 'Unichain' },
  { eid: 30339, name: 'Ink' },
  { eid: 30319, name: 'World Chain' },
  { eid: 30324, name: 'Abstract' },
  { eid: 30370, name: 'Plume' },
  { eid: 30367, name: 'HyperEVM' },
]

export interface LayerZeroCorridor {
  dstEid: number
  chainName: string
  peerBytes32: Hex
  quote50UsdgFeeEth: number | null
  quote50UsdgFeeUsd: number | null
}

export interface EcosystemReport {
  scannedAtIso: string
  blockNumber: number
  gasPriceGwei: number
  wethPriceUsd: number
  usdgTotalSupplyUsd: number
  wethTotalSupply: number
  wethTotalTvlUsd: number
  lighterVaultUsdgUsd: number
  lighterVaultEthUsd: number
  layerZero: {
    localEid: number
    endpointV2: Address
    usdgOftAdapter: Address
    activeCorridorsCount: number
    activeCorridors: LayerZeroCorridor[]
  }
  pointsProtocols: {
    name: string
    status: string
    onchainMetric: string
    lowBudgetPlay: string
  }[]
}

export interface WalletReadinessReport {
  address: Address
  txCountOnRobinhood: number
  nativeEth: number
  nativeEthUsd: number
  estimatedSwapsGasRunway: number
  usdgBalance: number
  wethBalance: number
  wethBalanceUsd: number
  stockHoldings: {
    symbol: string
    tokens: number
    shareEquivalent: number
    uiMultiplier: number
    valueUsd: number | null
  }[]
  totalPortfolioUsd: number
  approvals: {
    usdgToSwapRouter: boolean
    usdgToLzOft: boolean
    usdgToLighter: boolean
  }
  recommendedNextSteps: string[]
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

export async function scanEcosystemAndLayerZero(
  wethPriceUsdHint?: number,
  rpcUrl?: string,
): Promise<EcosystemReport> {
  const client = createPublicClient({
    chain: robinhoodMainnet,
    transport: http(rpcUrl ?? robinhoodMainnet.rpcUrls.default.http[0], { timeout: 25_000 }),
  })

  const [blockNumber, gasPriceWei, lighterEthWei] = await Promise.all([
    client.getBlockNumber(),
    client.getGasPrice(),
    client.getBalance({ address: ECOSYSTEM_CONTRACTS.lighterVault }),
  ])

  const wethPriceUsd = wethPriceUsdHint && wethPriceUsdHint > 0 ? wethPriceUsdHint : 1787

  const coreCalls = [
    { address: ADDRESSES.usdg, abi: ERC20_SUPPLY_ABI, functionName: 'totalSupply' as const },
    { address: ADDRESSES.weth, abi: ERC20_SUPPLY_ABI, functionName: 'totalSupply' as const },
    {
      address: ADDRESSES.usdg,
      abi: ERC20_SUPPLY_ABI,
      functionName: 'balanceOf' as const,
      args: [ECOSYSTEM_CONTRACTS.lighterVault] as const,
    },
    ...CANDIDATE_LZ_CHAINS.map((c) => ({
      address: ECOSYSTEM_CONTRACTS.usdgOftAdapter,
      abi: OFT_ABI,
      functionName: 'peers' as const,
      args: [c.eid] as const,
    })),
  ]

  const coreRes = await client.multicall({ contracts: coreCalls })

  const usdgSupplyRaw = coreRes[0]?.status === 'success' ? (coreRes[0]!.result as bigint) : 0n
  const wethSupplyRaw = coreRes[1]?.status === 'success' ? (coreRes[1]!.result as bigint) : 0n
  const lighterUsdgRaw = coreRes[2]?.status === 'success' ? (coreRes[2]!.result as bigint) : 0n

  const usdgTotalSupplyUsd = Number(formatUnits(usdgSupplyRaw, USDG_DECIMALS))
  const wethTotalSupply = Number(formatUnits(wethSupplyRaw, WETH_DECIMALS))
  const lighterVaultUsdgUsd = Number(formatUnits(lighterUsdgRaw, USDG_DECIMALS))
  const lighterVaultEthUsd = Number(formatEther(lighterEthWei)) * wethPriceUsd

  const wiredPeers: { eid: number; chainName: string; peer: Hex }[] = []
  CANDIDATE_LZ_CHAINS.forEach((c, idx) => {
    const r = coreRes[3 + idx]
    if (r?.status === 'success' && r.result && r.result !== ZERO_BYTES32) {
      wiredPeers.push({ eid: c.eid, chainName: c.name, peer: r.result as Hex })
    }
  })

  // Quote exact LayerZero V2 native fee for bridging $50 USDG to each active peer
  const dummyRecipient = pad('0x1111111111111111111111111111111111111111', { size: 32 })
  const amount50Usdg = 50n * 10n ** 6n
  const minAmount = 49_750_000n

  const activeCorridors: LayerZeroCorridor[] = []
  if (wiredPeers.length > 0) {
    const quoteCalls = wiredPeers.map((p) => ({
      address: ECOSYSTEM_CONTRACTS.usdgOftAdapter,
      abi: OFT_ABI,
      functionName: 'quoteSend' as const,
      args: [
        {
          dstEid: p.eid,
          to: dummyRecipient,
          amountLD: amount50Usdg,
          minAmountLD: minAmount,
          extraOptions: '0x' as Hex,
          composeMsg: '0x' as Hex,
          oftCmd: '0x' as Hex,
        },
        false,
      ] as const,
    }))

    const quoteRes = await client.multicall({ contracts: quoteCalls })
    wiredPeers.forEach((p, idx) => {
      const qr = quoteRes[idx]
      let feeEth: number | null = null
      let feeUsd: number | null = null
      if (qr?.status === 'success') {
        const resTuple = qr.result as { nativeFee: bigint; lzTokenFee: bigint }
        feeEth = Number(formatEther(resTuple.nativeFee))
        feeUsd = Number((feeEth * wethPriceUsd).toFixed(4))
      }
      activeCorridors.push({
        dstEid: p.eid,
        chainName: p.chainName,
        peerBytes32: p.peer,
        quote50UsdgFeeEth: feeEth,
        quote50UsdgFeeUsd: feeUsd,
      })
    })
  }

  return {
    scannedAtIso: new Date().toISOString(),
    blockNumber: Number(blockNumber),
    gasPriceGwei: Number(formatUnits(gasPriceWei, 9)),
    wethPriceUsd,
    usdgTotalSupplyUsd,
    wethTotalSupply,
    wethTotalTvlUsd: wethTotalSupply * wethPriceUsd,
    lighterVaultUsdgUsd,
    lighterVaultEthUsd,
    layerZero: {
      localEid: ROBINHOOD_LZ_EID,
      endpointV2: ECOSYSTEM_CONTRACTS.layerZeroEndpointV2,
      usdgOftAdapter: ECOSYSTEM_CONTRACTS.usdgOftAdapter,
      activeCorridorsCount: activeCorridors.length,
      activeCorridors,
    },
    pointsProtocols: [
      {
        name: 'Lighter Perp DEX ($LIT Incentives)',
        status: 'LIVE ON MAINNET (4663)',
        onchainMetric: `$${(lighterVaultUsdgUsd / 1_000_000).toFixed(2)}M USDG locked in vault 0x94bA...fF9d`,
        lowBudgetPlay:
          'Deposit $25-$50 USDG, place zero/low-slippage maker limit orders on liquid pairs or hedge spot Stock Token exposure to farm $LIT points without burning taker fees.',
      },
      {
        name: 'Arcus (Season 1 Points — RWA RFQ + Tokenized Perps)',
        status: 'SEASON 1 ACTIVE',
        onchainMetric: '0% fee RFQ spot Stock Tokens + ERC-20 transferable perp positions',
        lowBudgetPlay:
          'Execute 0%-fee spot RWA trades via Robinhood Wallet DApp browser + hold small cross-margined Stock Token collateral to accrue Season 1 volume & holding points.',
      },
      {
        name: 'LayerZero V2 (Endpoint EID 30416 + USDG OFT)',
        status: 'LIVE ON MAINNET (4663)',
        onchainMetric: `EndpointV2 0x6F47...DD5B | ${activeCorridors.length} active USDG OFT peer corridors`,
        lowBudgetPlay:
          'Route initial & rebalancing USDG capital through verified LayerZero OFT corridors instead of CEX-only transfers to record organic EID 30416 omnichain volume.',
      },
    ],
  }
}

export async function inspectWalletReadiness(
  rawAddress: string,
  wethPriceUsdHint?: number,
  rpcUrl?: string,
): Promise<WalletReadinessReport> {
  if (!isAddress(rawAddress)) {
    throw new Error(`Invalid EVM wallet address: ${rawAddress}`)
  }
  const wallet = rawAddress as Address
  const client = createPublicClient({
    chain: robinhoodMainnet,
    transport: http(rpcUrl ?? robinhoodMainnet.rpcUrls.default.http[0], { timeout: 25_000 }),
  })

  const registry = loadStockRegistry()
  const wethPriceUsd = wethPriceUsdHint && wethPriceUsdHint > 0 ? wethPriceUsdHint : 1787

  const [ethBalWei, txCount, gasPriceWei] = await Promise.all([
    client.getBalance({ address: wallet }),
    client.getTransactionCount({ address: wallet }),
    client.getGasPrice(),
  ])

  const calls = [
    { address: ADDRESSES.usdg, abi: ERC20_SUPPLY_ABI, functionName: 'balanceOf' as const, args: [wallet] as const },
    { address: ADDRESSES.weth, abi: ERC20_SUPPLY_ABI, functionName: 'balanceOf' as const, args: [wallet] as const },
    {
      address: ADDRESSES.usdg,
      abi: ERC20_SUPPLY_ABI,
      functionName: 'allowance' as const,
      args: [wallet, ADDRESSES.swapRouter02] as const,
    },
    {
      address: ADDRESSES.usdg,
      abi: ERC20_SUPPLY_ABI,
      functionName: 'allowance' as const,
      args: [wallet, ECOSYSTEM_CONTRACTS.usdgOftAdapter] as const,
    },
    {
      address: ADDRESSES.usdg,
      abi: ERC20_SUPPLY_ABI,
      functionName: 'allowance' as const,
      args: [wallet, ECOSYSTEM_CONTRACTS.lighterVault] as const,
    },
    ...registry.tokens.flatMap((t) => [
      { address: t.address, abi: ABIS.stockToken, functionName: 'balanceOf' as const, args: [wallet] as const },
      { address: t.address, abi: ABIS.stockToken, functionName: 'uiMultiplier' as const },
    ]),
  ]

  const res = await client.multicall({ contracts: calls, batchSize: 4096 })

  const usdgBalance =
    res[0]?.status === 'success' ? Number(formatUnits(res[0]!.result as bigint, USDG_DECIMALS)) : 0
  const wethBalance =
    res[1]?.status === 'success' ? Number(formatUnits(res[1]!.result as bigint, WETH_DECIMALS)) : 0
  const allowSwap = res[2]?.status === 'success' ? (res[2]!.result as bigint) > 0n : false
  const allowLz = res[3]?.status === 'success' ? (res[3]!.result as bigint) > 0n : false
  const allowLighter = res[4]?.status === 'success' ? (res[4]!.result as bigint) > 0n : false

  // Find non-zero Stock Tokens and fetch their Chainlink prices if present
  const rawHoldings: { idx: number; bal: number; mult: number }[] = []
  registry.tokens.forEach((_, idx) => {
    const balRes = res[5 + idx * 2]
    const multRes = res[5 + idx * 2 + 1]
    const rawBal = balRes?.status === 'success' ? (balRes.result as bigint) : 0n
    if (rawBal > 0n) {
      const mult =
        multRes?.status === 'success' ? Number(formatUnits(multRes.result as bigint, 18)) : 1
      rawHoldings.push({
        idx,
        bal: Number(formatUnits(rawBal, STOCK_DECIMALS)),
        mult,
      })
    }
  })

  const stockHoldings: WalletReadinessReport['stockHoldings'] = []
  if (rawHoldings.length > 0) {
    const pricedHoldings = rawHoldings.filter((h) => registry.tokens[h.idx]!.feed !== null)
    const feedRes =
      pricedHoldings.length > 0
        ? await client.multicall({
            contracts: pricedHoldings.map((h) => ({
              address: registry.tokens[h.idx]!.feed!,
              abi: ABIS.aggregatorV3,
              functionName: 'latestRoundData' as const,
            })),
          })
        : []

    const priceByIdx = new Map<number, number>()
    pricedHoldings.forEach((h, i) => {
      const fr = feedRes[i]
      if (fr?.status === 'success') {
        const [, ans] = fr.result as readonly [bigint, bigint, ...unknown[]]
        if (ans > 0n) {
          priceByIdx.set(
            h.idx,
            Number(formatUnits(ans, registry.tokens[h.idx]!.feedDecimals ?? 8)),
          )
        }
      }
    })

    for (const h of rawHoldings) {
      const tok = registry.tokens[h.idx]!
      const px = priceByIdx.get(h.idx) ?? null
      stockHoldings.push({
        symbol: tok.symbol,
        tokens: Number(h.bal.toFixed(6)),
        shareEquivalent: Number((h.bal * h.mult).toFixed(6)),
        uiMultiplier: Number(h.mult.toFixed(6)),
        valueUsd: px !== null ? Number((h.bal * px).toFixed(2)) : null,
      })
    }
  }

  const nativeEth = Number(formatEther(ethBalWei))
  const nativeEthUsd = Number((nativeEth * wethPriceUsd).toFixed(2))
  const wethBalanceUsd = Number((wethBalance * wethPriceUsd).toFixed(2))
  const stocksUsd = stockHoldings.reduce((acc, s) => acc + (s.valueUsd ?? 0), 0)
  const totalPortfolioUsd = Number((nativeEthUsd + usdgBalance + wethBalanceUsd + stocksUsd).toFixed(2))

  // Typical Uniswap v3 swap ~180k gas on Orbit L2
  const singleSwapWei = gasPriceWei * 180_000n
  const estimatedSwapsGasRunway =
    singleSwapWei > 0n ? Number(ethBalWei / singleSwapWei) : nativeEth > 0 ? 9999 : 0

  const recommendedNextSteps: string[] = []
  if (nativeEthUsd < 2) {
    recommendedNextSteps.push(
      'Пополните $3–$5 в нативном ETH на Robinhood Chain (4663) для запаса газа на десятки транзакций.',
    )
  }
  if (!allowLz && usdgBalance === 0) {
    recommendedNextSteps.push(
      'Заведите рабочий стейбл USDG ($20–$50) через активный LayerZero OFT маршрут, чтобы сразу закрыть органическую транзакцию в EID 30416.',
    )
  }
  if (!allowLighter) {
    recommendedNextSteps.push(
      'Кошелёк ещё не взаимодействовал с Lighter Vault (0x94bA...fF9d, $92M TVL) — отличная точка для фарма $LIT лимитными ордерами.',
    )
  }
  if (stockHoldings.length === 0) {
    recommendedNextSteps.push(
      'Нет позиций в Stock Tokens — используйте сигналы @RiskGuardTerminal_Bot (спреды >60 bps) или 0%-fee свопы в Arcus (Season 1 Points).',
    )
  }

  return {
    address: wallet,
    txCountOnRobinhood: txCount,
    nativeEth,
    nativeEthUsd,
    estimatedSwapsGasRunway,
    usdgBalance,
    wethBalance,
    wethBalanceUsd,
    stockHoldings,
    totalPortfolioUsd,
    approvals: {
      usdgToSwapRouter: allowSwap,
      usdgToLzOft: allowLz,
      usdgToLighter: allowLighter,
    },
    recommendedNextSteps,
  }
}
