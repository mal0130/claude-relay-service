jest.mock('../src/services/pricingService', () => ({
  calculateCost: jest.fn(),
  getModelPricing: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
  database: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

describe('CostCalculator', () => {
  let CostCalculator
  let pricingService
  let logger

  beforeEach(() => {
    jest.resetModules()

    pricingService = require('../src/services/pricingService')
    logger = require('../src/utils/logger')
    CostCalculator = require('../src/utils/costCalculator')

    jest.clearAllMocks()
    pricingService.calculateCost.mockReset()
    pricingService.getModelPricing.mockReset()
  })

  it('uses detailed pricing when pricingService returns a complete result', () => {
    pricingService.calculateCost.mockReturnValue({
      hasPricing: true,
      isLongContextRequest: false,
      inputCost: 0.003,
      outputCost: 0.0075,
      cacheCreateCost: 0.00075,
      cacheReadCost: 0.00003,
      totalCost: 0.01128,
      pricing: {
        input: 0.000003,
        output: 0.000015,
        cacheCreate: 0.00000375,
        cacheRead: 0.0000003
      }
    })

    const result = CostCalculator.calculateCost(
      {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 100,
        cache_creation: {
          ephemeral_5m_input_tokens: 200,
          ephemeral_1h_input_tokens: 0
        }
      },
      'claude-sonnet-4-20250514'
    )

    expect(result.usingDynamicPricing).toBe(true)
    expect(result.pricing.input).toBe(3)
    expect(result.pricing.cacheWrite).toBe(3.75)
    expect(result.costs.total).toBeCloseTo(0.01128, 10)
    expect(result.debug.usedFallbackPricing).toBe(false)
    expect(result.debug.pricingSource).toBe('dynamic')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back to unknown pricing for detailed-cache requests with missing model pricing', () => {
    pricingService.calculateCost.mockReturnValue({
      hasPricing: false,
      totalCost: 0,
      isLongContextRequest: false
    })
    pricingService.getModelPricing.mockReturnValue(null)

    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
      cache_creation: {
        ephemeral_5m_input_tokens: 100,
        ephemeral_1h_input_tokens: 100
      }
    }

    const first = CostCalculator.calculateCost(usage, 'kimi-k2.5')
    const second = CostCalculator.calculateCost(usage, 'kimi-k2.5')

    expect(first.usingDynamicPricing).toBe(false)
    expect(first.pricing.input).toBe(3)
    expect(first.pricing.cacheWrite).toBe(3.75)
    expect(first.costs.total).toBeCloseTo(0.01128, 10)
    expect(first.debug.usedFallbackPricing).toBe(true)
    expect(first.debug.pricingSource).toBe('unknown-fallback')
    expect(second.costs.total).toBeCloseTo(first.costs.total, 10)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toContain('kimi-k2.5')
  })

  it('falls back instead of throwing for unknown long-context models', () => {
    pricingService.calculateCost.mockReturnValue({
      hasPricing: false,
      totalCost: 0,
      isLongContextRequest: false
    })
    pricingService.getModelPricing.mockReturnValue(null)

    const result = CostCalculator.calculateCost(
      {
        input_tokens: 250000,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      'mystery-model[1m]'
    )

    expect(result.usingDynamicPricing).toBe(false)
    expect(result.costs.total).toBeCloseTo(0.765, 10)
    expect(result.debug.usedFallbackPricing).toBe(true)
    expect(result.debug.isLongContextModel).toBe(true)
    expect(result.debug.pricingSource).toBe('unknown-fallback')
  })

  it('keeps the legacy dynamic-pricing path for regular requests', () => {
    pricingService.getModelPricing.mockReturnValue({
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000008,
      cache_creation_input_token_cost: 0.0000025,
      cache_read_input_token_cost: 0.0000002
    })

    const result = CostCalculator.calculateCost(
      {
        input_tokens: 2000,
        output_tokens: 1000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 250
      },
      'glm-5'
    )

    expect(pricingService.calculateCost).not.toHaveBeenCalled()
    expect(result.usingDynamicPricing).toBe(true)
    expect(result.pricing.input).toBe(2)
    expect(result.pricing.output).toBe(8)
    expect(result.costs.total).toBeCloseTo(0.0133, 10)
    expect(result.debug.usedFallbackPricing).toBe(false)
    expect(result.debug.pricingSource).toBe('dynamic')
  })

  it('uses DeepSeek dynamic pricing for regular cache-hit requests', () => {
    pricingService.getModelPricing.mockReturnValue({
      input_cost_per_token: 0.14 / 1_000_000,
      output_cost_per_token: 0.28 / 1_000_000,
      cache_read_input_token_cost: 0.0028 / 1_000_000,
      litellm_provider: 'deepseek'
    })

    const result = CostCalculator.calculateCost(
      {
        input_tokens: 6,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4
      },
      'deepseek-v4-flash'
    )

    expect(pricingService.calculateCost).not.toHaveBeenCalled()
    expect(result.usingDynamicPricing).toBe(true)
    expect(result.pricing.input).toBeCloseTo(0.14, 12)
    expect(result.pricing.output).toBeCloseTo(0.28, 12)
    expect(result.pricing.cacheRead).toBeCloseTo(0.0028, 12)
    expect(result.costs.total).toBeCloseTo(0.0000022512, 14)
    expect(result.debug.pricingSource).toBe('dynamic')
  })

  it('uses MiniMax M3 512K tier pricing for regular requests', () => {
    pricingService.getModelPricing.mockReturnValue({
      input_cost_per_token: 0.3 / 1_000_000,
      output_cost_per_token: 1.2 / 1_000_000,
      cache_creation_input_token_cost: 0.375 / 1_000_000,
      cache_read_input_token_cost: 0.06 / 1_000_000,
      input_cost_per_token_above_512k_tokens: 1.2 / 1_000_000,
      output_cost_per_token_above_512k_tokens: 4.8 / 1_000_000,
      cache_read_input_token_cost_above_512k_tokens: 0.24 / 1_000_000,
      litellm_provider: 'minimax'
    })
    pricingService.calculateCost.mockReturnValue({
      hasPricing: true,
      isLongContextRequest: false,
      inputCost: 0.624,
      outputCost: 0.048,
      cacheCreateCost: 0.001125,
      cacheReadCost: 0.00048,
      totalCost: 0.673605,
      pricing: {
        input: 1.2 / 1_000_000,
        output: 4.8 / 1_000_000,
        cacheCreate: 0.375 / 1_000_000,
        cacheRead: 0.24 / 1_000_000
      }
    })

    const result = CostCalculator.calculateCost(
      {
        input_tokens: 520000,
        output_tokens: 10000,
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: 2000
      },
      'MiniMax-M3'
    )

    expect(pricingService.calculateCost).toHaveBeenCalledTimes(1)
    expect(result.usingDynamicPricing).toBe(true)
    expect(result.pricing.input).toBeCloseTo(1.2, 12)
    expect(result.pricing.output).toBeCloseTo(4.8, 12)
    expect(result.pricing.cacheWrite).toBeCloseTo(0.375, 12)
    expect(result.pricing.cacheRead).toBeCloseTo(0.24, 12)
    expect(result.costs.total).toBeCloseTo(0.673605, 10)
    expect(result.debug.pricingSource).toBe('dynamic')
  })
})
