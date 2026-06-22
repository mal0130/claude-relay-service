/**
 * PricingService 长上下文计费测试
 *
 * 根据 Anthropic 官方定价页面（https://platform.claude.com/docs/en/about-claude/pricing）：
 * - 所有 Claude 模型均为统一价格，无论上下文长度如何（1M token 内无额外加价）
 * - Fast Mode 倍率仍适用（Opus 4.6）
 * - 非 Claude 模型的 200K+ 分层计费逻辑仍保留
 */

// Mock logger to avoid console output during tests
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
  database: jest.fn(),
  security: jest.fn()
}))

// Mock fs to control pricing data
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
    statSync: jest.fn(),
    watchFile: jest.fn(),
    unwatchFile: jest.fn()
  }
})

describe('PricingService - Long Context Pricing', () => {
  let pricingService
  const fs = require('fs')
  const path = require('path')

  // 使用真实的 model_pricing.json 数据（优先 data/，fallback 到 resources/）
  const realFs = jest.requireActual('fs')
  const primaryPath = path.join(process.cwd(), 'data', 'model_pricing.json')
  const fallbackPath = path.join(
    process.cwd(),
    'resources',
    'model-pricing',
    'model_prices_and_context_window.json'
  )
  const pricingFilePath = realFs.existsSync(primaryPath) ? primaryPath : fallbackPath
  const pricingData = JSON.parse(realFs.readFileSync(pricingFilePath, 'utf8'))

  beforeEach(() => {
    // 清除缓存的模块
    jest.resetModules()

    // 配置 fs mock（防止 pricingService 初始化时的文件副作用）
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue(JSON.stringify(pricingData))
    fs.statSync.mockReturnValue({ mtime: new Date(), mtimeMs: Date.now() })
    fs.watchFile.mockImplementation(() => {})
    fs.unwatchFile.mockImplementation(() => {})

    // 重新加载 pricingService
    pricingService = require('../src/services/pricingService')

    // 直接设置真实价格数据（绕过网络初始化）
    pricingService.pricingData = pricingData
    pricingService.lastUpdated = new Date()
  })

  afterEach(() => {
    // 清理定时器
    if (pricingService.cleanup) {
      pricingService.cleanup()
    }
    jest.clearAllMocks()
  })

  describe('Claude 模型平坦计费（无 200K+ 加价）', () => {
    it('199999 tokens - 应使用基础价格', () => {
      const usage = {
        input_tokens: 199999,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }

      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-20250514[1m]')

      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBe(0.000003) // 基础价格
      expect(result.pricing.output).toBe(0.000015) // 基础价格
    })

    it('200001 tokens - Claude 模型应使用基础价格（无 200K+ 加价）', () => {
      const usage = {
        input_tokens: 200001,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }

      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-20250514[1m]')

      // 官方定价：Claude 模型全局统一价格，超过 200K 不加价
      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBe(0.000003) // 基础价格
      expect(result.pricing.output).toBe(0.000015) // 基础价格
    })

    it('分散在各类 token 中总计超过 200K 时 Claude 仍使用基础价格', () => {
      const usage = {
        input_tokens: 150000,
        output_tokens: 10000,
        cache_creation_input_tokens: 40000,
        cache_read_input_tokens: 20000
      }
      // Total: 150000 + 40000 + 20000 = 210000 > 200000

      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-20250514[1m]')

      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBe(0.000003) // 基础价格
      expect(result.pricing.output).toBe(0.000015) // 基础价格
      expect(result.pricing.cacheCreate).toBe(0.00000375) // 基础价格
      expect(result.pricing.cacheRead).toBeCloseTo(0.0000003, 12) // 基础价格
    })

    it('仅 cache tokens 超过 200K 时 Claude 也使用基础价格', () => {
      const usage = {
        input_tokens: 50000,
        output_tokens: 5000,
        cache_creation_input_tokens: 100000,
        cache_read_input_tokens: 60000
      }
      // Total: 50000 + 100000 + 60000 = 210000 > 200000

      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-20250514[1m]')

      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBe(0.000003) // 基础价格
    })

    it('claude-sonnet-4-5 超过 200K 时也使用基础价格', () => {
      const usage = {
        input_tokens: 300000,
        output_tokens: 5000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }

      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-5[1m]')

      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBe(0.000003) // 基础价格 $3/MTok
      expect(result.pricing.output).toBe(0.000015) // 基础价格 $15/MTok
    })

    it('claude-sonnet-4-6 超过 200K 时也使用基础价格', () => {
      const usage = {
        input_tokens: 500000,
        output_tokens: 10000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }

      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-6[1m]')

      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBe(0.000003) // 基础价格 $3/MTok
      expect(result.pricing.output).toBe(0.000015) // 基础价格 $15/MTok
    })
  })

  describe('详细缓存创建数据（ephemeral_5m / ephemeral_1h）', () => {
    it('超过 200K 时 Claude 缓存价格仍使用基础价格', () => {
      const usage = {
        input_tokens: 200001,
        output_tokens: 1000,
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 5000,
          ephemeral_1h_input_tokens: 5000
        }
      }

      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-20250514[1m]')

      expect(result.isLongContextRequest).toBe(false)
      // ephemeral_5m: 5000 * 0.00000375 = 0.00001875（基础 cache_creation 价格）
      expect(result.ephemeral5mCost).toBeCloseTo(5000 * 0.00000375, 10)
      // ephemeral_1h: 5000 * 0.000006（基础 1hr cache 价格）
      expect(result.pricing.ephemeral1h).toBeCloseTo(0.000006, 10)
      expect(result.ephemeral1hCost).toBeCloseTo(5000 * 0.000006, 10)
    })
  })

  describe('context-1m beta header 不影响 Claude 计费', () => {
    it('无 [1m] 后缀但带 context-1m beta 且超过 200K，Claude 仍使用基础价格', () => {
      const usage = {
        input_tokens: 210000,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        request_anthropic_beta: 'context-1m-2025-08-07'
      }

      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-20250514')

      // Claude 模型统一定价，无论是否带 beta 头都不应有额外加价
      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBe(0.000003) // 基础价格
      expect(result.pricing.output).toBe(0.000015) // 基础价格
    })
  })

  describe('Fast Mode 计费（Opus 4.6）', () => {
    it('Opus 4.6 在 fast-mode beta + speed=fast 时应用 Fast Mode 6x', () => {
      const usage = {
        input_tokens: 100000,
        output_tokens: 20000,
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 5000,
        request_anthropic_beta: 'fast-mode-2026-02-01',
        speed: 'fast'
      }

      const result = pricingService.calculateCost(usage, 'claude-opus-4-6')

      // input: 0.000005 * 6 = 0.00003
      expect(result.pricing.input).toBeCloseTo(0.00003, 12)
      // output: 0.000025 * 6 = 0.00015
      expect(result.pricing.output).toBeCloseTo(0.00015, 12)
      // cache create/read 由 fast 后 input 推导
      expect(result.pricing.cacheCreate).toBeCloseTo(0.0000375, 12) // 0.00003 * 1.25
      expect(result.pricing.cacheRead).toBeCloseTo(0.000003, 12) // 0.00003 * 0.1
      expect(result.pricing.ephemeral1h).toBeCloseTo(0.00006, 12) // 0.00003 * 2
    })

    it('Opus 4.6 在 fast-mode + [1m] 且超过 200K 时不叠加长上下文加价', () => {
      const usage = {
        input_tokens: 210000,
        output_tokens: 1000,
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 10000,
        request_anthropic_beta: 'fast-mode-2026-02-01,context-1m-2025-08-07',
        speed: 'fast'
      }

      const result = pricingService.calculateCost(usage, 'claude-opus-4-6[1m]')

      expect(result.isLongContextRequest).toBe(false)
      // input: 0.000005（200K+ 维持同价）-> fast 6x => 0.00003
      expect(result.pricing.input).toBeCloseTo(0.00003, 12)
      // output: 0.000025（200K+ 维持同价）-> fast 6x => 0.00015
      expect(result.pricing.output).toBeCloseTo(0.00015, 12)
    })

    it('Opus 4.6 在 [1m] 且超过 200K、未开启 fast-mode 时保持基础价格', () => {
      const usage = {
        input_tokens: 210000,
        output_tokens: 1000,
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 10000,
        request_anthropic_beta: 'context-1m-2025-08-07'
      }

      const result = pricingService.calculateCost(usage, 'claude-opus-4-6[1m]')

      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBeCloseTo(0.000005, 12)
      expect(result.pricing.output).toBeCloseTo(0.000025, 12)
      expect(result.pricing.cacheCreate).toBeCloseTo(0.00000625, 12)
      expect(result.pricing.cacheRead).toBeCloseTo(0.0000005, 12)
    })
  })

  describe('兼容性测试', () => {
    it('非 [1m] 模型不受影响，始终使用基础价格', () => {
      const usage = {
        input_tokens: 250000,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }

      // 不带 [1m] 后缀
      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-20250514')

      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBe(0.000003) // 基础价格
      expect(result.pricing.output).toBe(0.000015) // 基础价格
      expect(result.pricing.cacheCreate).toBe(0.00000375) // 基础价格
      expect(result.pricing.cacheRead).toBeCloseTo(0.0000003, 12) // 基础价格
    })

    it('[1m] 模型未超过 200K 时使用基础价格', () => {
      const usage = {
        input_tokens: 100000,
        output_tokens: 1000,
        cache_creation_input_tokens: 50000,
        cache_read_input_tokens: 49000
      }
      // Total: 199000 < 200000

      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-20250514[1m]')

      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBe(0.000003) // 基础价格
    })

    it('无定价数据时返回 hasPricing=false', () => {
      const usage = {
        input_tokens: 250000,
        output_tokens: 1000
      }

      const result = pricingService.calculateCost(usage, 'unknown-model[1m]')

      expect(result.hasPricing).toBe(false)
      expect(result.totalCost).toBe(0)
    })
  })

  describe('成本计算准确性（基础价格）', () => {
    it('应正确以基础价格计算超过 200K 场景下的总成本', () => {
      const usage = {
        input_tokens: 150000,
        output_tokens: 10000,
        cache_creation_input_tokens: 40000,
        cache_read_input_tokens: 20000
      }
      // Total input: 210000 > 200000，但 Claude 使用基础价格

      const result = pricingService.calculateCost(usage, 'claude-sonnet-4-20250514[1m]')

      // 手动计算预期成本（全部使用基础价格）
      const expectedInputCost = 150000 * 0.000003 // $0.45
      const expectedOutputCost = 10000 * 0.000015 // $0.15
      const expectedCacheCreateCost = 40000 * 0.00000375 // $0.15
      const expectedCacheReadCost = 20000 * 0.0000003 // $0.006
      const expectedTotal =
        expectedInputCost + expectedOutputCost + expectedCacheCreateCost + expectedCacheReadCost

      expect(result.inputCost).toBeCloseTo(expectedInputCost, 10)
      expect(result.outputCost).toBeCloseTo(expectedOutputCost, 10)
      expect(result.cacheCreateCost).toBeCloseTo(expectedCacheCreateCost, 10)
      expect(result.cacheReadCost).toBeCloseTo(expectedCacheReadCost, 10)
      expect(result.totalCost).toBeCloseTo(expectedTotal, 10)
    })
  })

  describe('MiniMax M3 512K 分层计费', () => {
    it('512K 以下应使用基础价格', () => {
      pricingService.pricingData = pricingService.getMiniMaxFallbackPricing(
        new Date('2026-06-05T00:00:00.000Z')
      )

      const usage = {
        input_tokens: 500000,
        output_tokens: 10000,
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 10000
      }

      const result = pricingService.calculateCost(usage, 'MiniMax-M3')

      expect(result.pricing.input).toBeCloseTo(0.3 / 1e6, 14)
      expect(result.pricing.output).toBeCloseTo(1.2 / 1e6, 14)
      expect(result.pricing.cacheRead).toBeCloseTo(0.06 / 1e6, 14)
      expect(result.pricing.cacheCreate).toBeCloseTo(0.375 / 1e6, 14)
    })

    it('512K 以上应切换到高档价格', () => {
      pricingService.pricingData = pricingService.getMiniMaxFallbackPricing(
        new Date('2026-06-05T00:00:00.000Z')
      )

      const usage = {
        input_tokens: 520000,
        output_tokens: 10000,
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: 2000
      }
      // Total input: 525000 > 512 * 1024

      const result = pricingService.calculateCost(usage, 'MiniMax-M3')

      expect(result.pricing.input).toBeCloseTo(1.2 / 1e6, 14)
      expect(result.pricing.output).toBeCloseTo(4.8 / 1e6, 14)
      expect(result.pricing.cacheRead).toBeCloseTo(0.24 / 1e6, 14)
      expect(result.pricing.cacheCreate).toBeCloseTo(0.375 / 1e6, 14)
    })

    it('其他 MiniMax 模型不应触发 M3 的 512K 分层价格', () => {
      pricingService.pricingData = pricingService.getMiniMaxFallbackPricing(
        new Date('2026-06-05T00:00:00.000Z')
      )

      const usage = {
        input_tokens: 600000,
        output_tokens: 10000,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 5000
      }

      const result = pricingService.calculateCost(usage, 'MiniMax-M2.7')

      expect(result.pricing.input).toBeCloseTo(0.3 / 1e6, 14)
      expect(result.pricing.output).toBeCloseTo(1.2 / 1e6, 14)
      expect(result.pricing.cacheRead).toBeCloseTo(0.06 / 1e6, 14)
    })
  })

  describe('GLM pricing', () => {
    const glmPricingDocsHtml = `
      <table>
        <thead>
          <tr>
            <th style="text-align: left;">Model</th>
            <th style="text-align: left;">Context</th>
            <th style="text-align: left;">Input</th>
            <th style="text-align: left;">Output</th>
            <th style="text-align: left;">Cached Input Storage</th>
            <th style="text-align: left;">Cached Input</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="text-align: left;">GLM-5.2 新品</td>
            <td style="text-align: left;">1M</td>
            <td style="text-align: left;">8元</td>
            <td style="text-align: left;">28元</td>
            <td style="text-align: left;">Limited-time Free</td>
            <td style="text-align: left;">2元</td>
          </tr>
          <tr>
            <td style="text-align: left;" rowspan="2">GLM-5.1</td>
            <td style="text-align: left;">输入长度 [0, 32)</td>
            <td style="text-align: left;">6元</td>
            <td style="text-align: left;">24元</td>
            <td style="text-align: left;">Limited-time Free</td>
            <td style="text-align: left;">1.3元</td>
          </tr>
          <tr>
            <td style="text-align: left;">输入长度 [32, +)</td>
            <td style="text-align: left;">8元</td>
            <td style="text-align: left;">28元</td>
            <td style="text-align: left;">Limited-time Free</td>
            <td style="text-align: left;">2元</td>
          </tr>
        </tbody>
      </table>
    `

    it('应为 glm-5.2 提供官方 fallback 价格', () => {
      const fallbackPricing = pricingService.getGlmFallbackPricing(
        new Date('2026-06-22T00:00:00.000Z')
      )
      pricingService.pricingData = fallbackPricing

      const result = pricingService.calculateCost(
        {
          input_tokens: 1000000,
          output_tokens: 1000000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1000000
        },
        'glm-5.2'
      )

      expect(result.hasPricing).toBe(true)
      expect(result.pricing.input).toBeCloseTo(8 / 7 / 1e6, 14)
      expect(result.pricing.output).toBeCloseTo(28 / 7 / 1e6, 14)
      expect(result.pricing.cacheRead).toBeCloseTo(2 / 7 / 1e6, 14)
      expect(fallbackPricing['glm-5.2'].provider_specific_entry.pricing_in_cny).toEqual({
        exchange_rate: 7,
        input_per_million: 8,
        output_per_million: 28,
        cache_read_per_million: 2
      })
    })

    it('应能从当前官方文档表格解析 glm-5.2 价格', () => {
      const parsed = pricingService.parseGlmPricingHtml(
        glmPricingDocsHtml,
        new Date('2026-06-22T00:00:00.000Z')
      )

      expect(parsed['glm-5.2']).toBeDefined()
      expect(parsed['glm-5.2'].input_cost_per_token).toBeCloseTo(8 / 7 / 1e6, 14)
      expect(parsed['glm-5.2'].output_cost_per_token).toBeCloseTo(28 / 7 / 1e6, 14)
      expect(parsed['glm-5.2'].cache_read_input_token_cost).toBeCloseTo(2 / 7 / 1e6, 14)
      expect(parsed['glm-5.2'].pricing_source).toBe('glm_official_docs')
      expect(parsed['glm-5.2'].provider_specific_entry.pricing_in_cny).toEqual({
        exchange_rate: 7,
        input_per_million: 8,
        output_per_million: 28,
        cache_read_per_million: 2
      })
    })

    it('应保留 glm-5.1 的官方分档价格', () => {
      const parsed = pricingService.parseGlmPricingHtml(
        glmPricingDocsHtml,
        new Date('2026-06-22T00:00:00.000Z')
      )
      pricingService.pricingData = parsed

      expect(parsed['glm-5.1'].provider_specific_entry.pricing_in_cny.tiers).toEqual([
        {
          condition: 'input < 32k',
          input: 6,
          cacheRead: 1.3,
          output: 24,
          input_usd_per_million: 6 / 7,
          output_usd_per_million: 24 / 7,
          cache_read_usd_per_million: 1.3 / 7
        },
        {
          condition: 'input >= 32k',
          input: 8,
          cacheRead: 2,
          output: 28,
          input_usd_per_million: 8 / 7,
          output_usd_per_million: 28 / 7,
          cache_read_usd_per_million: 2 / 7
        }
      ])

      const lowTierResult = pricingService.calculateCost(
        {
          input_tokens: 31999,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        'glm-5.1'
      )
      const highTierResult = pricingService.calculateCost(
        {
          input_tokens: 32000,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        'glm-5.1'
      )

      expect(lowTierResult.pricing.input).toBeCloseTo(6 / 7 / 1e6, 14)
      expect(highTierResult.pricing.input).toBeCloseTo(8 / 7 / 1e6, 14)
      expect(highTierResult.pricing.output).toBeCloseTo(28 / 7 / 1e6, 14)
      expect(highTierResult.pricing.cacheRead).toBeCloseTo(2 / 7 / 1e6, 14)
    })

    it('应按官方 32k 以下档位计算 glm-5.1 精确样例', () => {
      pricingService.pricingData = pricingService.getGlmFallbackPricing(
        new Date('2026-06-10T00:00:00.000Z')
      )

      const usage = {
        input_tokens: 20276,
        output_tokens: 141,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }

      const result = pricingService.calculateCost(usage, 'glm-5.1')

      expect(result.hasPricing).toBe(true)
      expect(result.pricing.input).toBeCloseTo(6 / 7 / 1e6, 14)
      expect(result.pricing.output).toBeCloseTo(24 / 7 / 1e6, 14)
      expect(result.inputCost).toBeCloseTo((20276 * 6) / 7 / 1e6, 12)
      expect(result.outputCost).toBeCloseTo((141 * 24) / 7 / 1e6, 12)
      expect(result.totalCost).toBeCloseTo(0.017862857142857144, 12)
    })

    it('32000 以下继续使用低档价格', () => {
      pricingService.pricingData = pricingService.getGlmFallbackPricing(
        new Date('2026-06-10T00:00:00.000Z')
      )

      const result = pricingService.calculateCost(
        {
          input_tokens: 31999,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        'glm-5.1'
      )

      expect(result.pricing.input).toBeCloseTo(6 / 7 / 1e6, 14)
      expect(result.pricing.output).toBeCloseTo(24 / 7 / 1e6, 14)
      expect(result.pricing.cacheRead).toBeCloseTo(1.3 / 7 / 1e6, 14)
    })

    it('32000 边界应切换到高档价格', () => {
      pricingService.pricingData = pricingService.getGlmFallbackPricing(
        new Date('2026-06-10T00:00:00.000Z')
      )

      const result = pricingService.calculateCost(
        {
          input_tokens: 32000,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10
        },
        'glm-5.1'
      )

      expect(result.pricing.input).toBeCloseTo(8 / 7 / 1e6, 14)
      expect(result.pricing.output).toBeCloseTo(28 / 7 / 1e6, 14)
      expect(result.pricing.cacheRead).toBeCloseTo(2 / 7 / 1e6, 14)
      expect(result.cacheReadCost).toBeCloseTo((10 * 2) / 7 / 1e6, 14)
    })

    it('非 GLM 模型仍保持原有 200K+ 逻辑', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 210000,
          output_tokens: 1000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        'claude-sonnet-4-20250514[1m]'
      )

      expect(result.pricing.input).toBe(0.000003)
      expect(result.pricing.output).toBe(0.000015)
    })

    it('应使用 fallback tier 覆盖旧的 glm-5.1 平铺缓存价格', async () => {
      const stalePricingData = {
        'glm-5.1': {
          input_cost_per_token: 0.0000014,
          output_cost_per_token: 0.0000044,
          cache_read_input_token_cost: 2.8e-7,
          litellm_provider: 'zhipu',
          max_input_tokens: 81920,
          max_output_tokens: 81920,
          max_tokens: 81920,
          mode: 'chat',
          supports_function_calling: true
        }
      }

      const enriched = await pricingService.enrichPricingDataWithGlm(stalePricingData, {
        allowRemote: false
      })

      expect(enriched['glm-5.1'].litellm_provider).toBe('glm')
      expect(enriched['glm-5.1'].provider_specific_entry.pricing_in_cny.tiers).toHaveLength(2)
      expect(enriched['glm-5.1'].input_cost_per_token).toBeCloseTo(6 / 7 / 1e6, 14)
      expect(enriched['glm-5.1'].output_cost_per_token).toBeCloseTo(24 / 7 / 1e6, 14)
    })

    it('应使用 fallback tier 覆盖其它 tiered GLM 的旧平铺缓存价格', async () => {
      const stalePricingData = {
        'glm-5': {
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000004,
          cache_read_input_token_cost: 2e-7,
          litellm_provider: 'zhipu',
          max_input_tokens: 81920,
          max_output_tokens: 81920,
          max_tokens: 81920,
          mode: 'chat',
          supports_function_calling: true
        },
        'glm-4.7': {
          input_cost_per_token: 5e-7,
          output_cost_per_token: 0.000003,
          cache_read_input_token_cost: 1e-7,
          litellm_provider: 'zhipu',
          max_input_tokens: 200000,
          max_output_tokens: 81920,
          max_tokens: 81920,
          mode: 'chat',
          supports_function_calling: true
        }
      }

      const enriched = await pricingService.enrichPricingDataWithGlm(stalePricingData, {
        allowRemote: false
      })

      expect(enriched['glm-5'].provider_specific_entry.pricing_in_cny.tiers).toHaveLength(2)
      expect(enriched['glm-5'].input_cost_per_token).toBeCloseTo(4 / 7 / 1e6, 14)
      expect(enriched['glm-4.7'].provider_specific_entry.pricing_in_cny.tiers).toHaveLength(3)
      expect(enriched['glm-4.7'].input_cost_per_token).toBeCloseTo(2 / 7 / 1e6, 14)
    })

    it('已有 tier 信息的 GLM 条目不应被 fallback 覆盖', async () => {
      const tieredEntry = pricingService.getGlmFallbackPricing(
        new Date('2026-06-10T00:00:00.000Z')
      )['glm-5']
      const stalePricingData = {
        'glm-5': {
          ...tieredEntry,
          input_cost_per_token: 123,
          provider_specific_entry: tieredEntry.provider_specific_entry
        }
      }

      const enriched = await pricingService.enrichPricingDataWithGlm(stalePricingData, {
        allowRemote: false
      })

      expect(enriched['glm-5'].input_cost_per_token).toBe(123)
      expect(enriched['glm-5'].provider_specific_entry.pricing_in_cny.tiers).toHaveLength(2)
    })

    it('缺少任一 tiered GLM 时应补齐 fallback 条目', async () => {
      const partialPricingData = {
        'glm-5.1': pricingService.getGlmFallbackPricing(new Date('2026-06-10T00:00:00.000Z'))[
          'glm-5.1'
        ],
        'glm-4.5': pricingService.getGlmFallbackPricing(new Date('2026-06-10T00:00:00.000Z'))[
          'glm-4.5'
        ],
        'glm-4-plus': pricingService.getGlmFallbackPricing(new Date('2026-06-10T00:00:00.000Z'))[
          'glm-4-plus'
        ],
        'glm-4-flash': pricingService.getGlmFallbackPricing(new Date('2026-06-10T00:00:00.000Z'))[
          'glm-4-flash'
        ]
      }

      const enriched = await pricingService.enrichPricingDataWithGlm(partialPricingData, {
        allowRemote: false
      })

      expect(enriched['glm-5.2']).toBeDefined()
      expect(enriched['glm-5']).toBeDefined()
      expect(enriched['glm-5'].provider_specific_entry.pricing_in_cny.tiers).toHaveLength(2)
      expect(enriched['glm-4.7']).toBeDefined()
      expect(enriched['glm-4.7'].provider_specific_entry.pricing_in_cny.tiers).toHaveLength(3)
    })
  })

  describe('DeepSeek 官方价格', () => {
    const deepseekPricingHtml = `
      <table>
        <tr><td colspan="2">MODEL</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr>
        <tr><td rowspan="3">PRICING</td><td>1M INPUT TOKENS (CACHE HIT)<sup>(2)</sup></td><td>$0.0028</td><td>$0.003625 (75% off<sup>(3)</sup>)<del>$0.0145</del></td></tr>
        <tr><td>1M INPUT TOKENS (CACHE MISS)</td><td>$0.14</td><td>$0.435 (75% off<sup>(3)</sup>)<del>$1.74</del></td></tr>
        <tr><td>1M OUTPUT TOKENS</td><td>$0.28</td><td>$0.87 (75% off<sup>(3)</sup>)<del>$3.48</del></td></tr>
      </table>
      <p>The deepseek-v4-pro model API pricing will be officially adjusted to 1/4 of the original price after the 75% discount promotion ends on 2026/05/31 15:59 UTC.</p>
    `
    const minimaxPricingMarkdown = `
# Pay as You Go

## LLM

<Tabs>
  <Tab title="Standard">
    | Model                                                                                                                                                                                                              | Input                        | Output                       | Prompt caching Read          |
    | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------- | :--------------------------- | :--------------------------- |
    | **MiniMax-M3**<br />≤ 512k input tokens <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300">7-day 50% off</span> | ~~\$0.60~~ \$0.30 / M tokens | ~~\$2.40~~ \$1.20 / M tokens | ~~\$0.12~~ \$0.06 / M tokens |
    | **MiniMax-M3**<br />> 512k input tokens\*                                                                                                                                                                          | \$1.20 / M tokens            | \$4.80 / M tokens            | \$0.24 / M tokens            |
  </Tab>

  <Tab title="Priority*">
    | Model                                                                                                                                                                                                              | Input                        | Output                       | Prompt caching Read          |
    | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------- | :--------------------------- | :--------------------------- |
    | **MiniMax-M3**<br />≤ 512k input tokens <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300">7-day 50% off</span> | ~~\$0.90~~ \$0.45 / M tokens | ~~\$3.60~~ \$1.80 / M tokens | ~~\$0.18~~ \$0.09 / M tokens |
    | **MiniMax-M3**<br />> 512k input tokens                                                                                                                                                                            | \$1.80 / M tokens            | \$7.20 / M tokens            | \$0.36 / M tokens            |
  </Tab>
</Tabs>

| Model                      | Input            | Output           | Prompt caching Read | Prompt caching Write |
| :------------------------- | :--------------- | :--------------- | :------------------ | :------------------- |
| **MiniMax-M2.7**           | \$0.3 / M tokens | \$1.2 / M tokens | \$0.06 / M tokens   | \$0.375 / M tokens   |
| **MiniMax-M2.7-highspeed** | \$0.6 / M tokens | \$2.4 / M tokens | \$0.06 / M tokens   | \$0.375 / M tokens   |

<Accordion title="Legacy Models">
  | Model                      | Input            | Output           | Prompt caching Read | Prompt caching Write |
  | :------------------------- | :--------------- | :--------------- | :------------------ | :------------------- |
  | **MiniMax-M2.5**           | \$0.3 / M tokens | \$1.2 / M tokens | \$0.03 / M tokens   | \$0.375 / M tokens   |
  | **MiniMax-M2.5-highspeed** | \$0.6 / M tokens | \$2.4 / M tokens | \$0.03 / M tokens   | \$0.375 / M tokens   |
  | **MiniMax-M2.1**           | \$0.3 / M tokens | \$1.2 / M tokens | \$0.03 / M tokens   | \$0.375 / M tokens   |
  | **MiniMax-M2.1-highspeed** | \$0.6 / M tokens | \$2.4 / M tokens | \$0.03 / M tokens   | \$0.375 / M tokens   |
  | **MiniMax-M2**             | \$0.3 / M tokens | \$1.2 / M tokens | \$0.03 / M tokens   | \$0.375 / M tokens   |
</Accordion>
    `

    it('应使用 DeepSeek 官方当前有效价', () => {
      const entries = pricingService.parseDeepSeekPricingHtml(
        deepseekPricingHtml,
        new Date('2026-05-01T00:00:00.000Z')
      )

      expect(entries['deepseek-v4-flash'].input_cost_per_token).toBeCloseTo(0.14 / 1e6, 14)
      expect(entries['deepseek-v4-flash'].cache_read_input_token_cost).toBeCloseTo(0.0028 / 1e6, 14)
      expect(entries['deepseek-v4-pro'].input_cost_per_token).toBeCloseTo(0.435 / 1e6, 14)
      expect(entries['deepseek-v4-pro'].output_cost_per_token).toBeCloseTo(0.87 / 1e6, 14)
      expect(entries['deepseek-v4-pro'].pricing_discount_active).toBe(true)
      expect(entries['deepseek-v4-pro'].pricing_discount_ends_at).toBeUndefined()
    })

    it('折扣结束日期后仍应保持 DeepSeek 官方 1/4 价格', () => {
      const entries = pricingService.parseDeepSeekPricingHtml(
        deepseekPricingHtml,
        new Date('2026-06-01T00:00:00.000Z')
      )

      expect(entries['deepseek-v4-pro'].input_cost_per_token).toBeCloseTo(0.435 / 1e6, 14)
      expect(entries['deepseek-v4-pro'].output_cost_per_token).toBeCloseTo(0.87 / 1e6, 14)
      expect(entries['deepseek-v4-pro'].pricing_discount_active).toBe(true)

      const fallbackEntries = pricingService.getDeepSeekFallbackPricing(
        new Date('2026-06-01T00:00:00.000Z')
      )
      expect(fallbackEntries['deepseek-v4-pro'].input_cost_per_token).toBeCloseTo(0.435 / 1e6, 14)
      expect(fallbackEntries['deepseek-v4-pro'].output_cost_per_token).toBeCloseTo(0.87 / 1e6, 14)
    })

    it('应按 cache hit / cache miss 价格计算 DeepSeek Flash 成本', () => {
      pricingService.pricingData = pricingService.getDeepSeekFallbackPricing(
        new Date('2026-05-01T00:00:00.000Z')
      )

      const result = pricingService.calculateCost(
        {
          input_tokens: 6,
          output_tokens: 5,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 0
        },
        'deepseek-v4-flash'
      )

      expect(result.hasPricing).toBe(true)
      expect(result.inputCost).toBeCloseTo(6 * (0.14 / 1e6), 14)
      expect(result.outputCost).toBeCloseTo(5 * (0.28 / 1e6), 14)
      expect(result.cacheReadCost).toBeCloseTo(4 * (0.0028 / 1e6), 14)
      expect(result.totalCost).toBeCloseTo(0.0000022512, 14)
    })

    it('应解析 MiniMax 官方 markdown 价格', () => {
      const entries = pricingService.parseMiniMaxPricingMarkdown(
        minimaxPricingMarkdown,
        new Date('2026-06-05T00:00:00.000Z')
      )

      expect(entries['MiniMax-M3'].pricing_currency).toBe('USD')
      expect(entries['MiniMax-M3'].pricing_source).toBe('minimax_official_docs')
      expect(entries['MiniMax-M3'].source).toBe(
        'https://platform.minimax.io/docs/guides/pricing-paygo.md'
      )
      expect(entries['MiniMax-M3'].source_zh).toBe(
        'https://platform.minimaxi.com/docs/guides/pricing-paygo'
      )
      expect(entries['MiniMax-M3'].input_cost_per_token).toBeCloseTo(0.3 / 1e6, 14)
      expect(entries['MiniMax-M3'].output_cost_per_token).toBeCloseTo(1.2 / 1e6, 14)
      expect(entries['MiniMax-M3'].cache_read_input_token_cost).toBeCloseTo(0.06 / 1e6, 14)
      expect(entries['MiniMax-M3'].input_cost_per_token_above_512k_tokens).toBeCloseTo(
        1.2 / 1e6,
        14
      )
      expect(entries['MiniMax-M3'].output_cost_per_token_above_512k_tokens).toBeCloseTo(
        4.8 / 1e6,
        14
      )
      expect(
        entries['MiniMax-M3'].provider_specific_entry.priority.input_cost_per_token
      ).toBeCloseTo(0.45 / 1e6, 14)
      expect(entries['MiniMax-M2.7'].cache_creation_input_token_cost).toBeCloseTo(0.375 / 1e6, 14)
      expect(entries['MiniMax-M2.5-highspeed'].output_cost_per_token).toBeCloseTo(2.4 / 1e6, 14)
    })

    it('MiniMax fallback 使用当前官方 USD 默认价格', () => {
      const entries = pricingService.getMiniMaxFallbackPricing(new Date('2026-06-05T00:00:00.000Z'))

      expect(entries['MiniMax-M3'].pricing_currency).toBe('USD')
      expect(entries['MiniMax-M3'].pricing_source).toBe('minimax_builtin_fallback')
      expect(entries['MiniMax-M3'].input_cost_per_token).toBeCloseTo(0.3 / 1e6, 14)
      expect(entries['MiniMax-M3'].output_cost_per_token).toBeCloseTo(1.2 / 1e6, 14)
      expect(entries['MiniMax-M3'].input_cost_per_token_above_512k_tokens).toBeCloseTo(
        1.2 / 1e6,
        14
      )
      expect(
        entries['MiniMax-M3'].provider_specific_entry.priority.output_cost_per_token
      ).toBeCloseTo(1.8 / 1e6, 14)
      expect(entries['MiniMax-M2.7-highspeed'].input_cost_per_token).toBeCloseTo(0.6 / 1e6, 14)
      expect(entries['MiniMax-M2.5'].cache_read_input_token_cost).toBeCloseTo(0.03 / 1e6, 14)
    })
  })
})
