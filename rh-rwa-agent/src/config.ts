import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineChain, parseAbi, type Address } from 'viem'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = resolve(__dirname, '..')
export const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..')

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://rpc.mainnet.chain.robinhood.com'],
      webSocket: ['wss://feed.mainnet.chain.robinhood.com'],
    },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
})

export const ADDRESSES = {
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
  stockBeaconAndRegistry: '0xe10b6f6B275de231345c20D14Ab812db62151b00' as Address,
  stockFactory: '0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046' as Address,
  justInTimeFunding: '0xd4A91E5023406903afF83225186e1d1eD18CA587' as Address,
  uniswapV3Factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as Address,
  quoterV2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7' as Address,
  swapRouter02: '0xCaf681a66D020601342297493863E78C959E5cb2' as Address,
  riskGuardRouter: '0xE890D81346C465fAE5bCa38ad825669dE448690F' as Address,
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' as Address,
} as const

export const FEE_TIERS = [100, 500, 3000, 10000] as const
export const USDG_DECIMALS = 6
export const WETH_DECIMALS = 18
export const STOCK_DECIMALS = 18

export const ABIS = {
  stockToken: parseAbi([
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function uiMultiplier() view returns (uint256)',
    'function newUIMultiplier() view returns (uint256)',
    'function effectiveAt() view returns (uint256)',
    'function paused() view returns (bool)',
    'function oraclePaused() view returns (bool)',
  ]),
  erc20: parseAbi([
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ]),
  aggregatorV3: parseAbi([
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  ]),
  v3Factory: parseAbi([
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
  ]),
  v3Pool: parseAbi([
    'function liquidity() view returns (uint128)',
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  ]),
  quoterV2: parseAbi([
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ]),
} as const

export interface RegistryTokenEntry {
  address: Address
  symbol: string
  name: string
  decimals: number
  uiMultiplierAtGeneration: string
  feed: Address | null
  feedDecimals: number | null
}

export interface RegistryFile {
  chainId: number
  tokenCount: number
  feedCount: number
  tokens: RegistryTokenEntry[]
}

export function loadStockRegistry(): RegistryFile {
  const sdkPath = resolve(
    WORKSPACE_ROOT,
    'reference',
    'robinhood-chain-sdk',
    'src',
    'registry',
    'stock-tokens.json',
  )
  const regPath = existsSync(sdkPath) ? sdkPath : resolve(WORKSPACE_ROOT, 'data', 'stock-tokens.json')
  return JSON.parse(readFileSync(regPath, 'utf-8')) as RegistryFile
}
