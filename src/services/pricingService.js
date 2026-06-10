const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')
const pricingSource = require('../../config/pricingSource')
const logger = require('../utils/logger')

const DEEPSEEK_PRICING_SOURCE =
  process.env.DEEPSEEK_PRICING_URL || 'https://api-docs.deepseek.com/quick_start/pricing'
const DEEPSEEK_PRICING_SOURCE_ZH = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
const DEEPSEEK_PRO_DISCOUNT_ENDS_AT = null
const DEEPSEEK_CONTEXT_TOKENS = 1048576
const DEEPSEEK_MAX_OUTPUT_TOKENS = 393216
const DEEPSEEK_FALLBACK_USD_PER_MTOK = {
  flash: {
    cacheRead: 0.0028,
    input: 0.14,
    output: 0.28
  },
  pro: {
    cacheRead: 0.003625,
    input: 0.435,
    output: 0.87,
    listCacheRead: 0.0145,
    listInput: 1.74,
    listOutput: 3.48,
    discountEndsAt: DEEPSEEK_PRO_DISCOUNT_ENDS_AT
  }
}

const MINIMAX_PRICING_SOURCE = 'https://platform.minimax.io/docs/guides/pricing-paygo'
const MINIMAX_PRICING_SOURCE_MD = 'https://platform.minimax.io/docs/guides/pricing-paygo.md'
const MINIMAX_PRICING_SOURCE_ZH = 'https://platform.minimaxi.com/docs/guides/pricing-paygo'
const MINIMAX_CONTEXT_TOKENS_M3 = 1048576
const MINIMAX_CONTEXT_TOKENS_DEFAULT = 131072
const MINIMAX_MAX_OUTPUT_TOKENS = 131072
// Fallback prices in USD per million tokens — synced from current official MiniMax USD pricing
const MINIMAX_FALLBACK_USD_PER_MTOK = {
  m3: {
    cacheRead: 0.06,
    cacheCreate: 0.375,
    input: 0.3,
    output: 1.2,
    inputAbove512k: 1.2,
    outputAbove512k: 4.8,
    cacheReadAbove512k: 0.24,
    priority: {
      input: 0.45,
      output: 1.8,
      cacheRead: 0.09,
      inputAbove512k: 1.8,
      outputAbove512k: 7.2,
      cacheReadAbove512k: 0.36
    }
  },
  m2_7: { cacheRead: 0.06, cacheCreate: 0.375, input: 0.3, output: 1.2 },
  m2_7_highspeed: { cacheRead: 0.06, cacheCreate: 0.375, input: 0.6, output: 2.4 },
  m2_5: { cacheRead: 0.03, cacheCreate: 0.375, input: 0.3, output: 1.2 },
  m2_5_highspeed: { cacheRead: 0.03, cacheCreate: 0.375, input: 0.6, output: 2.4 },
  m2_1: { cacheRead: 0.03, cacheCreate: 0.375, input: 0.3, output: 1.2 },
  m2_1_highspeed: { cacheRead: 0.03, cacheCreate: 0.375, input: 0.6, output: 2.4 },
  m2: { cacheRead: 0.03, cacheCreate: 0.375, input: 0.3, output: 1.2 }
}
const usdPerMillionToUsdPerToken = (usdPerMillionTokens) => usdPerMillionTokens / 1_000_000
const glmCnyPerMillionToUsdPerMillion = (cnyPerMillionTokens) =>
  cnyPerMillionTokens / GLM_CNY_PER_USD

const GLM_PRICING_SOURCE = process.env.GLM_PRICING_URL || 'https://open.bigmodel.cn/pricing'
const GLM_CNY_PER_USD = 7

const KIMI_PRICING_SOURCE_K26 =
  process.env.KIMI_PRICING_URL_K26 || 'https://platform.kimi.ai/docs/pricing/chat-k26'
const KIMI_PRICING_SOURCE_K25 =
  process.env.KIMI_PRICING_URL_K25 || 'https://platform.kimi.ai/docs/pricing/chat-k25'
const KIMI_PRICING_SOURCE_MOONSHOT =
  process.env.KIMI_PRICING_URL_MOONSHOT || 'https://platform.kimi.ai/docs/pricing/chat-v1'
// Built-in fallback prices (USD per million tokens)
const KIMI_FALLBACK_USD_PER_MTOK = {
  k26: { cacheRead: 0.16, input: 0.95, output: 4.0, contextTokens: 262144, maxOutputTokens: 8192 },
  k25: { cacheRead: 0.1, input: 0.6, output: 3.0, contextTokens: 262144, maxOutputTokens: 8192 },
  moonshot8k: { input: 0.2, output: 2.0, contextTokens: 8192, maxOutputTokens: 4096 },
  moonshot32k: { input: 1.0, output: 3.0, contextTokens: 32768, maxOutputTokens: 4096 },
  moonshot128k: { input: 2.0, output: 5.0, contextTokens: 131072, maxOutputTokens: 4096 }
}

const stripHtmlTags = (html) => String(html || '').replace(/<[^>]*>/g, '')

const decodeHtmlEntities = (value) =>
  String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')

const normalizeWhitespace = (value) => decodeHtmlEntities(value).replace(/\s+/g, ' ').trim()

const extractUsdPrices = (html) =>
  [...String(html || '').matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((price) => Number.isFinite(price))

class PricingService {
  constructor() {
    this.dataDir = path.join(process.cwd(), 'data')
    this.pricingFile = path.join(this.dataDir, 'model_pricing.json')
    this.pricingUrl = pricingSource.pricingUrl
    this.hashUrl = pricingSource.hashUrl
    this.fallbackFile = path.join(
      process.cwd(),
      'resources',
      'model-pricing',
      'model_prices_and_context_window.json'
    )
    this.localHashFile = path.join(this.dataDir, 'model_pricing.sha256')
    this.pricingData = null
    this.lastUpdated = null
    this.updateInterval = 24 * 60 * 60 * 1000 // 24小时
    this.hashCheckInterval = 10 * 60 * 1000 // 10分钟哈希校验
    this.fileWatcher = null // 文件监听器
    this.reloadDebounceTimer = null // 防抖定时器
    this.hashCheckTimer = null // 哈希轮询定时器
    this.updateTimer = null // 定时更新任务句柄
    this.hashSyncInProgress = false // 哈希同步状态

    // Claude Prompt Caching 官方倍率（基于输入价格）— 仅作为 model_pricing.json 缺失字段时的兜底
    this.claudeCacheMultipliers = {
      write5m: 1.25,
      write1h: 2,
      read: 0.1
    }

    // Claude 扩展计费特性
    this.claudeFeatureFlags = {
      context1mBeta: 'context-1m-2025-08-07',
      fastModeBeta: 'fast-mode-2026-02-01',
      fastModeSpeed: 'fast'
    }
  }

  _createDeepSeekPricingEntry(options) {
    const {
      cacheReadUsdPerMillion,
      inputUsdPerMillion,
      outputUsdPerMillion,
      source = DEEPSEEK_PRICING_SOURCE,
      now = new Date(),
      discountActive = false,
      discountEndsAt = null,
      listCacheReadUsdPerMillion = null,
      listInputUsdPerMillion = null,
      listOutputUsdPerMillion = null,
      supportsReasoning = true,
      compatibilityAlias = false,
      modelAliasFor = null
    } = options

    const refreshedAt = new Date(now).toISOString()
    const entry = {
      cache_read_input_token_cost: usdPerMillionToUsdPerToken(cacheReadUsdPerMillion),
      input_cost_per_token: usdPerMillionToUsdPerToken(inputUsdPerMillion),
      litellm_provider: 'deepseek',
      max_input_tokens: DEEPSEEK_CONTEXT_TOKENS,
      max_output_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
      max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
      mode: 'chat',
      output_cost_per_token: usdPerMillionToUsdPerToken(outputUsdPerMillion),
      source,
      source_zh: DEEPSEEK_PRICING_SOURCE_ZH,
      pricing_currency: 'USD',
      pricing_source: 'deepseek_official_docs',
      pricing_updated_at: refreshedAt,
      supported_endpoints: ['/v1/chat/completions'],
      supports_function_calling: true,
      supports_native_streaming: true,
      supports_parallel_function_calling: true,
      supports_prompt_caching: true,
      supports_reasoning: supportsReasoning,
      supports_response_schema: true,
      supports_system_messages: true,
      supports_tool_choice: true
    }

    if (discountActive || discountEndsAt) {
      entry.pricing_discount_active = !!discountActive
    }

    if (discountEndsAt) {
      entry.pricing_discount_ends_at = discountEndsAt
    }

    if (listCacheReadUsdPerMillion !== null) {
      entry.list_cache_read_input_token_cost = usdPerMillionToUsdPerToken(
        listCacheReadUsdPerMillion
      )
    }
    if (listInputUsdPerMillion !== null) {
      entry.list_input_cost_per_token = usdPerMillionToUsdPerToken(listInputUsdPerMillion)
    }
    if (listOutputUsdPerMillion !== null) {
      entry.list_output_cost_per_token = usdPerMillionToUsdPerToken(listOutputUsdPerMillion)
    }
    if (compatibilityAlias) {
      entry.compatibility_alias = true
      entry.model_alias_for = modelAliasFor
    }

    return entry
  }

  _createMiniMaxPricingEntry(options) {
    const {
      cacheReadUsdPerMillion,
      cacheCreateUsdPerMillion,
      inputUsdPerMillion,
      outputUsdPerMillion,
      source = MINIMAX_PRICING_SOURCE,
      now = new Date(),
      maxInputTokens = MINIMAX_CONTEXT_TOKENS_DEFAULT,
      supportsReasoning = true,
      pricingSourceName = 'minimax_builtin_fallback',
      pricingCurrency = 'USD',
      inputUsdPerMillionAbove512k = null,
      outputUsdPerMillionAbove512k = null,
      cacheReadUsdPerMillionAbove512k = null,
      providerSpecificEntry = null
    } = options

    const refreshedAt = new Date(now).toISOString()
    const entry = {
      cache_creation_input_token_cost: usdPerMillionToUsdPerToken(cacheCreateUsdPerMillion),
      cache_read_input_token_cost: usdPerMillionToUsdPerToken(cacheReadUsdPerMillion),
      input_cost_per_token: usdPerMillionToUsdPerToken(inputUsdPerMillion),
      litellm_provider: 'minimax',
      max_input_tokens: maxInputTokens,
      max_output_tokens: MINIMAX_MAX_OUTPUT_TOKENS,
      max_tokens: MINIMAX_MAX_OUTPUT_TOKENS,
      mode: 'chat',
      output_cost_per_token: usdPerMillionToUsdPerToken(outputUsdPerMillion),
      source,
      source_zh: MINIMAX_PRICING_SOURCE_ZH,
      pricing_currency: pricingCurrency,
      pricing_source: pricingSourceName,
      pricing_updated_at: refreshedAt,
      supported_endpoints: ['/v1/chat/completions', '/anthropic/v1/messages'],
      supports_function_calling: true,
      supports_native_streaming: true,
      supports_parallel_function_calling: true,
      supports_prompt_caching: true,
      supports_reasoning: supportsReasoning,
      supports_response_schema: true,
      supports_system_messages: true,
      supports_tool_choice: true
    }

    if (inputUsdPerMillionAbove512k !== null) {
      entry.input_cost_per_token_above_512k_tokens = usdPerMillionToUsdPerToken(
        inputUsdPerMillionAbove512k
      )
    }
    if (outputUsdPerMillionAbove512k !== null) {
      entry.output_cost_per_token_above_512k_tokens = usdPerMillionToUsdPerToken(
        outputUsdPerMillionAbove512k
      )
    }
    if (cacheReadUsdPerMillionAbove512k !== null) {
      entry.cache_read_input_token_cost_above_512k_tokens = usdPerMillionToUsdPerToken(
        cacheReadUsdPerMillionAbove512k
      )
    }
    if (providerSpecificEntry && typeof providerSpecificEntry === 'object') {
      entry.provider_specific_entry = providerSpecificEntry
    }

    return entry
  }
  _buildDeepSeekPricingEntries(options = {}) {
    const now = options.now || new Date()
    const discountEndsAt =
      options.discountEndsAt === undefined ? DEEPSEEK_PRO_DISCOUNT_ENDS_AT : options.discountEndsAt
    const flashPrices = options.flash || DEEPSEEK_FALLBACK_USD_PER_MTOK.flash
    const proPrices = options.pro || DEEPSEEK_FALLBACK_USD_PER_MTOK.pro
    const hasDiscountedProPrice =
      Number(proPrices.listCacheRead) > Number(proPrices.cacheRead) ||
      Number(proPrices.listInput) > Number(proPrices.input) ||
      Number(proPrices.listOutput) > Number(proPrices.output)
    const discountActive =
      options.discountActive !== undefined ? options.discountActive : hasDiscountedProPrice
    const activeProPrices = discountActive
      ? proPrices
      : {
          ...proPrices,
          cacheRead: proPrices.listCacheRead || proPrices.cacheRead,
          input: proPrices.listInput || proPrices.input,
          output: proPrices.listOutput || proPrices.output
        }

    const commonOptions = {
      source: options.source || DEEPSEEK_PRICING_SOURCE,
      now
    }

    const flash = this._createDeepSeekPricingEntry({
      ...commonOptions,
      modelName: 'deepseek-v4-flash',
      cacheReadUsdPerMillion: flashPrices.cacheRead,
      inputUsdPerMillion: flashPrices.input,
      outputUsdPerMillion: flashPrices.output,
      supportsReasoning: true
    })
    const pro = this._createDeepSeekPricingEntry({
      ...commonOptions,
      modelName: 'deepseek-v4-pro',
      cacheReadUsdPerMillion: activeProPrices.cacheRead,
      inputUsdPerMillion: activeProPrices.input,
      outputUsdPerMillion: activeProPrices.output,
      listCacheReadUsdPerMillion: proPrices.listCacheRead || null,
      listInputUsdPerMillion: proPrices.listInput || null,
      listOutputUsdPerMillion: proPrices.listOutput || null,
      discountActive,
      discountEndsAt,
      supportsReasoning: true
    })
    const chatAlias = this._createDeepSeekPricingEntry({
      ...commonOptions,
      modelName: 'deepseek-chat',
      cacheReadUsdPerMillion: flashPrices.cacheRead,
      inputUsdPerMillion: flashPrices.input,
      outputUsdPerMillion: flashPrices.output,
      compatibilityAlias: true,
      modelAliasFor: 'deepseek-v4-flash',
      supportsReasoning: false
    })
    const reasonerAlias = this._createDeepSeekPricingEntry({
      ...commonOptions,
      modelName: 'deepseek-reasoner',
      cacheReadUsdPerMillion: flashPrices.cacheRead,
      inputUsdPerMillion: flashPrices.input,
      outputUsdPerMillion: flashPrices.output,
      compatibilityAlias: true,
      modelAliasFor: 'deepseek-v4-flash',
      supportsReasoning: true
    })

    return {
      'deepseek-v4-flash': flash,
      'deepseek-v4-pro': pro,
      'deepseek-chat': chatAlias,
      'deepseek-reasoner': reasonerAlias
    }
  }

  _createGlmPricingEntry(options) {
    const {
      inputUsdPerMillion,
      outputUsdPerMillion,
      cacheReadUsdPerMillion = 0,
      source = GLM_PRICING_SOURCE,
      now = new Date(),
      pricingSourceName = 'glm_builtin_fallback',
      baseEntry = {}
    } = options

    const maxInputTokens = Number(baseEntry.max_input_tokens) || 128000
    const maxOutputTokens =
      Number(baseEntry.max_output_tokens) || Number(baseEntry.max_tokens) || 4096

    return {
      input_cost_per_token: usdPerMillionToUsdPerToken(inputUsdPerMillion),
      output_cost_per_token: usdPerMillionToUsdPerToken(outputUsdPerMillion),
      cache_read_input_token_cost: usdPerMillionToUsdPerToken(cacheReadUsdPerMillion),
      litellm_provider: 'glm',
      max_input_tokens: maxInputTokens,
      max_output_tokens: maxOutputTokens,
      max_tokens: maxOutputTokens,
      mode: 'chat',
      source,
      pricing_currency: 'USD',
      pricing_source: pricingSourceName,
      pricing_updated_at: new Date(now).toISOString(),
      supported_endpoints: ['/v1/chat/completions'],
      supports_function_calling: true,
      ...(baseEntry.provider_specific_entry
        ? { provider_specific_entry: baseEntry.provider_specific_entry }
        : {})
    }
  }

  _matchesGlmTierCondition(condition, usageContext) {
    const normalized = String(condition || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
    const inputInK = usageContext.totalInputTokens / 1000
    const outputInK = usageContext.outputTokens / 1000

    if (!normalized) {
      return false
    }

    if (normalized === 'input < 32k') {
      return usageContext.totalInputTokens < 32000
    }
    if (normalized === 'input >= 32k') {
      return usageContext.totalInputTokens >= 32000
    }
    if (normalized === '32k <= input < 200k') {
      return usageContext.totalInputTokens >= 32000 && usageContext.totalInputTokens < 200000
    }
    if (normalized === '32k <= input < 128k') {
      return usageContext.totalInputTokens >= 32000 && usageContext.totalInputTokens < 128000
    }
    if (normalized === '32k <= input < 64k') {
      return usageContext.totalInputTokens >= 32000 && usageContext.totalInputTokens < 64000
    }
    if (normalized === 'input < 32k && output < 0.2k') {
      return usageContext.totalInputTokens < 32000 && outputInK < 0.2
    }
    if (normalized === 'input < 32k && output >= 0.2k') {
      return usageContext.totalInputTokens < 32000 && outputInK >= 0.2
    }

    const genericCondition = normalized
      .replace(/input/g, String(inputInK))
      .replace(/output/g, String(outputInK))
      .replace(/([0-9]+(?:\.[0-9]+)?)k/g, (_, value) => String(Number(value)))
      .replace(/&&/g, ' && ')

    if (!/^[0-9.\s<>=&-]+$/.test(genericCondition)) {
      return false
    }

    return genericCondition
      .split('&&')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .every((segment) => {
        const chainedMatch = segment.match(/^([0-9.]+)\s*(<=|<)\s*([0-9.]+)\s*(<=|<)\s*([0-9.]+)$/)
        if (chainedMatch) {
          const [, left, op1, middle, op2, right] = chainedMatch
          const leftNum = Number(left)
          const middleNum = Number(middle)
          const rightNum = Number(right)
          const leftPass = op1 === '<=' ? leftNum <= middleNum : leftNum < middleNum
          const rightPass = op2 === '<=' ? middleNum <= rightNum : middleNum < rightNum
          return leftPass && rightPass
        }

        const simpleMatch = segment.match(/^([0-9.]+)\s*(<=|>=|<|>)\s*([0-9.]+)$/)
        if (!simpleMatch) {
          return false
        }

        const [, left, operator, right] = simpleMatch
        const leftNum = Number(left)
        const rightNum = Number(right)
        if (operator === '<') {
          return leftNum < rightNum
        }
        if (operator === '<=') {
          return leftNum <= rightNum
        }
        if (operator === '>') {
          return leftNum > rightNum
        }
        return leftNum >= rightNum
      })
  }

  _resolveGlmTieredPricing(pricing, usageContext) {
    const tiers = pricing?.provider_specific_entry?.pricing_in_cny?.tiers
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return null
    }

    const matchedTier = tiers.find((tier) =>
      this._matchesGlmTierCondition(tier.condition, usageContext)
    )

    if (!matchedTier) {
      return null
    }

    return {
      input: usdPerMillionToUsdPerToken(matchedTier.input_usd_per_million || 0),
      output: usdPerMillionToUsdPerToken(matchedTier.output_usd_per_million || 0),
      cacheRead: usdPerMillionToUsdPerToken(matchedTier.cache_read_usd_per_million || 0)
    }
  }

  _createGlmPricingEntryFromCny(options) {
    const { inputCnyPerMillion, outputCnyPerMillion, cacheReadCnyPerMillion = 0, ...rest } = options

    return this._createGlmPricingEntry({
      ...rest,
      inputUsdPerMillion: glmCnyPerMillionToUsdPerMillion(inputCnyPerMillion),
      outputUsdPerMillion: glmCnyPerMillionToUsdPerMillion(outputCnyPerMillion),
      cacheReadUsdPerMillion: glmCnyPerMillionToUsdPerMillion(cacheReadCnyPerMillion)
    })
  }

  _createGlmTieredPricingEntry(options) {
    const {
      tiers,
      source = GLM_PRICING_SOURCE,
      now = new Date(),
      pricingSourceName = 'glm_builtin_fallback',
      baseEntry = {}
    } = options
    const firstTier = Array.isArray(tiers) && tiers.length > 0 ? tiers[0] : null

    if (!firstTier) {
      throw new Error('GLM tiered pricing requires at least one tier')
    }

    const entry = this._createGlmPricingEntryFromCny({
      inputCnyPerMillion: firstTier.input,
      outputCnyPerMillion: firstTier.output,
      cacheReadCnyPerMillion: firstTier.cacheRead || 0,
      source,
      now,
      pricingSourceName,
      baseEntry
    })

    entry.provider_specific_entry = {
      pricing_in_cny: {
        exchange_rate: GLM_CNY_PER_USD,
        tiers: tiers.map((tier) => ({
          ...tier,
          input_usd_per_million: glmCnyPerMillionToUsdPerMillion(tier.input),
          output_usd_per_million: glmCnyPerMillionToUsdPerMillion(tier.output),
          cache_read_usd_per_million: glmCnyPerMillionToUsdPerMillion(tier.cacheRead || 0)
        }))
      }
    }

    return entry
  }

  _createGlmFlatPricingEntryFromCny(options) {
    const { inputCnyPerMillion, outputCnyPerMillion, cacheReadCnyPerMillion = 0, ...rest } = options

    const entry = this._createGlmPricingEntryFromCny({
      inputCnyPerMillion,
      outputCnyPerMillion,
      cacheReadCnyPerMillion,
      ...rest
    })

    entry.provider_specific_entry = {
      pricing_in_cny: {
        exchange_rate: GLM_CNY_PER_USD,
        input_per_million: inputCnyPerMillion,
        output_per_million: outputCnyPerMillion,
        cache_read_per_million: cacheReadCnyPerMillion
      }
    }

    return entry
  }

  getGlmFallbackPricing(now = new Date()) {
    const source = GLM_PRICING_SOURCE
    return {
      'glm-5.1': this._createGlmTieredPricingEntry({
        tiers: [
          { condition: 'input < 32k', input: 6, cacheRead: 1.3, output: 24 },
          { condition: 'input >= 32k', input: 8, cacheRead: 2, output: 28 }
        ],
        source,
        now
      }),
      'glm-5-turbo': this._createGlmTieredPricingEntry({
        tiers: [
          { condition: 'input < 32k', input: 5, cacheRead: 1.2, output: 22 },
          { condition: 'input >= 32k', input: 7, cacheRead: 1.8, output: 26 }
        ],
        source,
        now
      }),
      'glm-5': this._createGlmTieredPricingEntry({
        tiers: [
          { condition: 'input < 32k', input: 4, cacheRead: 1, output: 18 },
          { condition: 'input >= 32k', input: 6, cacheRead: 1.5, output: 22 }
        ],
        source,
        now
      }),
      'glm-4.7-flashx': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 0.5,
        cacheReadCnyPerMillion: 0.1,
        outputCnyPerMillion: 3,
        source,
        now
      }),
      'glm-4.7-flash': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 0,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 0,
        source,
        now
      }),
      'glm-5v-turbo': this._createGlmTieredPricingEntry({
        tiers: [
          { condition: 'input < 32k', input: 5, cacheRead: 1.2, output: 22 },
          { condition: 'input >= 32k', input: 7, cacheRead: 1.8, output: 26 }
        ],
        source,
        now
      }),
      'glm-4.7': this._createGlmTieredPricingEntry({
        tiers: [
          { condition: 'input < 32k && output < 0.2k', input: 2, cacheRead: 0.4, output: 8 },
          { condition: 'input < 32k && output >= 0.2k', input: 3, cacheRead: 0.6, output: 14 },
          { condition: '32k <= input < 200k', input: 4, cacheRead: 0.8, output: 16 }
        ],
        source,
        now
      }),
      'glm-4.6v-flashx': this._createGlmTieredPricingEntry({
        tiers: [
          { condition: 'input < 32k', input: 0.15, cacheRead: 0.03, output: 1.5 },
          { condition: '32k <= input < 128k', input: 0.3, cacheRead: 0.03, output: 3 }
        ],
        source,
        now
      }),
      'glm-4.6v-flash': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 0,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 0,
        source,
        now
      }),
      'glm-4.6v': this._createGlmTieredPricingEntry({
        tiers: [
          { condition: 'input < 32k', input: 1, cacheRead: 0.2, output: 3 },
          { condition: '32k <= input < 128k', input: 2, cacheRead: 0.4, output: 6 }
        ],
        source,
        now
      }),
      'glm-4.6': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 1,
        cacheReadCnyPerMillion: 0.2,
        outputCnyPerMillion: 3,
        source,
        now
      }),
      'glm-4.5-flash': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 0,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 0,
        source,
        now
      }),
      'glm-4.5-airx': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 1.1,
        cacheReadCnyPerMillion: 0.22,
        outputCnyPerMillion: 4.5,
        source,
        now
      }),
      'glm-4.5-air': this._createGlmTieredPricingEntry({
        tiers: [
          { condition: 'input < 32k && output < 0.2k', input: 0.8, cacheRead: 0.16, output: 2 },
          { condition: 'input < 32k && output >= 0.2k', input: 0.8, cacheRead: 0.16, output: 6 },
          { condition: '32k <= input < 128k', input: 1.2, cacheRead: 0.24, output: 8 }
        ],
        source,
        now
      }),
      'glm-4.5v': this._createGlmTieredPricingEntry({
        tiers: [
          { condition: 'input < 32k', input: 2, cacheRead: 0.4, output: 6 },
          { condition: '32k <= input < 64k', input: 4, cacheRead: 0.8, output: 12 }
        ],
        source,
        now
      }),
      'glm-4.5-x': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 2.2,
        cacheReadCnyPerMillion: 0.45,
        outputCnyPerMillion: 8.9,
        source,
        now
      }),
      'glm-4.5': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 1,
        cacheReadCnyPerMillion: 0.2,
        outputCnyPerMillion: 3,
        source,
        now
      }),
      'glm-4-32b-0414-128k': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 0.1,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 0.1,
        source,
        now
      }),
      'glm-4-flash': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 0,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 0,
        source,
        now
      }),
      'glm-4-flash-250414': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 0,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 0,
        source,
        now
      }),
      'glm-4-plus': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 50,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 50,
        source,
        now
      }),
      'glm-4': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 100,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 100,
        source,
        now
      }),
      'glm-4-long': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 1,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 1,
        source,
        now
      }),
      'glm-4-air': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 0.5,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 0.5,
        source,
        now
      }),
      'glm-4-airx': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 10,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 10,
        source,
        now
      }),
      'glm-z1-flash': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 0,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 0,
        source,
        now
      }),
      'glm-z1': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 20,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 20,
        source,
        now
      }),
      'glm-z1-air': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 3.5,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 3.5,
        source,
        now
      }),
      'glm-z1-airx': this._createGlmFlatPricingEntryFromCny({
        inputCnyPerMillion: 10,
        cacheReadCnyPerMillion: 0,
        outputCnyPerMillion: 10,
        source,
        now
      })
    }
  }

  _extractGlmPriceRow(html, modelLabel) {
    const rows = [...String(html || '').matchAll(/<tr>([\s\S]*?)<\/tr>/gi)]

    for (const [, rowHtml] of rows) {
      const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
        (match) => match[1]
      )
      if (cells.length < 3) {
        continue
      }

      const labelCell = normalizeWhitespace(stripHtmlTags(cells[0]))
      if (labelCell.toUpperCase() === String(modelLabel).toUpperCase()) {
        return cells
      }
    }

    return null
  }

  _parseGlmPriceCell(cellHtml) {
    const text = normalizeWhitespace(stripHtmlTags(cellHtml))
    if (!text) {
      return null
    }
    if (/free/i.test(text)) {
      return 0
    }

    const prices = extractUsdPrices(cellHtml)
    if (prices.length > 0) {
      return prices[0]
    }

    const match = text.match(/([0-9]+(?:\.[0-9]+)?)/)
    return match ? Number(match[1]) : null
  }

  parseGlmPricingHtml(html, now = new Date()) {
    const fallback = this.getGlmFallbackPricing(now)
    const modelMappings = [
      { label: 'GLM-5.1', key: 'glm-5.1' },
      { label: 'GLM-5-Turbo', key: 'glm-5-turbo' },
      { label: 'GLM-5', key: 'glm-5' },
      { label: 'GLM-4.7-FlashX', key: 'glm-4.7-flashx' },
      { label: 'GLM-4.7-Flash', key: 'glm-4.7-flash' },
      { label: 'GLM-4.7', key: 'glm-4.7' },
      { label: 'GLM-4.6V-FlashX', key: 'glm-4.6v-flashx' },
      { label: 'GLM-4.6V', key: 'glm-4.6v' },
      { label: 'GLM-4.6', key: 'glm-4.6' },
      { label: 'GLM-4.5-Flash', key: 'glm-4.5-flash' },
      { label: 'GLM-4.5-AirX', key: 'glm-4.5-airx' },
      { label: 'GLM-4.5-Air', key: 'glm-4.5-air' },
      { label: 'GLM-4.5V', key: 'glm-4.5v' },
      { label: 'GLM-4.5-X', key: 'glm-4.5-x' },
      { label: 'GLM-4.5', key: 'glm-4.5' },
      { label: 'GLM-4-32B-0414-128K', key: 'glm-4-32b-0414-128k' }
    ]

    const pricing = { ...fallback }
    let parsedCount = 0

    for (const { label, key } of modelMappings) {
      const cells = this._extractGlmPriceRow(html, label)
      if (!cells) {
        continue
      }

      const priceCells = cells.slice(1).map((cell) => this._parseGlmPriceCell(cell))
      const input = priceCells[0]
      const cacheRead = Number.isFinite(priceCells[1]) ? priceCells[1] : 0
      const output = [...priceCells].reverse().find((price) => Number.isFinite(price))

      if (!Number.isFinite(input) || !Number.isFinite(output)) {
        throw new Error(`Invalid GLM pricing row for ${label}`)
      }

      pricing[key] = this._createGlmPricingEntry({
        inputUsdPerMillion: input,
        outputUsdPerMillion: output,
        cacheReadUsdPerMillion: Number.isFinite(cacheRead) ? cacheRead : 0,
        source: GLM_PRICING_SOURCE,
        now,
        pricingSourceName: 'glm_official_docs',
        baseEntry: fallback[key]
      })
      parsedCount += 1
    }

    if (parsedCount === 0) {
      throw new Error('GLM pricing table not found')
    }

    return pricing
  }

  async fetchGlmOfficialPricing(now = new Date()) {
    const html = await this._downloadText(GLM_PRICING_SOURCE)
    return this.parseGlmPricingHtml(html, now)
  }

  _isEquivalentGlmPricingEntry(current = {}, next = {}) {
    const comparableFields = [
      'cache_read_input_token_cost',
      'input_cost_per_token',
      'output_cost_per_token',
      'pricing_source'
    ]

    return comparableFields.every((field) => current[field] === next[field])
  }

  _preserveGlmPricingUpdatedAt(currentPricingData = {}, nextPricingData = {}) {
    const preserved = { ...nextPricingData }

    for (const [modelName, nextEntry] of Object.entries(nextPricingData)) {
      if (!String(modelName).toLowerCase().startsWith('glm-')) {
        continue
      }

      const currentEntry = currentPricingData?.[modelName]
      if (
        currentEntry?.pricing_updated_at &&
        this._isEquivalentGlmPricingEntry(currentEntry, nextEntry)
      ) {
        preserved[modelName] = {
          ...nextEntry,
          pricing_updated_at: currentEntry.pricing_updated_at
        }
      }
    }

    return preserved
  }

  getKimiFallbackPricing() {
    const p = KIMI_FALLBACK_USD_PER_MTOK
    const refreshedAt = new Date().toISOString()

    const makeEntry = (
      { input, output, cacheRead = 0, contextTokens, maxOutputTokens },
      source
    ) => ({
      input_cost_per_token: usdPerMillionToUsdPerToken(input),
      output_cost_per_token: usdPerMillionToUsdPerToken(output),
      cache_read_input_token_cost: usdPerMillionToUsdPerToken(cacheRead),
      litellm_provider: 'kimi',
      max_input_tokens: contextTokens,
      max_output_tokens: maxOutputTokens,
      max_tokens: maxOutputTokens,
      mode: 'chat',
      source,
      pricing_currency: 'USD',
      pricing_source: 'kimi_builtin_fallback',
      pricing_updated_at: refreshedAt,
      supported_endpoints: ['/v1/chat/completions'],
      supports_function_calling: true
    })

    const k26Entry = makeEntry(p.k26, KIMI_PRICING_SOURCE_K26)
    const k25Entry = makeEntry(p.k25, KIMI_PRICING_SOURCE_K25)
    const ms8k = makeEntry(p.moonshot8k, KIMI_PRICING_SOURCE_MOONSHOT)
    const ms32k = makeEntry(p.moonshot32k, KIMI_PRICING_SOURCE_MOONSHOT)
    const ms128k = makeEntry(p.moonshot128k, KIMI_PRICING_SOURCE_MOONSHOT)

    return {
      'kimi-k2.6': k26Entry,
      'kimi-k2.5': k25Entry,
      'moonshot-v1-8k': ms8k,
      'moonshot-v1-32k': ms32k,
      'moonshot-v1-128k': ms128k,
      'moonshot-v1-8k-vision-preview': ms8k,
      'moonshot-v1-32k-vision-preview': ms32k,
      'moonshot-v1-128k-vision-preview': ms128k
    }
  }

  _extractKimiPriceRow(html, modelId) {
    const rows = [...String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]

    for (const [, rowHtml] of rows) {
      const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
        (match) => match[1]
      )
      if (cells.length < 2) {
        continue
      }

      const labelCell = normalizeWhitespace(stripHtmlTags(cells[0]))
      if (labelCell.toLowerCase() === String(modelId).toLowerCase()) {
        return cells
      }
    }

    return null
  }

  _extractKimiPriceFromCell(cellHtml) {
    const prices = extractUsdPrices(cellHtml)
    if (prices.length > 0) {
      return prices[0]
    }

    const sourcePriceMatch = String(cellHtml || '').match(/children:\s*\["\$",\s*"([0-9.]+)"\]/)
    if (sourcePriceMatch) {
      return Number(sourcePriceMatch[1])
    }

    const text = normalizeWhitespace(stripHtmlTags(cellHtml))
    const match = text.match(/([0-9]+(?:\.[0-9]+)?)/)
    return match ? Number(match[1]) : null
  }

  _extractKimiContextTokens(cellHtml, fallbackContextTokens) {
    const text = normalizeWhitespace(stripHtmlTags(cellHtml))
    const contextMatch = text.match(/([0-9][0-9,]*)\s*tokens/i)
    return contextMatch ? Number(contextMatch[1].replace(/,/g, '')) : fallbackContextTokens
  }

  _extractKimiSourceRow(html, modelId) {
    const source = String(html || '')
    const startIndex = source.indexOf(String(modelId))

    if (startIndex < 0) {
      return null
    }

    return source.slice(startIndex, startIndex + 1200)
  }

  _parseKimiSourcePrices(rowSource, count) {
    if (!rowSource) {
      return []
    }

    return [
      ...String(rowSource).matchAll(/children:\s*\[\\"\$\\",\s*\\"([0-9]+(?:\.[0-9]+)?)\\"\]/g)
    ]
      .slice(0, count)
      .map((match) => Number(match[1]))
  }

  _buildKimiPricingEntry({
    input,
    output,
    cacheRead = 0,
    contextTokens,
    maxOutputTokens,
    source,
    now
  }) {
    return {
      input_cost_per_token: usdPerMillionToUsdPerToken(input),
      output_cost_per_token: usdPerMillionToUsdPerToken(output),
      cache_read_input_token_cost: usdPerMillionToUsdPerToken(cacheRead),
      litellm_provider: 'kimi',
      max_input_tokens: contextTokens,
      max_output_tokens: maxOutputTokens,
      max_tokens: maxOutputTokens,
      mode: 'chat',
      source,
      pricing_currency: 'USD',
      pricing_source: 'kimi_official_docs',
      pricing_updated_at: new Date(now).toISOString(),
      supported_endpoints: ['/v1/chat/completions'],
      supports_function_calling: true
    }
  }

  _parseKimiK2xPricingHtml(html, modelId, source, now = new Date()) {
    const p = KIMI_FALLBACK_USD_PER_MTOK
    const fallbackCtx = modelId === 'kimi-k2.6' ? p.k26 : p.k25
    const { contextTokens: fallbackContextTokens, maxOutputTokens } = fallbackCtx
    const rowSource = this._extractKimiSourceRow(html, modelId)

    let cacheRead = null
    let input = null
    let output = null
    let contextTokens = fallbackContextTokens

    if (rowSource) {
      const [parsedCacheRead, parsedInput, parsedOutput] = this._parseKimiSourcePrices(rowSource, 3)
      cacheRead = parsedCacheRead
      input = parsedInput
      output = parsedOutput
      contextTokens = this._extractKimiContextTokens(rowSource, fallbackCtx.contextTokens)
    } else {
      const cells = this._extractKimiPriceRow(html, modelId)
      if (!cells || cells.length < 6) {
        throw new Error(`Could not locate pricing row for ${modelId}`)
      }
      cacheRead = this._extractKimiPriceFromCell(cells[2])
      input = this._extractKimiPriceFromCell(cells[3])
      output = this._extractKimiPriceFromCell(cells[4])
      contextTokens = this._extractKimiContextTokens(cells[5], fallbackCtx.contextTokens)
    }

    if (!Number.isFinite(cacheRead) || !Number.isFinite(input) || !Number.isFinite(output)) {
      throw new Error(`Invalid prices for ${modelId}`)
    }

    return {
      modelId,
      entry: this._buildKimiPricingEntry({
        input,
        output,
        cacheRead,
        contextTokens,
        maxOutputTokens,
        source,
        now
      })
    }
  }

  _parseKimiMoonshotPricingHtml(html, source, now = new Date()) {
    const models = [
      { id: 'moonshot-v1-8k', fallback: KIMI_FALLBACK_USD_PER_MTOK.moonshot8k },
      { id: 'moonshot-v1-32k', fallback: KIMI_FALLBACK_USD_PER_MTOK.moonshot32k },
      { id: 'moonshot-v1-128k', fallback: KIMI_FALLBACK_USD_PER_MTOK.moonshot128k },
      {
        id: 'moonshot-v1-8k-vision-preview',
        fallback: KIMI_FALLBACK_USD_PER_MTOK.moonshot8k
      },
      {
        id: 'moonshot-v1-32k-vision-preview',
        fallback: KIMI_FALLBACK_USD_PER_MTOK.moonshot32k
      },
      {
        id: 'moonshot-v1-128k-vision-preview',
        fallback: KIMI_FALLBACK_USD_PER_MTOK.moonshot128k
      }
    ]

    const result = {}

    for (const { id, fallback } of models) {
      const { contextTokens: fallbackContextTokens, maxOutputTokens } = fallback
      const rowSource = this._extractKimiSourceRow(html, id)
      let input = null
      let output = null
      let contextTokens = fallbackContextTokens

      if (rowSource) {
        const [parsedInput, parsedOutput] = this._parseKimiSourcePrices(rowSource, 2)
        input = parsedInput
        output = parsedOutput
        contextTokens = this._extractKimiContextTokens(rowSource, fallback.contextTokens)
      } else {
        const cells = this._extractKimiPriceRow(html, id)
        if (!cells || cells.length < 5) {
          throw new Error(`Could not locate pricing row for ${id}`)
        }
        input = this._extractKimiPriceFromCell(cells[2])
        output = this._extractKimiPriceFromCell(cells[3])
        contextTokens = this._extractKimiContextTokens(cells[4], fallback.contextTokens)
      }

      if (!Number.isFinite(input) || !Number.isFinite(output)) {
        throw new Error(`Invalid prices for ${id}`)
      }

      result[id] = this._buildKimiPricingEntry({
        input,
        output,
        cacheRead: 0,
        contextTokens,
        maxOutputTokens,
        source,
        now
      })
    }

    return result
  }

  // Fetch Kimi pricing from all 3 official pages in parallel.
  // Any page that fails gracefully falls back to built-in prices for that model group.
  async fetchKimiOfficialPricing() {
    const fallback = this.getKimiFallbackPricing()

    const [k26Result, k25Result, moonshotResult] = await Promise.allSettled([
      this._downloadText(KIMI_PRICING_SOURCE_K26),
      this._downloadText(KIMI_PRICING_SOURCE_K25),
      this._downloadText(KIMI_PRICING_SOURCE_MOONSHOT)
    ])

    const pricing = {}

    if (k26Result.status === 'fulfilled') {
      try {
        const { modelId, entry } = this._parseKimiK2xPricingHtml(
          k26Result.value,
          'kimi-k2.6',
          KIMI_PRICING_SOURCE_K26
        )
        pricing[modelId] = entry
        logger.success('Updated Kimi K2.6 pricing from official docs')
      } catch (err) {
        logger.warn(`⚠️  Failed to parse Kimi K2.6 pricing: ${err.message}`)
        pricing['kimi-k2.6'] = fallback['kimi-k2.6']
      }
    } else {
      logger.warn(`⚠️  Failed to fetch Kimi K2.6 pricing page: ${k26Result.reason?.message}`)
      pricing['kimi-k2.6'] = fallback['kimi-k2.6']
    }

    if (k25Result.status === 'fulfilled') {
      try {
        const { modelId, entry } = this._parseKimiK2xPricingHtml(
          k25Result.value,
          'kimi-k2.5',
          KIMI_PRICING_SOURCE_K25
        )
        pricing[modelId] = entry
        logger.success('Updated Kimi K2.5 pricing from official docs')
      } catch (err) {
        logger.warn(`⚠️  Failed to parse Kimi K2.5 pricing: ${err.message}`)
        pricing['kimi-k2.5'] = fallback['kimi-k2.5']
      }
    } else {
      logger.warn(`⚠️  Failed to fetch Kimi K2.5 pricing page: ${k25Result.reason?.message}`)
      pricing['kimi-k2.5'] = fallback['kimi-k2.5']
    }

    if (moonshotResult.status === 'fulfilled') {
      try {
        const moonshotPricing = this._parseKimiMoonshotPricingHtml(
          moonshotResult.value,
          KIMI_PRICING_SOURCE_MOONSHOT
        )
        Object.assign(pricing, moonshotPricing)
        logger.success('Updated Kimi moonshot-v1 pricing from official docs')
      } catch (err) {
        logger.warn(`⚠️  Failed to parse Kimi moonshot-v1 pricing: ${err.message}`)
        for (const key of Object.keys(fallback)) {
          if (key.startsWith('moonshot-')) {
            pricing[key] = fallback[key]
          }
        }
      }
    } else {
      logger.warn(
        `⚠️  Failed to fetch Kimi moonshot-v1 pricing page: ${moonshotResult.reason?.message}`
      )
      for (const key of Object.keys(fallback)) {
        if (key.startsWith('moonshot-')) {
          pricing[key] = fallback[key]
        }
      }
    }

    return pricing
  }

  getDeepSeekFallbackPricing(now = new Date()) {
    return this._buildDeepSeekPricingEntries({
      now,
      discountEndsAt: DEEPSEEK_PRO_DISCOUNT_ENDS_AT,
      source: DEEPSEEK_PRICING_SOURCE
    })
  }

  getMiniMaxFallbackPricing(now = new Date()) {
    const p = MINIMAX_FALLBACK_USD_PER_MTOK
    const common = { source: MINIMAX_PRICING_SOURCE, now }
    const m3 = this._createMiniMaxPricingEntry({
      ...common,
      cacheReadUsdPerMillion: p.m3.cacheRead,
      cacheCreateUsdPerMillion: p.m3.cacheCreate,
      inputUsdPerMillion: p.m3.input,
      outputUsdPerMillion: p.m3.output,
      inputUsdPerMillionAbove512k: p.m3.inputAbove512k,
      outputUsdPerMillionAbove512k: p.m3.outputAbove512k,
      cacheReadUsdPerMillionAbove512k: p.m3.cacheReadAbove512k,
      maxInputTokens: MINIMAX_CONTEXT_TOKENS_M3,
      supportsReasoning: true,
      providerSpecificEntry: {
        priority: {
          input_cost_per_token: usdPerMillionToUsdPerToken(p.m3.priority.input),
          output_cost_per_token: usdPerMillionToUsdPerToken(p.m3.priority.output),
          cache_read_input_token_cost: usdPerMillionToUsdPerToken(p.m3.priority.cacheRead),
          input_cost_per_token_above_512k_tokens: usdPerMillionToUsdPerToken(
            p.m3.priority.inputAbove512k
          ),
          output_cost_per_token_above_512k_tokens: usdPerMillionToUsdPerToken(
            p.m3.priority.outputAbove512k
          ),
          cache_read_input_token_cost_above_512k_tokens: usdPerMillionToUsdPerToken(
            p.m3.priority.cacheReadAbove512k
          )
        }
      }
    })
    const m2_7 = this._createMiniMaxPricingEntry({
      ...common,
      cacheReadUsdPerMillion: p.m2_7.cacheRead,
      cacheCreateUsdPerMillion: p.m2_7.cacheCreate,
      inputUsdPerMillion: p.m2_7.input,
      outputUsdPerMillion: p.m2_7.output,
      supportsReasoning: true
    })
    const m2_7Highspeed = this._createMiniMaxPricingEntry({
      ...common,
      cacheReadUsdPerMillion: p.m2_7_highspeed.cacheRead,
      cacheCreateUsdPerMillion: p.m2_7_highspeed.cacheCreate,
      inputUsdPerMillion: p.m2_7_highspeed.input,
      outputUsdPerMillion: p.m2_7_highspeed.output,
      supportsReasoning: true
    })
    const m2_5 = this._createMiniMaxPricingEntry({
      ...common,
      cacheReadUsdPerMillion: p.m2_5.cacheRead,
      cacheCreateUsdPerMillion: p.m2_5.cacheCreate,
      inputUsdPerMillion: p.m2_5.input,
      outputUsdPerMillion: p.m2_5.output,
      supportsReasoning: true
    })
    const m2_5Highspeed = this._createMiniMaxPricingEntry({
      ...common,
      cacheReadUsdPerMillion: p.m2_5_highspeed.cacheRead,
      cacheCreateUsdPerMillion: p.m2_5_highspeed.cacheCreate,
      inputUsdPerMillion: p.m2_5_highspeed.input,
      outputUsdPerMillion: p.m2_5_highspeed.output,
      supportsReasoning: true
    })
    const m2_1 = this._createMiniMaxPricingEntry({
      ...common,
      cacheReadUsdPerMillion: p.m2_1.cacheRead,
      cacheCreateUsdPerMillion: p.m2_1.cacheCreate,
      inputUsdPerMillion: p.m2_1.input,
      outputUsdPerMillion: p.m2_1.output,
      supportsReasoning: true
    })
    const m2_1Highspeed = this._createMiniMaxPricingEntry({
      ...common,
      cacheReadUsdPerMillion: p.m2_1_highspeed.cacheRead,
      cacheCreateUsdPerMillion: p.m2_1_highspeed.cacheCreate,
      inputUsdPerMillion: p.m2_1_highspeed.input,
      outputUsdPerMillion: p.m2_1_highspeed.output,
      supportsReasoning: true
    })
    const m2 = this._createMiniMaxPricingEntry({
      ...common,
      cacheReadUsdPerMillion: p.m2.cacheRead,
      cacheCreateUsdPerMillion: p.m2.cacheCreate,
      inputUsdPerMillion: p.m2.input,
      outputUsdPerMillion: p.m2.output,
      supportsReasoning: true
    })

    return {
      'MiniMax-M3': m3,
      'MiniMax-M2.7': m2_7,
      'MiniMax-M2.7-highspeed': m2_7Highspeed,
      'MiniMax-M2.5': m2_5,
      'MiniMax-M2.5-highspeed': m2_5Highspeed,
      'MiniMax-M2.1': m2_1,
      'MiniMax-M2.1-highspeed': m2_1Highspeed,
      'MiniMax-M2': m2
    }
  }

  _buildMiniMaxOfficialPricingEntries(options = {}) {
    const now = options.now || new Date()
    const source = options.source || MINIMAX_PRICING_SOURCE_MD
    const standard = options.standard || {}
    const priority = options.priority || null
    const historical = options.historical || {}

    const m3 = this._createMiniMaxPricingEntry({
      cacheReadUsdPerMillion: standard.m3.cacheRead,
      cacheCreateUsdPerMillion: standard.m3.cacheCreate,
      inputUsdPerMillion: standard.m3.input,
      outputUsdPerMillion: standard.m3.output,
      inputUsdPerMillionAbove512k: standard.m3.inputAbove512k,
      outputUsdPerMillionAbove512k: standard.m3.outputAbove512k,
      cacheReadUsdPerMillionAbove512k: standard.m3.cacheReadAbove512k,
      source,
      now,
      maxInputTokens: MINIMAX_CONTEXT_TOKENS_M3,
      supportsReasoning: true,
      pricingSourceName: 'minimax_official_docs',
      pricingCurrency: 'USD',
      providerSpecificEntry: priority
        ? {
            priority: {
              input_cost_per_token: usdPerMillionToUsdPerToken(priority.m3.input),
              output_cost_per_token: usdPerMillionToUsdPerToken(priority.m3.output),
              cache_read_input_token_cost: usdPerMillionToUsdPerToken(priority.m3.cacheRead),
              input_cost_per_token_above_512k_tokens: usdPerMillionToUsdPerToken(
                priority.m3.inputAbove512k
              ),
              output_cost_per_token_above_512k_tokens: usdPerMillionToUsdPerToken(
                priority.m3.outputAbove512k
              ),
              cache_read_input_token_cost_above_512k_tokens: usdPerMillionToUsdPerToken(
                priority.m3.cacheReadAbove512k
              )
            }
          }
        : null
    })
    const m2_7 = this._createMiniMaxPricingEntry({
      cacheReadUsdPerMillion: standard.m2_7.cacheRead,
      cacheCreateUsdPerMillion: standard.m2_7.cacheCreate,
      inputUsdPerMillion: standard.m2_7.input,
      outputUsdPerMillion: standard.m2_7.output,
      source,
      now,
      supportsReasoning: true,
      pricingSourceName: 'minimax_official_docs',
      pricingCurrency: 'USD'
    })
    const m2_7Highspeed = this._createMiniMaxPricingEntry({
      cacheReadUsdPerMillion: standard.m2_7_highspeed.cacheRead,
      cacheCreateUsdPerMillion: standard.m2_7_highspeed.cacheCreate,
      inputUsdPerMillion: standard.m2_7_highspeed.input,
      outputUsdPerMillion: standard.m2_7_highspeed.output,
      source,
      now,
      supportsReasoning: true,
      pricingSourceName: 'minimax_official_docs',
      pricingCurrency: 'USD'
    })
    const m2_5 = this._createMiniMaxPricingEntry({
      cacheReadUsdPerMillion: historical.m2_5.cacheRead,
      cacheCreateUsdPerMillion: historical.m2_5.cacheCreate,
      inputUsdPerMillion: historical.m2_5.input,
      outputUsdPerMillion: historical.m2_5.output,
      source,
      now,
      supportsReasoning: true,
      pricingSourceName: 'minimax_official_docs',
      pricingCurrency: 'USD'
    })
    const m2_5Highspeed = this._createMiniMaxPricingEntry({
      cacheReadUsdPerMillion: historical.m2_5_highspeed.cacheRead,
      cacheCreateUsdPerMillion: historical.m2_5_highspeed.cacheCreate,
      inputUsdPerMillion: historical.m2_5_highspeed.input,
      outputUsdPerMillion: historical.m2_5_highspeed.output,
      source,
      now,
      supportsReasoning: true,
      pricingSourceName: 'minimax_official_docs',
      pricingCurrency: 'USD'
    })
    const m2_1 = this._createMiniMaxPricingEntry({
      cacheReadUsdPerMillion: historical.m2_1.cacheRead,
      cacheCreateUsdPerMillion: historical.m2_1.cacheCreate,
      inputUsdPerMillion: historical.m2_1.input,
      outputUsdPerMillion: historical.m2_1.output,
      source,
      now,
      supportsReasoning: true,
      pricingSourceName: 'minimax_official_docs',
      pricingCurrency: 'USD'
    })
    const m2_1Highspeed = this._createMiniMaxPricingEntry({
      cacheReadUsdPerMillion: historical.m2_1_highspeed.cacheRead,
      cacheCreateUsdPerMillion: historical.m2_1_highspeed.cacheCreate,
      inputUsdPerMillion: historical.m2_1_highspeed.input,
      outputUsdPerMillion: historical.m2_1_highspeed.output,
      source,
      now,
      supportsReasoning: true,
      pricingSourceName: 'minimax_official_docs',
      pricingCurrency: 'USD'
    })
    const m2 = this._createMiniMaxPricingEntry({
      cacheReadUsdPerMillion: historical.m2.cacheRead,
      cacheCreateUsdPerMillion: historical.m2.cacheCreate,
      inputUsdPerMillion: historical.m2.input,
      outputUsdPerMillion: historical.m2.output,
      source,
      now,
      supportsReasoning: true,
      pricingSourceName: 'minimax_official_docs',
      pricingCurrency: 'USD'
    })

    return {
      'MiniMax-M3': m3,
      'MiniMax-M2.7': m2_7,
      'MiniMax-M2.7-highspeed': m2_7Highspeed,
      'MiniMax-M2.5': m2_5,
      'MiniMax-M2.5-highspeed': m2_5Highspeed,
      'MiniMax-M2.1': m2_1,
      'MiniMax-M2.1-highspeed': m2_1Highspeed,
      'MiniMax-M2': m2
    }
  }

  _parseMiniMaxNumericCell(value) {
    const normalized = String(value || '')
      .replace(/~~/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[^0-9.]+/g, ' ')
      .trim()
    const numbers = normalized
      .split(/\s+/)
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item))
    if (numbers.length === 0) {
      return null
    }
    return numbers[numbers.length - 1]
  }

  _extractMiniMaxMarkdownPriceRow(markdown, matcher, occurrence = 0) {
    const rows = String(markdown || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('|'))
      .filter((line) => {
        if (matcher instanceof RegExp) {
          return matcher.test(line)
        }
        return line.includes(String(matcher))
      })

    const row = rows[occurrence] || null
    if (!row) {
      return null
    }

    const cells = row
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)

    if (cells.length < 4) {
      return null
    }

    return {
      input: this._parseMiniMaxNumericCell(cells[1]),
      output: this._parseMiniMaxNumericCell(cells[2]),
      cacheRead: this._parseMiniMaxNumericCell(cells[3]),
      cacheCreate: cells[4] ? this._parseMiniMaxNumericCell(cells[4]) : null
    }
  }

  parseMiniMaxPricingMarkdown(markdown, now = new Date()) {
    const standardM3Base = this._extractMiniMaxMarkdownPriceRow(markdown, /\*\*MiniMax-M3\*\*/, 0)
    const standardM3Long = this._extractMiniMaxMarkdownPriceRow(markdown, /\*\*MiniMax-M3\*\*/, 1)
    const priorityM3Base = this._extractMiniMaxMarkdownPriceRow(markdown, /\*\*MiniMax-M3\*\*/, 2)
    const priorityM3Long = this._extractMiniMaxMarkdownPriceRow(markdown, /\*\*MiniMax-M3\*\*/, 3)
    const m2_7 = this._extractMiniMaxMarkdownPriceRow(markdown, /\*\*MiniMax-M2\.7\*\*/)
    const m2_7Highspeed = this._extractMiniMaxMarkdownPriceRow(
      markdown,
      /\*\*MiniMax-M2\.7-highspeed\*\*/
    )
    const m2_5 = this._extractMiniMaxMarkdownPriceRow(markdown, /\*\*MiniMax-M2\.5\*\*/)
    const m2_5Highspeed = this._extractMiniMaxMarkdownPriceRow(
      markdown,
      /\*\*MiniMax-M2\.5-highspeed\*\*/
    )
    const m2_1 = this._extractMiniMaxMarkdownPriceRow(markdown, /\*\*MiniMax-M2\.1\*\*/)
    const m2_1Highspeed = this._extractMiniMaxMarkdownPriceRow(
      markdown,
      /\*\*MiniMax-M2\.1-highspeed\*\*/
    )
    const m2 = this._extractMiniMaxMarkdownPriceRow(markdown, /\*\*MiniMax-M2\*\*/)

    if (
      !standardM3Base ||
      !standardM3Long ||
      !priorityM3Base ||
      !priorityM3Long ||
      !m2_7 ||
      !m2_7Highspeed ||
      !m2_5 ||
      !m2_5Highspeed ||
      !m2_1 ||
      !m2_1Highspeed ||
      !m2
    ) {
      throw new Error('MiniMax pricing table not found')
    }

    return this._buildMiniMaxOfficialPricingEntries({
      now,
      source: MINIMAX_PRICING_SOURCE_MD,
      standard: {
        m3: {
          input: standardM3Base.input,
          output: standardM3Base.output,
          cacheRead: standardM3Base.cacheRead,
          cacheCreate: standardM3Base.input * 1.25,
          inputAbove512k: standardM3Long.input,
          outputAbove512k: standardM3Long.output,
          cacheReadAbove512k: standardM3Long.cacheRead
        },
        m2_7,
        m2_7_highspeed: m2_7Highspeed
      },
      priority: {
        m3: {
          input: priorityM3Base.input,
          output: priorityM3Base.output,
          cacheRead: priorityM3Base.cacheRead,
          inputAbove512k: priorityM3Long.input,
          outputAbove512k: priorityM3Long.output,
          cacheReadAbove512k: priorityM3Long.cacheRead
        }
      },
      historical: {
        m2_5,
        m2_5_highspeed: m2_5Highspeed,
        m2_1,
        m2_1_highspeed: m2_1Highspeed,
        m2
      }
    })
  }

  async fetchMiniMaxOfficialPricing(now = new Date()) {
    const markdown = await this._downloadText(MINIMAX_PRICING_SOURCE_MD)
    return this.parseMiniMaxPricingMarkdown(markdown, now)
  }

  _hasCompleteMiniMaxPricing(pricingData) {
    const m3 = pricingData?.['MiniMax-M3']
    return m3 && Number(m3.input_cost_per_token) > 0 && Number(m3.output_cost_per_token) > 0
  }

  _preserveMiniMaxPricingUpdatedAt(currentPricingData = {}, nextPricingData = {}) {
    const preserved = { ...nextPricingData }
    const comparableFields = [
      'cache_creation_input_token_cost',
      'cache_read_input_token_cost',
      'input_cost_per_token',
      'output_cost_per_token'
    ]

    for (const [modelName, nextEntry] of Object.entries(nextPricingData)) {
      if (!String(modelName).toLowerCase().startsWith('minimax-')) {
        continue
      }
      const currentEntry = currentPricingData?.[modelName]
      if (
        currentEntry?.pricing_updated_at &&
        comparableFields.every((f) => currentEntry[f] === nextEntry[f])
      ) {
        preserved[modelName] = { ...nextEntry, pricing_updated_at: currentEntry.pricing_updated_at }
      }
    }

    return preserved
  }

  _hasCompleteGlmPricing(pricingData) {
    const fallbackPricing = this.getGlmFallbackPricing()
    const requiredModels = ['glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.5', 'glm-4-plus', 'glm-4-flash']

    return requiredModels.every((modelName) => {
      const currentEntry = pricingData?.[modelName]
      if (!currentEntry) {
        return false
      }

      const fallbackEntry = fallbackPricing[modelName]
      return !this._shouldOverrideWithTieredGlmFallback(modelName, currentEntry, fallbackEntry)
    })
  }

  _shouldOverrideWithTieredGlmFallback(_modelName, currentEntry, fallbackEntry) {
    const fallbackHasTiers =
      Array.isArray(fallbackEntry?.provider_specific_entry?.pricing_in_cny?.tiers) &&
      fallbackEntry.provider_specific_entry.pricing_in_cny.tiers.length > 0
    const currentHasTiers =
      Array.isArray(currentEntry?.provider_specific_entry?.pricing_in_cny?.tiers) &&
      currentEntry.provider_specific_entry.pricing_in_cny.tiers.length > 0

    return fallbackHasTiers && !currentHasTiers
  }

  _mergeGlmFallbackPricing(currentPricingData = {}, fallbackPricing = {}) {
    const merged = { ...currentPricingData }

    for (const [modelName, fallbackEntry] of Object.entries(fallbackPricing)) {
      const currentEntry = currentPricingData?.[modelName]
      if (
        !currentEntry ||
        this._shouldOverrideWithTieredGlmFallback(modelName, currentEntry, fallbackEntry)
      ) {
        merged[modelName] = fallbackEntry
      }
    }

    return merged
  }

  async enrichPricingDataWithGlm(pricingData, options = {}) {
    const enriched = { ...(pricingData || {}) }
    let glmPricing = null

    if (options.allowRemote === true) {
      try {
        glmPricing = await this.fetchGlmOfficialPricing(options.now || new Date())
        logger.success('Updated GLM pricing from official docs')
      } catch (error) {
        logger.warn(`⚠️  Failed to update GLM pricing from official docs: ${error.message}`)
      }
    }

    if (options.forceBuiltIn !== true && !glmPricing && this._hasCompleteGlmPricing(enriched)) {
      logger.info('Keeping existing GLM pricing entries')
      return enriched
    }

    if (!glmPricing) {
      glmPricing = this.getGlmFallbackPricing(options.now || new Date())
      logger.info('💰 Injecting built-in GLM pricing entries')
    }

    glmPricing = this._preserveGlmPricingUpdatedAt(enriched, glmPricing)

    return this._mergeGlmFallbackPricing(enriched, glmPricing)
  }

  _hasCompleteKimiPricing(pricingData) {
    return !!(
      pricingData?.['kimi-k2.6'] &&
      pricingData?.['kimi-k2.5'] &&
      pricingData?.['moonshot-v1-8k']
    )
  }

  async enrichPricingDataWithKimi(pricingData, options = {}) {
    const enriched = { ...(pricingData || {}) }
    let kimiPricing = null

    if (options.allowRemote === true) {
      try {
        kimiPricing = await this.fetchKimiOfficialPricing()
        logger.success('Updated Kimi pricing from official docs')
      } catch (error) {
        logger.warn(`⚠️  Failed to update Kimi pricing from official docs: ${error.message}`)
      }
    }

    if (options.forceBuiltIn !== true && !kimiPricing && this._hasCompleteKimiPricing(enriched)) {
      logger.info('Keeping existing Kimi pricing entries')
      return enriched
    }

    if (!kimiPricing) {
      kimiPricing = this.getKimiFallbackPricing()
      logger.info('💰 Injecting built-in Kimi pricing entries')
    }

    return { ...enriched, ...kimiPricing }
  }

  async enrichPricingDataWithMiniMax(pricingData, options = {}) {
    const enriched = { ...(pricingData || {}) }
    let minimaxPricing = null

    if (options.allowRemote === true) {
      try {
        minimaxPricing = await this.fetchMiniMaxOfficialPricing(options.now || new Date())
        logger.success('Updated MiniMax pricing from official docs')
      } catch (error) {
        logger.warn(`⚠️  Failed to update MiniMax pricing from official docs: ${error.message}`)
      }
    }

    if (
      !minimaxPricing &&
      options.forceBuiltIn !== true &&
      this._hasCompleteMiniMaxPricing(enriched)
    ) {
      logger.info('Keeping existing MiniMax pricing entries')
      return enriched
    }

    if (!minimaxPricing) {
      minimaxPricing = this.getMiniMaxFallbackPricing(options.now || new Date())
      logger.warn('⚠️  Using built-in MiniMax pricing fallback')
    }

    minimaxPricing = this._preserveMiniMaxPricingUpdatedAt(enriched, minimaxPricing)

    return { ...enriched, ...minimaxPricing }
  }

  _extractDeepSeekDiscountEndsAt(html) {
    const text = normalizeWhitespace(stripHtmlTags(html))
    const match = text.match(/until\s+(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})\s+UTC/i)

    if (!match) {
      return null
    }

    const [, year, month, day, hour, minute] = match.map(Number)
    return new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString()
  }

  _extractDeepSeekPriceRow(html, label) {
    const rows = [...String(html || '').matchAll(/<tr>([\s\S]*?)<\/tr>/gi)]

    for (const [, rowHtml] of rows) {
      const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1])
      const labelIndex = cells.findIndex((cell) =>
        normalizeWhitespace(stripHtmlTags(cell)).toUpperCase().includes(label)
      )

      if (labelIndex >= 0 && cells[labelIndex + 1] && cells[labelIndex + 2]) {
        return {
          flashCell: cells[labelIndex + 1],
          proCell: cells[labelIndex + 2]
        }
      }
    }

    return null
  }

  _selectDeepSeekPriceFromCell(cellHtml, useCurrentPrice = true) {
    const prices = extractUsdPrices(cellHtml)
    if (prices.length === 0) {
      return { active: null, list: null }
    }

    const delMatch = String(cellHtml || '').match(/<del[^>]*>\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i)
    const list = delMatch ? Number(delMatch[1]) : null
    return {
      active: useCurrentPrice || list === null ? prices[0] : list,
      list
    }
  }

  parseDeepSeekPricingHtml(html, now = new Date()) {
    const cacheHit = this._extractDeepSeekPriceRow(html, '1M INPUT TOKENS (CACHE HIT)')
    const cacheMiss = this._extractDeepSeekPriceRow(html, '1M INPUT TOKENS (CACHE MISS)')
    const output = this._extractDeepSeekPriceRow(html, '1M OUTPUT TOKENS')

    if (!cacheHit || !cacheMiss || !output) {
      throw new Error('DeepSeek pricing table not found')
    }

    const flash = {
      cacheRead: this._selectDeepSeekPriceFromCell(cacheHit.flashCell, false).active,
      input: this._selectDeepSeekPriceFromCell(cacheMiss.flashCell, false).active,
      output: this._selectDeepSeekPriceFromCell(output.flashCell, false).active
    }
    const discountActive = [cacheHit.proCell, cacheMiss.proCell, output.proCell].some((cell) =>
      /<del[^>]*>/i.test(String(cell || ''))
    )
    const proCacheRead = this._selectDeepSeekPriceFromCell(cacheHit.proCell, discountActive)
    const proInput = this._selectDeepSeekPriceFromCell(cacheMiss.proCell, discountActive)
    const proOutput = this._selectDeepSeekPriceFromCell(output.proCell, discountActive)
    const pro = {
      cacheRead: proCacheRead.active,
      input: proInput.active,
      output: proOutput.active,
      listCacheRead: proCacheRead.list,
      listInput: proInput.list,
      listOutput: proOutput.list
    }

    for (const [model, prices] of Object.entries({ flash, pro })) {
      for (const field of ['cacheRead', 'input', 'output']) {
        if (!Number.isFinite(prices[field])) {
          throw new Error(`Invalid DeepSeek ${model} ${field} price`)
        }
      }
      for (const [field, value] of Object.entries(prices)) {
        if (value !== null && value !== undefined && !Number.isFinite(value)) {
          throw new Error(`Invalid DeepSeek ${model} ${field} price`)
        }
      }
    }

    return this._buildDeepSeekPricingEntries({
      flash,
      pro,
      discountActive,
      discountEndsAt: null,
      now,
      source: DEEPSEEK_PRICING_SOURCE
    })
  }

  _downloadText(url, redirectsRemaining = 3) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location &&
          redirectsRemaining > 0
        ) {
          const nextUrl = new URL(response.headers.location, url).toString()
          response.resume()
          this._downloadText(nextUrl, redirectsRemaining - 1)
            .then(resolve)
            .catch(reject)
          return
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
          return
        }

        const chunks = []
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })

      request.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`))
      })

      request.setTimeout(30000, () => {
        request.destroy()
        reject(new Error('Download timeout after 30 seconds'))
      })
    })
  }

  async fetchDeepSeekOfficialPricing(now = new Date()) {
    const html = await this._downloadText(DEEPSEEK_PRICING_SOURCE)
    return this.parseDeepSeekPricingHtml(html, now)
  }

  _hasCompleteDeepSeekPricing(pricingData) {
    return ['deepseek-v4-flash', 'deepseek-v4-pro'].every((modelName) => {
      const pricing = pricingData?.[modelName]
      return (
        pricing &&
        Number(pricing.input_cost_per_token) > 0 &&
        Number(pricing.output_cost_per_token) > 0
      )
    })
  }

  _isEquivalentDeepSeekPricingEntry(current = {}, next = {}) {
    const comparableFields = [
      'cache_read_input_token_cost',
      'input_cost_per_token',
      'output_cost_per_token',
      'list_cache_read_input_token_cost',
      'list_input_cost_per_token',
      'list_output_cost_per_token',
      'pricing_discount_active',
      'pricing_discount_ends_at',
      'compatibility_alias',
      'model_alias_for'
    ]

    return comparableFields.every((field) => current[field] === next[field])
  }

  _preserveDeepSeekPricingUpdatedAt(currentPricingData = {}, nextPricingData = {}) {
    const preserved = { ...nextPricingData }

    for (const [modelName, nextEntry] of Object.entries(nextPricingData)) {
      if (!modelName.includes('deepseek')) {
        continue
      }

      const currentEntry = currentPricingData?.[modelName]
      if (
        currentEntry?.pricing_updated_at &&
        this._isEquivalentDeepSeekPricingEntry(currentEntry, nextEntry)
      ) {
        preserved[modelName] = {
          ...nextEntry,
          pricing_updated_at: currentEntry.pricing_updated_at
        }
      }
    }

    return preserved
  }

  async enrichPricingDataWithDeepSeek(pricingData, options = {}) {
    const enriched = { ...(pricingData || {}) }
    let deepseekPricing = null

    if (options.allowRemote === true) {
      try {
        deepseekPricing = await this.fetchDeepSeekOfficialPricing(options.now || new Date())
        logger.success('Updated DeepSeek pricing from official docs')
      } catch (error) {
        logger.warn(`⚠️  Failed to update DeepSeek pricing from official docs: ${error.message}`)
      }
    }

    if (
      !deepseekPricing &&
      options.forceBuiltIn !== true &&
      this._hasCompleteDeepSeekPricing(enriched)
    ) {
      logger.info('Keeping existing DeepSeek pricing entries')
      return enriched
    }

    if (!deepseekPricing) {
      deepseekPricing = this.getDeepSeekFallbackPricing(options.now || new Date())
      logger.warn('⚠️  Using built-in DeepSeek pricing fallback')
    }

    deepseekPricing = this._preserveDeepSeekPricingUpdatedAt(enriched, deepseekPricing)

    return { ...enriched, ...deepseekPricing }
  }

  // 初始化价格服务
  async initialize() {
    try {
      // 确保data目录存在
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true })
        logger.info('📁 Created data directory')
      }

      // 检查是否需要下载或更新价格数据
      await this.checkAndUpdatePricing()

      // 初次启动时执行一次哈希校验，确保与远端保持一致
      await this.syncWithRemoteHash()

      // 设置定时更新
      if (this.updateTimer) {
        clearInterval(this.updateTimer)
      }
      this.updateTimer = setInterval(() => {
        this.checkAndUpdatePricing()
      }, this.updateInterval)

      // 设置哈希轮询
      this.setupHashCheck()

      // 设置文件监听器
      this.setupFileWatcher()

      logger.success('Pricing service initialized successfully')
    } catch (error) {
      logger.error('❌ Failed to initialize pricing service:', error)
    }
  }

  // 检查并更新价格数据
  async checkAndUpdatePricing() {
    try {
      const needsUpdate = this.needsUpdate()

      if (needsUpdate) {
        logger.info('🔄 Updating model pricing data...')
        await this.downloadPricingData()
      } else {
        // 如果不需要更新，加载现有数据
        await this.loadPricingData()
      }
    } catch (error) {
      logger.error('❌ Failed to check/update pricing:', error)
      // 如果更新失败，尝试使用fallback
      await this.useFallbackPricing()
    }
  }

  // 检查是否需要更新
  needsUpdate() {
    if (!fs.existsSync(this.pricingFile)) {
      logger.info('📋 Pricing file not found, will download')
      return true
    }

    const stats = fs.statSync(this.pricingFile)
    const fileAge = Date.now() - stats.mtime.getTime()

    if (fileAge > this.updateInterval) {
      logger.info(
        `📋 Pricing file is ${Math.round(fileAge / (60 * 60 * 1000))} hours old, will update`
      )
      return true
    }

    return false
  }

  // 下载价格数据
  async downloadPricingData() {
    try {
      await this._downloadFromRemote()
    } catch (downloadError) {
      logger.warn(`⚠️  Failed to download pricing data: ${downloadError.message}`)
      logger.info('📋 Using local fallback pricing data...')
      await this.useFallbackPricing()
    }
  }

  // 哈希轮询设置
  setupHashCheck() {
    if (this.hashCheckTimer) {
      clearInterval(this.hashCheckTimer)
    }

    this.hashCheckTimer = setInterval(() => {
      this.syncWithRemoteHash()
    }, this.hashCheckInterval)

    logger.info('🕒 已启用价格文件哈希轮询（每10分钟校验一次）')
  }

  // 与远端哈希对比
  async syncWithRemoteHash() {
    if (this.hashSyncInProgress) {
      return
    }

    this.hashSyncInProgress = true
    try {
      const remoteHash = await this.fetchRemoteHash()

      if (!remoteHash) {
        return
      }

      const localHash = this.computeLocalHash()

      if (!localHash) {
        logger.info('📄 本地价格文件缺失，尝试下载最新版本')
        await this.downloadPricingData()
        return
      }

      if (remoteHash !== localHash) {
        logger.info('🔁 检测到远端价格文件更新，开始下载最新数据')
        await this.downloadPricingData()
      }
    } catch (error) {
      logger.warn(`⚠️  哈希校验失败：${error.message}`)
    } finally {
      this.hashSyncInProgress = false
    }
  }

  // 获取远端哈希值
  fetchRemoteHash() {
    return new Promise((resolve, reject) => {
      const request = https.get(this.hashUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`哈希文件获取失败：HTTP ${response.statusCode}`))
          return
        }

        let data = ''
        response.on('data', (chunk) => {
          data += chunk
        })

        response.on('end', () => {
          const hash = data.trim().split(/\s+/)[0]

          if (!hash) {
            reject(new Error('哈希文件内容为空'))
            return
          }

          resolve(hash)
        })
      })

      request.on('error', (error) => {
        reject(new Error(`网络错误：${error.message}`))
      })

      request.setTimeout(30000, () => {
        request.destroy()
        reject(new Error('获取哈希超时（30秒）'))
      })
    })
  }

  // 计算本地文件哈希
  computeLocalHash() {
    if (!fs.existsSync(this.pricingFile)) {
      return null
    }

    if (fs.existsSync(this.localHashFile)) {
      const cached = fs.readFileSync(this.localHashFile, 'utf8').trim()
      if (cached) {
        return cached
      }
    }

    const fileBuffer = fs.readFileSync(this.pricingFile)
    return this.persistLocalHash(fileBuffer)
  }

  // 写入本地哈希文件
  persistLocalHash(content) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')
    fs.writeFileSync(this.localHashFile, `${hash}\n`)
    return hash
  }

  // 实际的下载逻辑
  _downloadFromRemote() {
    return new Promise((resolve, reject) => {
      const request = https.get(this.pricingUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
          return
        }

        const chunks = []
        response.on('data', (chunk) => {
          const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          chunks.push(bufferChunk)
        })

        response.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks)
            const rawContent = buffer.toString('utf8')
            const jsonData = JSON.parse(rawContent)
            let enrichedData = await this.enrichPricingDataWithDeepSeek(jsonData, {
              allowRemote: false
            })
            enrichedData = await this.enrichPricingDataWithMiniMax(enrichedData, {
              allowRemote: false
            })
            enrichedData = await this.enrichPricingDataWithGlm(enrichedData, {
              allowRemote: true
            })
            enrichedData = await this.enrichPricingDataWithKimi(enrichedData, { allowRemote: true })
            const formattedJson = JSON.stringify(enrichedData, null, 2)

            // 保存合并后的价格文件；哈希仍记录主价格镜像原文，避免哈希轮询反复触发。
            fs.writeFileSync(this.pricingFile, formattedJson)
            this.persistLocalHash(buffer)

            // 更新内存中的数据
            this.pricingData = enrichedData
            this.lastUpdated = new Date()

            logger.success(`Downloaded pricing data for ${Object.keys(enrichedData).length} models`)

            // 设置或重新设置文件监听器
            this.setupFileWatcher()

            resolve()
          } catch (error) {
            reject(new Error(`Failed to parse pricing data: ${error.message}`))
          }
        })
      })

      request.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`))
      })

      request.setTimeout(30000, () => {
        request.destroy()
        reject(new Error('Download timeout after 30 seconds'))
      })
    })
  }

  // 加载本地价格数据
  async loadPricingData() {
    try {
      if (fs.existsSync(this.pricingFile)) {
        const data = fs.readFileSync(this.pricingFile, 'utf8')
        let parsed = await this.enrichPricingDataWithDeepSeek(JSON.parse(data), {
          allowRemote: false
        })
        parsed = await this.enrichPricingDataWithMiniMax(parsed, {
          allowRemote: false
        })
        parsed = await this.enrichPricingDataWithGlm(parsed, { allowRemote: false })
        parsed = await this.enrichPricingDataWithKimi(parsed, { allowRemote: false })
        this.pricingData = parsed

        const stats = fs.statSync(this.pricingFile)
        this.lastUpdated = stats.mtime

        logger.info(
          `💰 Loaded pricing data for ${Object.keys(this.pricingData).length} models from cache`
        )
      } else {
        logger.warn('💰 No pricing data file found, will use fallback')
        await this.useFallbackPricing()
      }
    } catch (error) {
      logger.error('❌ Failed to load pricing data:', error)
      await this.useFallbackPricing()
    }
  }

  // 使用fallback价格数据
  async useFallbackPricing() {
    try {
      if (fs.existsSync(this.fallbackFile)) {
        logger.info('📋 Copying fallback pricing data to data directory...')

        // 读取fallback文件
        const fallbackData = fs.readFileSync(this.fallbackFile, 'utf8')
        let jsonData = await this.enrichPricingDataWithDeepSeek(JSON.parse(fallbackData), {
          allowRemote: false,
          forceBuiltIn: true
        })
        jsonData = await this.enrichPricingDataWithMiniMax(jsonData, {
          allowRemote: false,
          forceBuiltIn: true
        })
        jsonData = await this.enrichPricingDataWithGlm(jsonData, {
          allowRemote: false,
          forceBuiltIn: true
        })
        jsonData = await this.enrichPricingDataWithKimi(jsonData, {
          allowRemote: false,
          forceBuiltIn: true
        })

        const formattedJson = JSON.stringify(jsonData, null, 2)

        // 保存到data目录
        fs.writeFileSync(this.pricingFile, formattedJson)
        this.persistLocalHash(formattedJson)

        // 更新内存中的数据
        this.pricingData = jsonData
        this.lastUpdated = new Date()

        // 设置或重新设置文件监听器
        this.setupFileWatcher()

        logger.warn(`⚠️  Using fallback pricing data for ${Object.keys(jsonData).length} models`)
        logger.info(
          '💡 Note: This fallback data may be outdated. The system will try to update from the remote source on next check.'
        )
      } else {
        logger.error('❌ Fallback pricing file not found at:', this.fallbackFile)
        logger.error(
          '❌ Please ensure the resources/model-pricing directory exists with the pricing file'
        )
        this.pricingData = {}
      }
    } catch (error) {
      logger.error('❌ Failed to use fallback pricing data:', error)
      this.pricingData = {}
    }
  }

  // 获取模型价格信息
  getModelPricing(modelName) {
    if (!this.pricingData || !modelName) {
      return null
    }

    // 尝试直接匹配
    if (this.pricingData[modelName]) {
      logger.debug(`💰 Found exact pricing match for ${modelName}`)
      return this.pricingData[modelName]
    }

    // 特殊处理：gpt-5-codex 回退到 gpt-5
    if (modelName === 'gpt-5-codex' && !this.pricingData['gpt-5-codex']) {
      const fallbackPricing = this.pricingData['gpt-5']
      if (fallbackPricing) {
        logger.info(`💰 Using gpt-5 pricing as fallback for ${modelName}`)
        return fallbackPricing
      }
    }

    const deepseekFallback = this.getDeepSeekFallbackPricing()[modelName]
    if (deepseekFallback) {
      logger.info(`💰 Using built-in DeepSeek pricing fallback for ${modelName}`)
      return deepseekFallback
    }

    const minimaxFallback = this.getMiniMaxFallbackPricing()[modelName]
    if (minimaxFallback) {
      logger.info(`💰 Using built-in MiniMax pricing fallback for ${modelName}`)
      return minimaxFallback
    }

    const glmFallback = this.getGlmFallbackPricing()[modelName]
    if (glmFallback) {
      logger.info(`💰 Using built-in GLM pricing fallback for ${modelName}`)
      return glmFallback
    }

    const kimiFallback = this.getKimiFallbackPricing()[modelName]
    if (kimiFallback) {
      logger.info(`💰 Using built-in Kimi pricing fallback for ${modelName}`)
      return kimiFallback
    }

    // 对于Bedrock区域前缀模型（如 us.anthropic.claude-sonnet-4-20250514-v1:0），
    // 尝试去掉区域前缀进行匹配
    if (modelName.includes('.anthropic.') || modelName.includes('.claude')) {
      // 提取不带区域前缀的模型名
      const withoutRegion = modelName.replace(/^(us|eu|apac)\./, '')
      if (this.pricingData[withoutRegion]) {
        logger.debug(
          `💰 Found pricing for ${modelName} by removing region prefix: ${withoutRegion}`
        )
        return this.pricingData[withoutRegion]
      }
    }

    // 尝试模糊匹配（处理版本号等变化，包括点号与连字符互换如 4.6 vs 4-6）
    const normalizedModel = modelName.toLowerCase().replace(/[_.\-]/g, '')

    for (const [key, value] of Object.entries(this.pricingData)) {
      const normalizedKey = key.toLowerCase().replace(/[_.\-]/g, '')
      if (normalizedKey.includes(normalizedModel) || normalizedModel.includes(normalizedKey)) {
        logger.debug(`💰 Found pricing for ${modelName} using fuzzy match: ${key}`)
        return value
      }
    }

    // 对于Bedrock模型，尝试更智能的匹配
    if (modelName.includes('anthropic.claude')) {
      // 提取核心模型名部分（去掉区域和前缀）
      const coreModel = modelName.replace(/^(us|eu|apac)\./, '').replace('anthropic.', '')

      for (const [key, value] of Object.entries(this.pricingData)) {
        if (key.includes(coreModel) || key.replace('anthropic.', '').includes(coreModel)) {
          logger.debug(`💰 Found pricing for ${modelName} using Bedrock core model match: ${key}`)
          return value
        }
      }
    }

    logger.debug(`💰 No pricing found for model: ${modelName}`)
    return null
  }

  // 确保价格对象包含缓存价格
  ensureCachePricing(pricing) {
    if (!pricing) {
      return pricing
    }

    // 如果缺少缓存价格，根据输入价格计算（缓存创建价格通常是输入价格的1.25倍，缓存读取是0.1倍）
    if (!pricing.cache_creation_input_token_cost && pricing.input_cost_per_token) {
      pricing.cache_creation_input_token_cost = pricing.input_cost_per_token * 1.25
    }
    if (!pricing.cache_read_input_token_cost && pricing.input_cost_per_token) {
      pricing.cache_read_input_token_cost = pricing.input_cost_per_token * 0.1
    }
    return pricing
  }

  // 从 usage 对象中提取 beta 特性列表（小写）
  extractBetaFeatures(usage) {
    const features = new Set()
    if (!usage || typeof usage !== 'object') {
      return features
    }

    const requestHeaders = usage.request_headers || usage.requestHeaders || null
    const headerBeta =
      requestHeaders && typeof requestHeaders === 'object'
        ? requestHeaders['anthropic-beta'] ||
          requestHeaders['Anthropic-Beta'] ||
          requestHeaders['ANTHROPIC-BETA']
        : null

    const candidates = [
      usage.anthropic_beta,
      usage.anthropicBeta,
      usage.request_anthropic_beta,
      usage.requestAnthropicBeta,
      usage.beta_header,
      usage.betaHeader,
      usage.beta_features,
      headerBeta
    ]

    const addFeature = (value) => {
      if (!value || typeof value !== 'string') {
        return
      }
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .forEach((item) => features.add(item))
    }

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        candidate.forEach(addFeature)
      } else {
        addFeature(candidate)
      }
    }

    return features
  }

  // 提取请求/响应中的 speed 字段（小写）
  extractSpeedSignal(usage) {
    if (!usage || typeof usage !== 'object') {
      return { responseSpeed: '', requestSpeed: '' }
    }

    const normalize = (value) =>
      typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : ''

    return {
      responseSpeed: normalize(usage.speed),
      requestSpeed: normalize(usage.request_speed || usage.requestSpeed)
    }
  }

  // 去掉模型名中的 [1m] 后缀，便于价格查找
  stripLongContextSuffix(modelName) {
    if (typeof modelName !== 'string') {
      return modelName
    }
    return modelName.replace(/\[1m\]/gi, '').trim()
  }

  // 计算使用费用
  calculateCost(usage, modelName) {
    const normalizedModelName = this.stripLongContextSuffix(modelName)

    // 检查是否为 1M 上下文模型（用户通过 [1m] 后缀主动选择长上下文模式）
    const isLongContextModel = typeof modelName === 'string' && modelName.includes('[1m]')
    let isLongContextRequest = false
    let useLongContextPricing = false
    let useMiniMax512kPricing = false

    // 计算总输入 tokens（用于判断分层阈值）
    const inputTokens = usage.input_tokens || 0
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0
    const cacheReadTokens = usage.cache_read_input_tokens || 0
    const totalInputTokens = inputTokens + cacheCreationTokens + cacheReadTokens

    // 识别 Claude 特性标识
    const betaFeatures = this.extractBetaFeatures(usage)
    const hasContext1mBeta = betaFeatures.has(this.claudeFeatureFlags.context1mBeta)
    const hasFastModeBeta = betaFeatures.has(this.claudeFeatureFlags.fastModeBeta)
    const { responseSpeed, requestSpeed } = this.extractSpeedSignal(usage)
    const hasFastSpeedSignal =
      responseSpeed === this.claudeFeatureFlags.fastModeSpeed ||
      requestSpeed === this.claudeFeatureFlags.fastModeSpeed
    const isFastModeRequest = hasFastModeBeta && hasFastSpeedSignal
    const standardPricing = this.getModelPricing(modelName)
    const pricing = standardPricing
    const isLongContextModeEnabled = isLongContextModel || hasContext1mBeta
    const isMiniMaxProvider =
      typeof pricing?.litellm_provider === 'string' &&
      pricing.litellm_provider.toLowerCase() === 'minimax'
    const isMiniMaxM3 = isMiniMaxProvider && normalizedModelName === 'MiniMax-M3'
    const isGlmProvider =
      typeof pricing?.litellm_provider === 'string' &&
      pricing.litellm_provider.toLowerCase() === 'glm'
    const glmTieredPricing = isGlmProvider
      ? this._resolveGlmTieredPricing(pricing, {
          totalInputTokens,
          outputTokens: usage.output_tokens || 0
        })
      : null
    // Per official Anthropic pricing: all Claude models have flat pricing with no 200K+ premium
    // https://platform.claude.com/docs/en/about-claude/pricing
    const ignores200kLongContextPricing =
      (typeof normalizedModelName === 'string' &&
        normalizedModelName.toLowerCase().includes('claude')) ||
      (typeof standardPricing?.litellm_provider === 'string' &&
        standardPricing.litellm_provider.toLowerCase().includes('anthropic'))

    // Fast Mode 倍率：优先从 provider_specific_entry.fast 读取，默认 6 倍
    const fastMultiplier = isFastModeRequest ? pricing?.provider_specific_entry?.fast || 6 : 1

    // 当 [1m] 模型总输入超过 200K 时，进入 200K+ 计费逻辑
    // 根据 Anthropic 官方文档：当总输入超过 200K 时，整个请求所有 token 类型都使用高档价格
    if (isLongContextModeEnabled && totalInputTokens > 200000) {
      if (ignores200kLongContextPricing) {
        logger.info(
          `💰 Skipping 200K+ pricing for ${modelName}: Claude models use flat pricing regardless of context length`
        )
      } else {
        isLongContextRequest = true
        useLongContextPricing = true
        logger.info(
          `💰 Using 200K+ pricing for ${modelName}: total input tokens = ${totalInputTokens.toLocaleString()}`
        )
      }
    }

    if (isMiniMaxM3 && totalInputTokens > 512 * 1024) {
      useMiniMax512kPricing = true
      logger.info(
        `💰 Using MiniMax 512K+ pricing for ${modelName}: total input tokens = ${totalInputTokens.toLocaleString()}`
      )
    }

    if (!pricing) {
      return {
        inputCost: 0,
        outputCost: 0,
        cacheCreateCost: 0,
        cacheReadCost: 0,
        ephemeral5mCost: 0,
        ephemeral1hCost: 0,
        totalCost: 0,
        hasPricing: false,
        isLongContextRequest: false
      }
    }

    const isClaudeModel =
      (modelName && modelName.toLowerCase().includes('claude')) ||
      (typeof pricing?.litellm_provider === 'string' &&
        pricing.litellm_provider.toLowerCase().includes('anthropic'))

    if (isFastModeRequest && fastMultiplier > 1) {
      logger.info(
        `🚀 Fast mode ${fastMultiplier}x multiplier applied for ${normalizedModelName} (from provider_specific_entry)`
      )
    } else if (isFastModeRequest) {
      logger.warn(
        `⚠️ Fast mode request detected but no fast pricing found for ${normalizedModelName}; fallback to standard profile`
      )
    }

    const baseInputPrice = pricing.input_cost_per_token || 0
    const hasInput200kPrice =
      pricing.input_cost_per_token_above_200k_tokens !== null &&
      pricing.input_cost_per_token_above_200k_tokens !== undefined
    const hasInput512kPrice =
      pricing.input_cost_per_token_above_512k_tokens !== null &&
      pricing.input_cost_per_token_above_512k_tokens !== undefined

    // 确定实际使用的输入价格（普通或分层高档价格）
    // Claude 模型在 200K+ 场景下如果缺少官方字段，按 2 倍输入价兜底
    let actualInputPrice = glmTieredPricing
      ? glmTieredPricing.input
      : useLongContextPricing
        ? hasInput200kPrice
          ? pricing.input_cost_per_token_above_200k_tokens
          : isClaudeModel
            ? baseInputPrice * 2
            : baseInputPrice
        : useMiniMax512kPricing && hasInput512kPrice
          ? pricing.input_cost_per_token_above_512k_tokens
          : baseInputPrice

    const baseOutputPrice = pricing.output_cost_per_token || 0
    const hasOutput200kPrice =
      pricing.output_cost_per_token_above_200k_tokens !== null &&
      pricing.output_cost_per_token_above_200k_tokens !== undefined
    const hasOutput512kPrice =
      pricing.output_cost_per_token_above_512k_tokens !== null &&
      pricing.output_cost_per_token_above_512k_tokens !== undefined
    let actualOutputPrice = glmTieredPricing
      ? glmTieredPricing.output
      : useLongContextPricing
        ? hasOutput200kPrice
          ? pricing.output_cost_per_token_above_200k_tokens
          : baseOutputPrice
        : useMiniMax512kPricing && hasOutput512kPrice
          ? pricing.output_cost_per_token_above_512k_tokens
          : baseOutputPrice

    // 缓存价格：优先从 model_pricing.json 取，Claude 缺失时用倍率兜底
    let actualCacheCreatePrice = 0
    let actualCacheReadPrice = 0
    let actualEphemeral1hPrice = 0

    if (useLongContextPricing) {
      // 200K+：Claude 仅用 above_200k 专用字段，缺失留 0 让下方兜底从 actualInputPrice 推导
      actualCacheCreatePrice = isClaudeModel
        ? pricing.cache_creation_input_token_cost_above_200k_tokens || 0
        : pricing.cache_creation_input_token_cost_above_200k_tokens ||
          pricing.cache_creation_input_token_cost ||
          0
      actualCacheReadPrice = isClaudeModel
        ? pricing.cache_read_input_token_cost_above_200k_tokens || 0
        : pricing.cache_read_input_token_cost_above_200k_tokens ||
          pricing.cache_read_input_token_cost ||
          0
      const has1h200k =
        pricing.cache_creation_input_token_cost_above_1hr_above_200k_tokens !== null &&
        pricing.cache_creation_input_token_cost_above_1hr_above_200k_tokens !== undefined
      actualEphemeral1hPrice = has1h200k
        ? pricing.cache_creation_input_token_cost_above_1hr_above_200k_tokens
        : isClaudeModel
          ? 0
          : pricing.cache_creation_input_token_cost_above_1hr || 0
    } else if (useMiniMax512kPricing) {
      actualCacheCreatePrice = pricing.cache_creation_input_token_cost || 0
      actualCacheReadPrice =
        pricing.cache_read_input_token_cost_above_512k_tokens ||
        pricing.cache_read_input_token_cost ||
        0
      actualEphemeral1hPrice = pricing.cache_creation_input_token_cost_above_1hr || 0
    } else {
      actualCacheCreatePrice = pricing.cache_creation_input_token_cost || 0
      actualCacheReadPrice = glmTieredPricing
        ? glmTieredPricing.cacheRead
        : pricing.cache_read_input_token_cost || 0
      actualEphemeral1hPrice = pricing.cache_creation_input_token_cost_above_1hr || 0
    }

    // Claude 兜底：pricing 字段缺失时用倍率从 actualInputPrice 推导
    // 此时 actualInputPrice 尚未含 fastMultiplier，下方统一应用
    if (isClaudeModel) {
      if (!actualCacheCreatePrice) {
        actualCacheCreatePrice = actualInputPrice * this.claudeCacheMultipliers.write5m
      }
      if (!actualCacheReadPrice) {
        actualCacheReadPrice = actualInputPrice * this.claudeCacheMultipliers.read
      }
      if (!actualEphemeral1hPrice) {
        actualEphemeral1hPrice = actualInputPrice * this.claudeCacheMultipliers.write1h
      }
    }

    // Fast Mode 倍率：统一一次性应用于所有价格
    if (fastMultiplier > 1) {
      actualInputPrice *= fastMultiplier
      actualOutputPrice *= fastMultiplier
      actualCacheCreatePrice *= fastMultiplier
      actualCacheReadPrice *= fastMultiplier
      actualEphemeral1hPrice *= fastMultiplier
    }

    // 计算各项费用
    const inputCost = inputTokens * actualInputPrice
    const outputCost = (usage.output_tokens || 0) * actualOutputPrice

    // 处理缓存费用
    let ephemeral5mCost = 0
    let ephemeral1hCost = 0
    let cacheCreateCost = 0
    let cacheReadCost = 0

    if (usage.cache_creation && typeof usage.cache_creation === 'object') {
      // 有详细的缓存创建数据
      const ephemeral5mTokens = usage.cache_creation.ephemeral_5m_input_tokens || 0
      const ephemeral1hTokens = usage.cache_creation.ephemeral_1h_input_tokens || 0

      // 5分钟缓存使用 cache_creation 价格
      ephemeral5mCost = ephemeral5mTokens * actualCacheCreatePrice

      // 1小时缓存使用 ephemeral_1h 价格
      ephemeral1hCost = ephemeral1hTokens * actualEphemeral1hPrice

      // 总的缓存创建费用
      cacheCreateCost = ephemeral5mCost + ephemeral1hCost
    } else if (cacheCreationTokens) {
      // 旧格式，所有缓存创建 tokens 都按 5 分钟价格计算（向后兼容）
      cacheCreateCost = cacheCreationTokens * actualCacheCreatePrice
      ephemeral5mCost = cacheCreateCost
    }

    // 缓存读取费用
    cacheReadCost = cacheReadTokens * actualCacheReadPrice

    return {
      inputCost,
      outputCost,
      cacheCreateCost,
      cacheReadCost,
      ephemeral5mCost,
      ephemeral1hCost,
      totalCost: inputCost + outputCost + cacheCreateCost + cacheReadCost,
      hasPricing: true,
      isLongContextRequest,
      pricing: {
        input: actualInputPrice,
        output: actualOutputPrice,
        cacheCreate: actualCacheCreatePrice,
        cacheRead: actualCacheReadPrice,
        ephemeral1h: actualEphemeral1hPrice
      }
    }
  }

  // 格式化价格显示
  formatCost(cost) {
    if (cost === 0) {
      return '$0.000000'
    }
    if (cost < 0.000001) {
      return `$${cost.toExponential(2)}`
    }
    if (cost < 0.01) {
      return `$${cost.toFixed(6)}`
    }
    if (cost < 1) {
      return `$${cost.toFixed(4)}`
    }
    return `$${cost.toFixed(2)}`
  }

  getMiniMaxPricingStatus() {
    const minimaxModels = this.pricingData
      ? Object.keys(this.pricingData).filter((m) => /^MiniMax-/i.test(m))
      : []
    const m3Pricing =
      this.pricingData?.['MiniMax-M3'] || this.getMiniMaxFallbackPricing()['MiniMax-M3']

    return {
      modelCount: minimaxModels.length,
      source: m3Pricing.source || MINIMAX_PRICING_SOURCE,
      zhSource: m3Pricing.source_zh || MINIMAX_PRICING_SOURCE_ZH,
      currency: m3Pricing.pricing_currency || 'USD',
      updatedAt: m3Pricing.pricing_updated_at || null
    }
  }

  getGlmPricingStatus() {
    const glmModels = this.pricingData
      ? Object.keys(this.pricingData).filter((m) => m.startsWith('glm-'))
      : []
    const refPricing =
      this.pricingData?.['glm-5.1'] ||
      this.pricingData?.['glm-4.5'] ||
      this.pricingData?.['glm-4-plus'] ||
      this.getGlmFallbackPricing()['glm-4-plus']

    return {
      modelCount: glmModels.length,
      source: refPricing.source || GLM_PRICING_SOURCE,
      currency: refPricing.pricing_currency || 'USD',
      updatedAt: refPricing.pricing_updated_at || null
    }
  }
  getKimiPricingStatus() {
    const kimiModels = this.pricingData
      ? Object.keys(this.pricingData).filter(
          (m) => m.startsWith('moonshot-') || m.startsWith('kimi-k2.')
        )
      : []
    const refPricing =
      this.pricingData?.['kimi-k2.6'] ||
      this.pricingData?.['moonshot-v1-8k'] ||
      this.getKimiFallbackPricing()['kimi-k2.6']

    return {
      modelCount: kimiModels.length,
      source: refPricing.source || KIMI_PRICING_SOURCE_K26,
      currency: refPricing.pricing_currency || 'USD',
      updatedAt: refPricing.pricing_updated_at || null
    }
  }

  getDeepSeekPricingStatus() {
    const deepseekModels = this.pricingData
      ? Object.keys(this.pricingData).filter((modelName) => modelName.includes('deepseek'))
      : []
    const proPricing =
      this.pricingData?.['deepseek-v4-pro'] || this.getDeepSeekFallbackPricing()['deepseek-v4-pro']

    return {
      modelCount: deepseekModels.length,
      source: proPricing.source || DEEPSEEK_PRICING_SOURCE,
      zhSource: proPricing.source_zh || DEEPSEEK_PRICING_SOURCE_ZH,
      currency: proPricing.pricing_currency || 'USD',
      updatedAt: proPricing.pricing_updated_at || null,
      discountActive: proPricing.pricing_discount_active === true,
      discountEndsAt: proPricing.pricing_discount_ends_at || null
    }
  }

  // 获取服务状态
  getStatus() {
    return {
      initialized: this.pricingData !== null,
      lastUpdated: this.lastUpdated,
      modelCount: this.pricingData ? Object.keys(this.pricingData).length : 0,
      nextUpdate: this.lastUpdated
        ? new Date(this.lastUpdated.getTime() + this.updateInterval)
        : null,
      sources: {
        primary: pricingSource.pricingUrl,
        deepseek: this.getDeepSeekPricingStatus(),
        minimax: this.getMiniMaxPricingStatus(),
        glm: this.getGlmPricingStatus(),
        kimi: this.getKimiPricingStatus()
      }
    }
  }

  // 强制更新价格数据
  async forceUpdate() {
    try {
      await this._downloadFromRemote()
      return { success: true, message: 'Pricing data updated successfully' }
    } catch (error) {
      logger.error('❌ Force update failed:', error)
      logger.info('📋 Force update failed, using fallback pricing data...')
      await this.useFallbackPricing()
      return {
        success: false,
        message: `Download failed: ${error.message}. Using fallback pricing data instead.`
      }
    }
  }

  // 设置文件监听器
  setupFileWatcher() {
    try {
      // 如果已有监听器，先关闭
      if (this.fileWatcher) {
        this.fileWatcher.close()
        this.fileWatcher = null
      }

      // 只有文件存在时才设置监听器
      if (!fs.existsSync(this.pricingFile)) {
        logger.debug('💰 Pricing file does not exist yet, skipping file watcher setup')
        return
      }

      // 使用 fs.watchFile 作为更可靠的文件监听方式
      // 它使用轮询，虽然性能稍差，但更可靠
      const watchOptions = {
        persistent: true,
        interval: 60000 // 每60秒检查一次
      }

      // 记录初始的修改时间
      let lastMtime = fs.statSync(this.pricingFile).mtimeMs

      fs.watchFile(this.pricingFile, watchOptions, (curr, _prev) => {
        // 检查文件是否真的被修改了（不仅仅是访问）
        if (curr.mtimeMs !== lastMtime) {
          lastMtime = curr.mtimeMs
          logger.debug(
            `💰 Detected change in pricing file (mtime: ${new Date(curr.mtime).toISOString()})`
          )
          this.handleFileChange()
        }
      })

      // 保存引用以便清理
      this.fileWatcher = {
        close: () => fs.unwatchFile(this.pricingFile)
      }

      logger.info('👁️  File watcher set up for model_pricing.json (polling every 60s)')
    } catch (error) {
      logger.error('❌ Failed to setup file watcher:', error)
    }
  }

  // 处理文件变化（带防抖）
  handleFileChange() {
    // 清除之前的定时器
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer)
    }

    // 设置新的定时器（防抖500ms）
    this.reloadDebounceTimer = setTimeout(async () => {
      logger.info('🔄 Reloading pricing data due to file change...')
      await this.reloadPricingData()
    }, 500)
  }

  // 重新加载价格数据
  async reloadPricingData() {
    try {
      // 验证文件是否存在
      if (!fs.existsSync(this.pricingFile)) {
        logger.warn('💰 Pricing file was deleted, using fallback')
        await this.useFallbackPricing()
        // 重新设置文件监听器（fallback会创建新文件）
        this.setupFileWatcher()
        return
      }

      // 读取文件内容
      const data = fs.readFileSync(this.pricingFile, 'utf8')

      // 尝试解析JSON
      let jsonData = await this.enrichPricingDataWithDeepSeek(JSON.parse(data), {
        allowRemote: false
      })
      jsonData = await this.enrichPricingDataWithMiniMax(jsonData, {
        allowRemote: false
      })
      jsonData = await this.enrichPricingDataWithGlm(jsonData, { allowRemote: false })
      jsonData = await this.enrichPricingDataWithKimi(jsonData, { allowRemote: false })

      // 验证数据结构
      if (typeof jsonData !== 'object' || Object.keys(jsonData).length === 0) {
        throw new Error('Invalid pricing data structure')
      }

      // 更新内存中的数据
      this.pricingData = jsonData
      this.lastUpdated = new Date()

      const modelCount = Object.keys(jsonData).length
      logger.success(`Reloaded pricing data for ${modelCount} models from file`)

      // 显示一些统计信息
      const claudeModels = Object.keys(jsonData).filter((k) => k.includes('claude')).length
      const gptModels = Object.keys(jsonData).filter((k) => k.includes('gpt')).length
      const geminiModels = Object.keys(jsonData).filter((k) => k.includes('gemini')).length

      logger.debug(
        `💰 Model breakdown: Claude=${claudeModels}, GPT=${gptModels}, Gemini=${geminiModels}`
      )
    } catch (error) {
      logger.error('❌ Failed to reload pricing data:', error)
      logger.warn('💰 Keeping existing pricing data in memory')
    }
  }

  // 清理资源
  cleanup() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer)
      this.updateTimer = null
      logger.debug('💰 Pricing update timer cleared')
    }
    if (this.fileWatcher) {
      this.fileWatcher.close()
      this.fileWatcher = null
      logger.debug('💰 File watcher closed')
    }
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    if (this.hashCheckTimer) {
      clearInterval(this.hashCheckTimer)
      this.hashCheckTimer = null
      logger.debug('💰 Hash check timer cleared')
    }
  }
}

module.exports = new PricingService()
