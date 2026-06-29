/**
 * MiniMax 平台功能测试
 * 覆盖范围：minimaxPlatform 工具函数、minimaxAccountService 核心逻辑、minimaxRelayService 辅助方法
 */

// ─────────────────────────────────────────────────────────────
// minimaxPlatform.js 测试
// ─────────────────────────────────────────────────────────────
describe('minimaxPlatform', () => {
  let platform

  beforeEach(() => {
    jest.resetModules()
    platform = require('../src/services/minimaxPlatform')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('normalizeBaseApi', () => {
    test('removes trailing slash', () => {
      expect(platform.normalizeBaseApi('https://api.minimaxi.com/v1/')).toBe(
        'https://api.minimaxi.com/v1'
      )
    })

    test('returns default when empty', () => {
      expect(platform.normalizeBaseApi('')).toBe(platform.MINIMAX_DEFAULT_BASE_API)
    })

    test('returns default when null', () => {
      expect(platform.normalizeBaseApi(null)).toBe(platform.MINIMAX_DEFAULT_BASE_API)
    })

    test('keeps valid url unchanged', () => {
      expect(platform.normalizeBaseApi('https://api.minimaxi.com/v1')).toBe(
        'https://api.minimaxi.com/v1'
      )
    })
  })

  describe('buildChatCompletionsUrl', () => {
    test('appends /chat/completions to /v1 base', () => {
      expect(platform.buildChatCompletionsUrl('https://api.minimaxi.com/v1')).toBe(
        'https://api.minimaxi.com/v1/chat/completions'
      )
    })

    test('handles base without /v1 suffix', () => {
      const result = platform.buildChatCompletionsUrl('https://custom.api.com')
      expect(result).toBe('https://custom.api.com/chat/completions')
    })
  })

  describe('buildAnthropicMessagesUrl', () => {
    test('appends anthropic messages path to /v1 base', () => {
      expect(platform.buildAnthropicMessagesUrl('https://api.minimaxi.com/v1')).toBe(
        'https://api.minimaxi.com/anthropic/v1/messages'
      )
    })

    test('returns as-is when already full anthropic path', () => {
      const url = 'https://api.minimaxi.com/anthropic/v1/messages'
      expect(platform.buildAnthropicMessagesUrl(url)).toBe(url)
    })

    test('appends /messages to /anthropic/v1', () => {
      expect(platform.buildAnthropicMessagesUrl('https://api.minimaxi.com/anthropic/v1')).toBe(
        'https://api.minimaxi.com/anthropic/v1/messages'
      )
    })

    test('appends /v1/messages to /anthropic', () => {
      expect(platform.buildAnthropicMessagesUrl('https://api.minimaxi.com/anthropic')).toBe(
        'https://api.minimaxi.com/anthropic/v1/messages'
      )
    })

    test('handles custom base without recognized suffix', () => {
      const result = platform.buildAnthropicMessagesUrl('https://custom.api.com')
      expect(result).toContain('/anthropic/v1/messages')
    })
  })

  describe('isMiniMaxModel', () => {
    test('returns true for minimax- prefixed model', () => {
      expect(platform.isMiniMaxModel('minimax-m3')).toBe(true)
    })

    test('case-insensitive match', () => {
      expect(platform.isMiniMaxModel('MiniMax-M3')).toBe(true)
    })

    test('returns false for non-minimax model', () => {
      expect(platform.isMiniMaxModel('gpt-4')).toBe(false)
    })

    test('returns false for null/undefined', () => {
      expect(platform.isMiniMaxModel(null)).toBe(false)
      expect(platform.isMiniMaxModel(undefined)).toBe(false)
    })
  })

  describe('normalizeMiniMaxModel', () => {
    test('maps alias minimax-m3 to MiniMax-M3', () => {
      expect(platform.normalizeMiniMaxModel('minimax-m3')).toBe('MiniMax-M3')
    })

    test('maps alias minimax-m2.7 to MiniMax-M2.7', () => {
      expect(platform.normalizeMiniMaxModel('minimax-m2.7')).toBe('MiniMax-M2.7')
    })

    test('returns model as-is when not in aliases', () => {
      expect(platform.normalizeMiniMaxModel('MiniMax-M3')).toBe('MiniMax-M3')
    })

    test('returns default model for empty input', () => {
      expect(platform.normalizeMiniMaxModel('')).toBe(platform.MINIMAX_DEFAULT_MODEL)
    })

    test('returns default model for null', () => {
      expect(platform.normalizeMiniMaxModel(null)).toBe(platform.MINIMAX_DEFAULT_MODEL)
    })
  })

  describe('normalizeMiniMaxUsage', () => {
    test('maps prompt_tokens to input_tokens', () => {
      const result = platform.normalizeMiniMaxUsage({ prompt_tokens: 100, completion_tokens: 50 })
      expect(result.input_tokens).toBe(100)
      expect(result.output_tokens).toBe(50)
    })

    test('subtracts cache_read tokens from input_tokens', () => {
      const result = platform.normalizeMiniMaxUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 30
      })
      expect(result.input_tokens).toBe(70)
      expect(result.cache_read_input_tokens).toBe(30)
    })

    test('handles cached_tokens in prompt_tokens_details', () => {
      const result = platform.normalizeMiniMaxUsage({
        prompt_tokens: 80,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 }
      })
      expect(result.input_tokens).toBe(40)
      expect(result.cache_read_input_tokens).toBe(40)
    })

    test('uses input_tokens field when prompt_tokens missing', () => {
      const result = platform.normalizeMiniMaxUsage({ input_tokens: 200, output_tokens: 100 })
      expect(result.input_tokens).toBe(200)
      expect(result.output_tokens).toBe(100)
    })

    test('returns zeros for empty usage', () => {
      const result = platform.normalizeMiniMaxUsage({})
      expect(result.input_tokens).toBe(0)
      expect(result.output_tokens).toBe(0)
      expect(result.cache_creation_input_tokens).toBe(0)
      expect(result.cache_read_input_tokens).toBe(0)
    })
  })

  describe('normalizeMiniMaxAnthropicUsage', () => {
    test('maps anthropic usage fields', () => {
      const result = platform.normalizeMiniMaxAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5
      })
      expect(result.input_tokens).toBe(100)
      expect(result.output_tokens).toBe(50)
      expect(result.cache_creation_input_tokens).toBe(10)
      expect(result.cache_read_input_tokens).toBe(5)
    })

    test('sums cache_creation ephemeral tokens', () => {
      const result = platform.normalizeMiniMaxAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation: {
          ephemeral_5m_input_tokens: 8,
          ephemeral_1h_input_tokens: 12
        }
      })
      expect(result.cache_creation_input_tokens).toBe(20)
    })

    test('prefers cache_creation_input_tokens over cache_creation object', () => {
      const result = platform.normalizeMiniMaxAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
        cache_creation: {
          ephemeral_5m_input_tokens: 8,
          ephemeral_1h_input_tokens: 12
        }
      })
      expect(result.cache_creation_input_tokens).toBe(30)
    })

    test('returns zeros for empty usage', () => {
      const result = platform.normalizeMiniMaxAnthropicUsage({})
      expect(result.input_tokens).toBe(0)
      expect(result.output_tokens).toBe(0)
      expect(result.cache_creation_input_tokens).toBe(0)
      expect(result.cache_read_input_tokens).toBe(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────
// minimaxAccountService.js 纯逻辑测试（不需要 Redis）
// ─────────────────────────────────────────────────────────────
describe('MiniMaxAccountService — pure logic', () => {
  let service

  beforeEach(() => {
    jest.resetModules()

    jest.doMock('../src/models/redis', () => ({
      getClientSafe: jest.fn(() => ({
        hset: jest.fn(async () => {}),
        hgetall: jest.fn(async () => null),
        sadd: jest.fn(async () => {}),
        srem: jest.fn(async () => {}),
        del: jest.fn(async () => {})
      })),
      addToIndex: jest.fn(async () => {}),
      removeFromIndex: jest.fn(async () => {}),
      getAllIdsByIndex: jest.fn(async () => []),
      batchHgetallChunked: jest.fn(async () => []),
      getDateStringInTimezone: jest.fn(() => '2026-06-10')
    }))
    jest.doMock('../src/utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      success: jest.fn()
    }))
    jest.doMock('../src/utils/upstreamErrorHelper', () => ({
      clearTempUnavailable: jest.fn(async () => {}),
      recordErrorHistory: jest.fn(async () => {})
    }))

    service = require('../src/services/account/minimaxAccountService')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('_processModelMapping', () => {
    test('returns empty object for null input', () => {
      expect(service._processModelMapping(null)).toEqual({})
    })

    test('returns empty object for empty array', () => {
      expect(service._processModelMapping([])).toEqual({})
    })

    test('converts string array to identity mapping', () => {
      expect(service._processModelMapping(['MiniMax-M3', 'MiniMax-M2.7'])).toEqual({
        'MiniMax-M3': 'MiniMax-M3',
        'MiniMax-M2.7': 'MiniMax-M2.7'
      })
    })

    test('returns object as-is', () => {
      const mapping = { 'minimax-m3': 'MiniMax-M3' }
      expect(service._processModelMapping(mapping)).toEqual(mapping)
    })

    test('filters out non-string entries in array', () => {
      expect(service._processModelMapping(['valid-model', null, '', 42])).toEqual({
        'valid-model': 'valid-model'
      })
    })
  })

  describe('isModelSupported', () => {
    test('returns true when mapping is empty (no restriction)', () => {
      expect(service.isModelSupported({}, 'any-model')).toBe(true)
    })

    test('returns true when mapping is null', () => {
      expect(service.isModelSupported(null, 'any-model')).toBe(true)
    })

    test('returns true for exact key match', () => {
      expect(service.isModelSupported({ 'MiniMax-M3': 'MiniMax-M3' }, 'MiniMax-M3')).toBe(true)
    })

    test('returns true for case-insensitive key match', () => {
      expect(service.isModelSupported({ 'MiniMax-M3': 'MiniMax-M3' }, 'minimax-m3')).toBe(true)
    })

    test('returns false when model not in mapping', () => {
      expect(service.isModelSupported({ 'MiniMax-M3': 'MiniMax-M3' }, 'gpt-4')).toBe(false)
    })
  })

  describe('getMappedModel', () => {
    test('returns requestedModel when mapping is empty', () => {
      expect(service.getMappedModel({}, 'MiniMax-M3')).toBe('MiniMax-M3')
    })

    test('returns mapped value for exact key match', () => {
      expect(service.getMappedModel({ 'minimax-m3': 'MiniMax-M3' }, 'minimax-m3')).toBe(
        'MiniMax-M3'
      )
    })

    test('case-insensitive key lookup returns mapped value', () => {
      expect(service.getMappedModel({ 'MiniMax-M3': 'MiniMax-M3-prod' }, 'minimax-m3')).toBe(
        'MiniMax-M3-prod'
      )
    })

    test('returns original model when not found in mapping', () => {
      expect(service.getMappedModel({ 'MiniMax-M3': 'MiniMax-M3' }, 'gpt-4')).toBe('gpt-4')
    })

    test('returns requestedModel when mapping is null', () => {
      expect(service.getMappedModel(null, 'my-model')).toBe('my-model')
    })
  })

  describe('createAccount — validation', () => {
    test('throws when apiKey is missing', async () => {
      await expect(service.createAccount({ name: 'Test' })).rejects.toThrow(
        'API Key is required for MiniMax account'
      )
    })

    test('creates account and returns masked apiKey', async () => {
      const redis = require('../src/models/redis')
      redis.getClientSafe.mockReturnValue({
        hset: jest.fn(async () => {}),
        sadd: jest.fn(async () => {})
      })

      const result = await service.createAccount({ apiKey: 'sk-test-key', name: 'Test Account' })
      expect(result.apiKey).toBe('***')
      expect(result.name).toBe('Test Account')
      expect(result.platform).toBe('minimax')
    })
  })

  describe('_getRateLimitInfo', () => {
    test('returns not rate limited when rateLimitStatus is not limited', () => {
      const result = service._getRateLimitInfo({ rateLimitStatus: '' })
      expect(result.isRateLimited).toBe(false)
    })

    test('computes remaining minutes from rateLimitResetAt in future', () => {
      const futureTime = new Date(Date.now() + 5 * 60 * 1000).toISOString()
      const result = service._getRateLimitInfo({
        rateLimitStatus: 'limited',
        rateLimitResetAt: futureTime
      })
      expect(result.isRateLimited).toBe(true)
      expect(result.remainingMinutes).toBeGreaterThan(0)
    })

    test('returns not rate limited when reset time is in the past', () => {
      const pastTime = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      const result = service._getRateLimitInfo({
        rateLimitStatus: 'limited',
        rateLimitResetAt: pastTime
      })
      expect(result.isRateLimited).toBe(false)
    })

    test('falls back to rateLimitedAt + duration', () => {
      const rateLimitedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      const result = service._getRateLimitInfo({
        rateLimitStatus: 'limited',
        rateLimitedAt,
        rateLimitDuration: '60'
      })
      expect(result.isRateLimited).toBe(true)
      expect(result.remainingMinutes).toBeGreaterThan(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────
// minimaxRelayService.js 辅助方法单元测试
// ─────────────────────────────────────────────────────────────
describe('MiniMaxRelayService — helper methods', () => {
  let svc

  beforeEach(() => {
    jest.resetModules()

    // Mock all heavy dependencies
    jest.doMock('axios', () => ({ post: jest.fn(), isCancel: jest.fn(() => false) }))
    jest.doMock('../src/utils/proxyHelper', () => ({ createProxyAgent: jest.fn() }))
    jest.doMock('../src/utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }))
    jest.doMock('../config/config', () => ({
      requestTimeout: 600000,
      logging: { truncate: true }
    }))
    jest.doMock('../src/utils/headerFilter', () => ({
      filterForClaude: jest.fn((h) => h),
      filterForOpenAI: jest.fn((h) => h)
    }))
    jest.doMock('../src/utils/sseParser', () => ({
      IncrementalSSEParser: class {
        feed() {
          return []
        }
        getRemaining() {
          return ''
        }
      }
    }))
    jest.doMock('../src/utils/rateLimitHelper', () => ({
      updateRateLimitCounters: jest.fn(async () => {})
    }))
    jest.doMock('../src/utils/requestDetailHelper', () => ({
      createRequestDetailMeta: jest.fn(() => ({})),
      buildCompletionUsageSummary: jest.fn(() => ({})),
      formatCompletionUsageLog: jest.fn(() => '')
    }))
    jest.doMock('../src/utils/userInputExtractor', () => ({
      buildUsageMetadata: jest.fn(() => ({})),
      buildInputMessagesBlock: jest.fn(() => null)
    }))
    jest.doMock('../src/services/apiKeyService', () => ({
      hasPermission: jest.fn(() => true),
      recordUsageWithDetails: jest.fn(async () => ({ realCost: 0 }))
    }))
    jest.doMock('../src/services/account/minimaxAccountService', () => ({
      getAccount: jest.fn(async () => null),
      getMappedModel: jest.fn((mapping, model) => model),
      updateUsageQuota: jest.fn(async () => {})
    }))
    jest.doMock('../src/services/scheduler/unifiedMinimaxScheduler', () => ({
      selectAccountForApiKey: jest.fn(async () => ({ accountId: 'acc-1' })),
      isAccountRateLimited: jest.fn(async () => false),
      removeAccountRateLimit: jest.fn(async () => {}),
      markAccountUnauthorized: jest.fn(async () => {}),
      markAccountRateLimited: jest.fn(async () => {}),
      clearSessionMapping: jest.fn(async () => {})
    }))
    jest.doMock('../src/utils/upstreamErrorHelper', () => {
      const actual = jest.requireActual('../src/utils/upstreamErrorHelper')
      return {
        ...actual,
        markTempUnavailable: jest.fn(async () => {})
      }
    })

    svc = require('../src/services/relay/minimaxRelayService')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('_normalizeRequestModel', () => {
    test('returns model when provided', () => {
      expect(svc._normalizeRequestModel('MiniMax-M3')).toBe('MiniMax-M3')
    })

    test('returns MINIMAX_DEFAULT_MODEL when model is null', () => {
      const { MINIMAX_DEFAULT_MODEL } = require('../src/services/minimaxPlatform')
      expect(svc._normalizeRequestModel(null)).toBe(MINIMAX_DEFAULT_MODEL)
    })

    test('returns MINIMAX_DEFAULT_MODEL when model is undefined', () => {
      const { MINIMAX_DEFAULT_MODEL } = require('../src/services/minimaxPlatform')
      expect(svc._normalizeRequestModel(undefined)).toBe(MINIMAX_DEFAULT_MODEL)
    })
  })

  describe('_isModelRestricted', () => {
    test('returns false when enableModelRestriction is false', () => {
      const apiKeyData = {
        enableModelRestriction: false,
        restrictedModels: ['MiniMax-M3']
      }
      expect(svc._isModelRestricted(apiKeyData, 'MiniMax-M3')).toBe(false)
    })

    test('returns false when restrictedModels is empty', () => {
      const apiKeyData = { enableModelRestriction: true, restrictedModels: [] }
      expect(svc._isModelRestricted(apiKeyData, 'MiniMax-M3')).toBe(false)
    })

    test('returns true when model is in restrictedModels', () => {
      const apiKeyData = {
        enableModelRestriction: true,
        restrictedModels: ['MiniMax-M3']
      }
      expect(svc._isModelRestricted(apiKeyData, 'MiniMax-M3')).toBe(true)
    })

    test('returns false when model is not in restrictedModels', () => {
      const apiKeyData = {
        enableModelRestriction: true,
        restrictedModels: ['MiniMax-M2.7']
      }
      expect(svc._isModelRestricted(apiKeyData, 'MiniMax-M3')).toBe(false)
    })

    test('returns falsy when apiKeyData is null', () => {
      expect(svc._isModelRestricted(null, 'MiniMax-M3')).toBeFalsy()
    })
  })

  describe('_buildRequestBody', () => {
    test('sets mapped model on body', () => {
      const body = { model: 'minimax-m3', messages: [] }
      const result = svc._buildRequestBody(body, 'MiniMax-M3')
      expect(result.model).toBe('MiniMax-M3')
    })

    test('adds stream_options.include_usage for streaming requests', () => {
      const body = { model: 'minimax-m3', messages: [], stream: true }
      const result = svc._buildRequestBody(body, 'MiniMax-M3')
      expect(result.stream_options).toMatchObject({ include_usage: true })
    })

    test('does not add stream_options for non-streaming requests', () => {
      const body = { model: 'minimax-m3', messages: [], stream: false }
      const result = svc._buildRequestBody(body, 'MiniMax-M3')
      expect(result.stream_options).toBeUndefined()
    })

    test('merges existing stream_options', () => {
      const body = {
        model: 'minimax-m3',
        messages: [],
        stream: true,
        stream_options: { custom_field: true }
      }
      const result = svc._buildRequestBody(body, 'MiniMax-M3')
      expect(result.stream_options).toMatchObject({ include_usage: true, custom_field: true })
    })
  })

  describe('_buildAnthropicRequestBody', () => {
    test('sets mapped model on body', () => {
      const body = { model: 'minimax-m3', messages: [] }
      const result = svc._buildAnthropicRequestBody(body, 'MiniMax-M3')
      expect(result.model).toBe('MiniMax-M3')
    })

    test('does not mutate original body', () => {
      const body = { model: 'minimax-m3', messages: [] }
      svc._buildAnthropicRequestBody(body, 'MiniMax-M3')
      expect(body.model).toBe('minimax-m3')
    })
  })

  describe('_extractAnthropicUsage', () => {
    test('extracts usage from top-level data', () => {
      const result = svc._extractAnthropicUsage({ usage: { input_tokens: 10 } })
      expect(result).toEqual({ input_tokens: 10 })
    })

    test('extracts usage from data.message', () => {
      const result = svc._extractAnthropicUsage({
        message: { usage: { input_tokens: 20 } }
      })
      expect(result).toEqual({ input_tokens: 20 })
    })

    test('returns null when no usage', () => {
      expect(svc._extractAnthropicUsage({})).toBeNull()
    })

    test('returns null for null data', () => {
      expect(svc._extractAnthropicUsage(null)).toBeNull()
    })
  })

  describe('_mergeAnthropicUsage', () => {
    test('merges two usage objects', () => {
      const result = svc._mergeAnthropicUsage(
        { input_tokens: 10, output_tokens: 5 },
        { output_tokens: 20, cache_read_input_tokens: 3 }
      )
      expect(result.input_tokens).toBe(10)
      expect(result.output_tokens).toBe(20)
      expect(result.cache_read_input_tokens).toBe(3)
    })

    test('merges cache_creation deeply', () => {
      const result = svc._mergeAnthropicUsage(
        { cache_creation: { ephemeral_5m_input_tokens: 5 } },
        { cache_creation: { ephemeral_1h_input_tokens: 10 } }
      )
      expect(result.cache_creation).toMatchObject({
        ephemeral_5m_input_tokens: 5,
        ephemeral_1h_input_tokens: 10
      })
    })

    test('returns current when partial is null', () => {
      const current = { input_tokens: 10 }
      expect(svc._mergeAnthropicUsage(current, null)).toBe(current)
    })

    test('initializes from partial when current is null', () => {
      const result = svc._mergeAnthropicUsage(null, { input_tokens: 5 })
      expect(result.input_tokens).toBe(5)
    })
  })

  describe('_extractAnthropicModel', () => {
    test('extracts model from data.message.model', () => {
      expect(svc._extractAnthropicModel({ message: { model: 'MiniMax-M3' } })).toBe('MiniMax-M3')
    })

    test('extracts model from data.model', () => {
      expect(svc._extractAnthropicModel({ model: 'MiniMax-M2.7' })).toBe('MiniMax-M2.7')
    })

    test('returns fallback when no model in data', () => {
      expect(svc._extractAnthropicModel({}, 'fallback-model')).toBe('fallback-model')
    })
  })

  describe('_collectOpenAIStreamResponse', () => {
    test('accumulates content from delta', () => {
      const state = { choices: new Map() }
      svc._collectOpenAIStreamResponse(
        { choices: [{ index: 0, delta: { content: 'hello' } }] },
        state
      )
      svc._collectOpenAIStreamResponse(
        { choices: [{ index: 0, delta: { content: ' world' } }] },
        state
      )
      expect(state.choices.get(0).message.content).toBe('hello world')
    })

    test('stores id, created, model from first chunk', () => {
      const state = { choices: new Map() }
      svc._collectOpenAIStreamResponse(
        {
          id: 'cmpl-1',
          created: 1234567890,
          model: 'MiniMax-M3',
          choices: []
        },
        state
      )
      expect(state.id).toBe('cmpl-1')
      expect(state.created).toBe(1234567890)
      expect(state.model).toBe('MiniMax-M3')
    })

    test('ignores non-object data', () => {
      const state = { choices: new Map() }
      expect(() => svc._collectOpenAIStreamResponse(null, state)).not.toThrow()
      expect(() => svc._collectOpenAIStreamResponse('text', state)).not.toThrow()
    })

    test('sets finish_reason from choice', () => {
      const state = { choices: new Map() }
      svc._collectOpenAIStreamResponse(
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        state
      )
      expect(state.choices.get(0).finish_reason).toBe('stop')
    })
  })

  describe('_buildOpenAIStreamResponse', () => {
    test('returns null when nothing collected', () => {
      const state = { choices: new Map() }
      const result = svc._buildOpenAIStreamResponse(state, null, 'MiniMax-M3')
      expect(result).toBeNull()
    })

    test('builds response from collected state', () => {
      const state = {
        id: 'cmpl-1',
        created: 1234,
        model: 'MiniMax-M3',
        choices: new Map([
          [
            0,
            {
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop'
            }
          ]
        ])
      }
      const result = svc._buildOpenAIStreamResponse(state, null, 'MiniMax-M3')
      expect(result.id).toBe('cmpl-1')
      expect(result.choices[0].message.content).toBe('hello')
      expect(result.choices[0].finish_reason).toBe('stop')
    })
  })

  describe('handleChatCompletions — permission check', () => {
    test('returns 403 when missing minimax permission', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      apiKeyService.hasPermission.mockReturnValue(false)

      const req = {
        apiKey: { permissions: ['claude'] },
        body: { model: 'MiniMax-M3' },
        headers: {},
        once: jest.fn(),
        on: jest.fn()
      }
      const res = {
        headersSent: false,
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }

      await svc.handleChatCompletions(req, res)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ code: 'permission_denied' }) })
      )
    })

    test('returns 403 when model is restricted', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      apiKeyService.hasPermission.mockReturnValue(true)

      const req = {
        apiKey: {
          permissions: ['minimax'],
          enableModelRestriction: true,
          restrictedModels: ['MiniMax-M3']
        },
        body: { model: 'MiniMax-M3' },
        headers: {},
        once: jest.fn(),
        on: jest.fn()
      }
      const res = {
        headersSent: false,
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }

      await svc.handleChatCompletions(req, res)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ code: 'model_not_allowed' }) })
      )
    })
  })

  describe('handleAnthropicMessages — permission check', () => {
    test('returns 403 when missing minimax permission', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      apiKeyService.hasPermission.mockReturnValue(false)

      const req = {
        apiKey: { permissions: ['claude'] },
        body: { model: 'MiniMax-M3', messages: [] },
        headers: {},
        once: jest.fn(),
        on: jest.fn()
      }
      const res = {
        headersSent: false,
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }

      await svc.handleAnthropicMessages(req, res)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          error: expect.objectContaining({ type: 'permission_error' })
        })
      )
    })
  })

  describe('_parseJsonSafe', () => {
    test('parses valid JSON', () => {
      expect(svc._parseJsonSafe('{"key":"val"}')).toEqual({ key: 'val' })
    })

    test('returns null for invalid JSON', () => {
      expect(svc._parseJsonSafe('not-json')).toBeNull()
    })
  })

  describe('_getHeaderValue', () => {
    test('finds header case-insensitively', () => {
      expect(svc._getHeaderValue({ 'Anthropic-Version': '2023-06-01' }, 'anthropic-version')).toBe(
        '2023-06-01'
      )
    })

    test('returns null when header not found', () => {
      expect(svc._getHeaderValue({ other: 'value' }, 'missing')).toBeNull()
    })

    test('handles array header values', () => {
      expect(svc._getHeaderValue({ 'x-custom': ['first', 'second'] }, 'x-custom')).toBe('first')
    })
  })

  describe('handleChatCompletions — forwarding paths', () => {
    test('forwards non-stream requests to json handler with mapped model', async () => {
      const crypto = require('crypto')
      const axios = require('axios')
      const platform = require('../src/services/minimaxPlatform')
      const minimaxAccountService = require('../src/services/account/minimaxAccountService')
      const unifiedMiniMaxScheduler = require('../src/services/scheduler/unifiedMinimaxScheduler')

      minimaxAccountService.getAccount.mockResolvedValue({
        id: 'acc-1',
        name: 'MiniMax A',
        apiKey: 'secret-key',
        baseApi: 'https://api.minimaxi.com/v1',
        supportedModels: { 'MiniMax-M3': 'MiniMax-M3-High' },
        proxy: null
      })
      minimaxAccountService.getMappedModel.mockReturnValue('MiniMax-M3-High')

      const upstreamResponse = { status: 200, data: { ok: true } }
      axios.post.mockResolvedValue(upstreamResponse)

      const jsonHandlerSpy = jest
        .spyOn(svc, '_handleJsonResponse')
        .mockResolvedValue({ handled: 'json' })
      const streamHandlerSpy = jest.spyOn(svc, '_handleStreamResponse').mockResolvedValue(null)

      const req = {
        apiKey: { id: 'key-1', permissions: ['minimax'] },
        body: { model: 'MiniMax-M3', messages: [] },
        headers: { 'x-session-id': 'sess-1' },
        once: jest.fn(),
        on: jest.fn()
      }
      const res = {
        once: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }

      const result = await svc.handleChatCompletions(req, res)
      const sessionHash = crypto.createHash('sha256').update('sess-1').digest('hex')

      expect(unifiedMiniMaxScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
        req.apiKey,
        sessionHash,
        'MiniMax-M3'
      )
      expect(axios.post).toHaveBeenCalledWith(
        platform.buildChatCompletionsUrl('https://api.minimaxi.com/v1'),
        expect.objectContaining({ model: 'MiniMax-M3-High' }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer secret-key',
            'Content-Type': 'application/json',
            'accept-encoding': 'identity'
          }),
          timeout: 600000
        })
      )
      expect(streamHandlerSpy).not.toHaveBeenCalled()
      expect(jsonHandlerSpy).toHaveBeenCalledWith(
        req,
        res,
        expect.objectContaining({
          upstreamResponse,
          accountId: 'acc-1',
          requestedModel: 'MiniMax-M3',
          sessionHash
        })
      )
      expect(result).toEqual({ handled: 'json' })
    })

    test('forwards stream requests to stream handler and configures proxy agent', async () => {
      const crypto = require('crypto')
      const axios = require('axios')
      const proxyHelper = require('../src/utils/proxyHelper')
      const minimaxAccountService = require('../src/services/account/minimaxAccountService')

      const proxyAgent = { kind: 'agent' }
      proxyHelper.createProxyAgent.mockReturnValue(proxyAgent)
      minimaxAccountService.getAccount.mockResolvedValue({
        id: 'acc-1',
        name: 'MiniMax Stream',
        apiKey: 'secret-key',
        baseApi: 'https://api.minimaxi.com/v1',
        supportedModels: {},
        proxy: { url: 'http://127.0.0.1:7890' }
      })

      const upstreamResponse = { status: 200, data: { on: jest.fn() } }
      axios.post.mockResolvedValue(upstreamResponse)

      const streamHandlerSpy = jest
        .spyOn(svc, '_handleStreamResponse')
        .mockResolvedValue({ handled: 'stream' })

      const req = {
        apiKey: { id: 'key-1', permissions: ['minimax'] },
        body: {
          model: 'MiniMax-M3',
          messages: [],
          stream: true,
          stream_options: { foo: 'bar' }
        },
        headers: { session_id: 'sess-2' },
        once: jest.fn(),
        on: jest.fn()
      }
      const res = {
        once: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }

      const result = await svc.handleChatCompletions(req, res)
      const sessionHash = crypto.createHash('sha256').update('sess-2').digest('hex')
      const requestConfig = axios.post.mock.calls[0][2]

      expect(requestConfig.responseType).toBe('stream')
      expect(requestConfig.httpAgent).toBe(proxyAgent)
      expect(requestConfig.httpsAgent).toBe(proxyAgent)
      expect(streamHandlerSpy).toHaveBeenCalledWith(
        req,
        res,
        expect.objectContaining({
          upstreamResponse,
          accountId: 'acc-1',
          requestedModel: 'MiniMax-M3',
          sessionHash,
          body: expect.objectContaining({
            stream_options: expect.objectContaining({
              foo: 'bar',
              include_usage: true
            })
          })
        })
      )
      expect(result).toEqual({ handled: 'stream' })
    })
  })

  describe('handleAnthropicMessages — forwarding paths', () => {
    test('forwards anthropic requests with x-api-key and default version header', async () => {
      const axios = require('axios')
      const platform = require('../src/services/minimaxPlatform')
      const minimaxAccountService = require('../src/services/account/minimaxAccountService')

      minimaxAccountService.getAccount.mockResolvedValue({
        id: 'acc-1',
        name: 'MiniMax Anthropic',
        apiKey: 'anthropic-secret',
        baseApi: 'https://api.minimaxi.com/v1',
        supportedModels: {},
        proxy: null
      })

      const upstreamResponse = { status: 200, data: { ok: true } }
      axios.post.mockResolvedValue(upstreamResponse)

      const anthropicHandlerSpy = jest
        .spyOn(svc, '_handleAnthropicJsonResponse')
        .mockResolvedValue({ handled: 'anthropic' })

      const req = {
        apiKey: { id: 'key-1', permissions: ['minimax'] },
        body: { model: 'MiniMax-M3', messages: [] },
        headers: {},
        once: jest.fn(),
        on: jest.fn()
      }
      const res = {
        once: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      }

      const result = await svc.handleAnthropicMessages(req, res)

      expect(axios.post).toHaveBeenCalledWith(
        platform.buildAnthropicMessagesUrl('https://api.minimaxi.com/v1'),
        expect.objectContaining({ model: 'MiniMax-M3' }),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'anthropic-secret',
            'anthropic-version': '2023-06-01'
          })
        })
      )
      expect(anthropicHandlerSpy).toHaveBeenCalledWith(
        req,
        res,
        expect.objectContaining({
          upstreamResponse,
          accountId: 'acc-1',
          requestedModel: 'MiniMax-M3'
        })
      )
      expect(result).toEqual({ handled: 'anthropic' })
    })
  })

  describe('internal response lifecycle helpers', () => {
    const { EventEmitter } = require('events')

    const createReq = () => {
      const req = new EventEmitter()
      req.apiKey = { id: 'key-1' }
      req.headers = {}
      req.body = {}
      req.rateLimitInfo = {}
      return req
    }

    const createRes = () => {
      const res = new EventEmitter()
      res.statusCode = 200
      res.headersSent = false
      res.destroyed = false
      res.status = jest.fn((code) => {
        res.statusCode = code
        return res
      })
      res.json = jest.fn(() => res)
      res.setHeader = jest.fn()
      res.write = jest.fn()
      res.end = jest.fn()
      res.flushHeaders = jest.fn(() => {
        res.headersSent = true
      })
      return res
    }

    const flushAsync = async () => {
      await new Promise((resolve) => setImmediate(resolve))
    }

    test('_handleJsonResponse delegates upstream error payloads', async () => {
      const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
      const req = createReq()
      const res = createRes()
      const upstreamResponse = {
        status: 429,
        data: { error: { message: 'rate limited' } }
      }
      const upstreamStatusSpy = jest
        .spyOn(svc, '_handleUpstreamStatus')
        .mockResolvedValue(undefined)

      await svc._handleJsonResponse(req, res, {
        upstreamResponse,
        body: {},
        accountId: 'acc-1',
        requestedModel: 'MiniMax-M3',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(upstreamStatusSpy).toHaveBeenCalledWith(
        429,
        upstreamResponse.data,
        'acc-1',
        'session-hash'
      )
      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.json).toHaveBeenCalledWith(
        upstreamErrorHelper.sanitizeRelayErrorResponse(429, upstreamResponse.data)
      )
    })

    test('_handleJsonResponse sanitizes upstream billing exhaustion payloads', async () => {
      const req = createReq()
      const res = createRes()
      const upstreamResponse = {
        status: 402,
        data: {
          error: {
            message: 'NO_FREE_PACKAGE',
            code: '401007'
          }
        }
      }

      await svc._handleJsonResponse(req, res, {
        upstreamResponse,
        body: {},
        accountId: 'acc-1',
        requestedModel: 'MiniMax-M3',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(res.status).toHaveBeenCalledWith(402)
      expect(res.json).toHaveBeenCalledWith({
        error: {
          message: 'Account temporarily unavailable',
          code: '401007'
        }
      })
    })

    test('_handleJsonResponse logs when usage is missing', async () => {
      const logger = require('../src/utils/logger')
      const req = createReq()
      const res = createRes()
      const recordUsageSpy = jest.spyOn(svc, '_recordUsage').mockResolvedValue({})
      const upstreamResponse = {
        status: 200,
        data: { id: 'resp-1', model: 'MiniMax-M3', choices: [] }
      }

      await svc._handleJsonResponse(req, res, {
        upstreamResponse,
        body: { messages: [] },
        accountId: 'acc-1',
        requestedModel: 'MiniMax-M3',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(recordUsageSpy).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('MiniMax non-stream response missing usage')
      )
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith(upstreamResponse.data)
    })

    test('_handleStreamResponse records captured usage and clears rate limits on end', async () => {
      const unifiedMiniMaxScheduler = require('../src/services/scheduler/unifiedMinimaxScheduler')
      const { IncrementalSSEParser } = require('../src/utils/sseParser')
      const req = createReq()
      const res = createRes()
      const upstreamStream = new EventEmitter()
      upstreamStream.destroy = jest.fn()
      const recordUsageSpy = jest.spyOn(svc, '_recordUsage').mockResolvedValue({
        totalInputTokens: 3
      })

      unifiedMiniMaxScheduler.isAccountRateLimited.mockResolvedValue(true)
      unifiedMiniMaxScheduler.removeAccountRateLimit.mockResolvedValue(undefined)
      jest.spyOn(IncrementalSSEParser.prototype, 'feed').mockReturnValue([
        {
          type: 'data',
          data: {
            id: 'chatcmpl-1',
            created: 123,
            model: 'MiniMax-M3',
            usage: { prompt_tokens: 3, completion_tokens: 2 },
            choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }]
          }
        }
      ])
      jest.spyOn(IncrementalSSEParser.prototype, 'getRemaining').mockReturnValue('')

      await svc._handleStreamResponse(req, res, {
        upstreamResponse: { status: 200, data: upstreamStream },
        body: { messages: [{ role: 'user', content: 'hi' }] },
        accountId: 'acc-1',
        requestedModel: 'MiniMax-M3',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      upstreamStream.emit('data', Buffer.from('data: {"id":"chatcmpl-1"}\n\n'))
      upstreamStream.emit('end')
      await flushAsync()
      req.emit('close')

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream')
      expect(res.write).toHaveBeenCalled()
      expect(recordUsageSpy).toHaveBeenCalledWith(
        req,
        expect.objectContaining({
          accountId: 'acc-1',
          stream: true,
          statusCode: 200
        })
      )
      expect(unifiedMiniMaxScheduler.removeAccountRateLimit).toHaveBeenCalledWith('acc-1')
      expect(upstreamStream.destroy).toHaveBeenCalled()
      expect(res.end).toHaveBeenCalled()
    })

    test('_handleAnthropicJsonResponse delegates upstream error payloads', async () => {
      const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
      const req = createReq()
      const res = createRes()
      const upstreamResponse = {
        status: 503,
        data: { type: 'error', error: { message: 'busy' } }
      }
      const upstreamStatusSpy = jest
        .spyOn(svc, '_handleUpstreamStatus')
        .mockResolvedValue(undefined)

      await svc._handleAnthropicJsonResponse(req, res, {
        upstreamResponse,
        body: {},
        accountId: 'acc-1',
        requestedModel: 'MiniMax-M3',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(upstreamStatusSpy).toHaveBeenCalledWith(
        503,
        upstreamResponse.data,
        'acc-1',
        'session-hash'
      )
      expect(res.status).toHaveBeenCalledWith(503)
      expect(res.json).toHaveBeenCalledWith(
        upstreamErrorHelper.sanitizeRelayErrorResponse(503, upstreamResponse.data)
      )
    })

    test('_handleAnthropicStreamResponse records assistant content and destroys the upstream stream on close', async () => {
      const unifiedMiniMaxScheduler = require('../src/services/scheduler/unifiedMinimaxScheduler')
      const { IncrementalSSEParser } = require('../src/utils/sseParser')
      const req = createReq()
      const res = createRes()
      const upstreamStream = new EventEmitter()
      upstreamStream.destroy = jest.fn()
      const recordUsageSpy = jest.spyOn(svc, '_recordUsage').mockResolvedValue({
        totalInputTokens: 4
      })

      unifiedMiniMaxScheduler.isAccountRateLimited.mockResolvedValue(true)
      unifiedMiniMaxScheduler.removeAccountRateLimit.mockResolvedValue(undefined)
      jest.spyOn(IncrementalSSEParser.prototype, 'feed').mockReturnValue([
        {
          type: 'data',
          data: {
            id: 'msg-1',
            message: {
              model: 'MiniMax-M3',
              usage: { input_tokens: 4, output_tokens: 6 }
            },
            delta: { thinking: 'hmm', text: 'done' }
          }
        }
      ])
      jest.spyOn(IncrementalSSEParser.prototype, 'getRemaining').mockReturnValue('')

      await svc._handleAnthropicStreamResponse(req, res, {
        upstreamResponse: { status: 200, data: upstreamStream },
        body: { messages: [{ role: 'user', content: 'hi' }] },
        accountId: 'acc-1',
        requestedModel: 'MiniMax-M3',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      upstreamStream.emit('data', Buffer.from('event: message\ndata: {"id":"msg-1"}\n\n'))
      upstreamStream.emit('end')
      await flushAsync()
      req.emit('close')

      expect(recordUsageSpy).toHaveBeenCalledWith(
        req,
        expect.objectContaining({
          accountId: 'acc-1',
          protocol: 'anthropic'
        })
      )
      expect(recordUsageSpy.mock.calls[0][1].assistantContent).toBeUndefined()
      expect(unifiedMiniMaxScheduler.removeAccountRateLimit).toHaveBeenCalledWith('acc-1')
      expect(upstreamStream.destroy).toHaveBeenCalled()
      expect(res.end).toHaveBeenCalled()
    })
  })

  describe('_recordUsage and upstream error helpers', () => {
    test('records OpenAI usage without assistant content metadata', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      const minimaxAccountService = require('../src/services/account/minimaxAccountService')
      const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')
      const {
        createRequestDetailMeta,
        buildCompletionUsageSummary
      } = require('../src/utils/requestDetailHelper')
      const {
        buildUsageMetadata,
        buildInputMessagesBlock
      } = require('../src/utils/userInputExtractor')

      buildUsageMetadata.mockReturnValue({ meta: 'openai' })
      createRequestDetailMeta.mockReturnValue({ detail: true })
      buildCompletionUsageSummary.mockReturnValue({ totalInputTokens: 3, outputTokens: 2 })
      apiKeyService.recordUsageWithDetails.mockResolvedValue({ realCost: 1.25 })

      const req = {
        apiKey: { id: 'key-1' },
        headers: { 'x-session-id': 'raw-session' },
        rateLimitInfo: { scope: 'test' }
      }

      const result = await svc._recordUsage(req, {
        usage: { prompt_tokens: 3, completion_tokens: 2 },
        body: { messages: [{ role: 'user', content: 'hi' }] },
        model: 'MiniMax-M3',
        accountId: 'acc-1',
        sessionHash: 'hashed-session',
        stream: false,
        statusCode: 200,
        requestedModel: 'MiniMax-M3'
      })

      expect(buildInputMessagesBlock).not.toHaveBeenCalled()
      expect(buildUsageMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          format: 'openai',
          sessionId: 'hashed-session',
          rawSessionId: 'raw-session',
          assistantContent: null
        })
      )
      expect(apiKeyService.recordUsageWithDetails).toHaveBeenCalledWith(
        'key-1',
        expect.any(Object),
        'MiniMax-M3',
        'acc-1',
        'minimax',
        { meta: 'openai' },
        { detail: true }
      )
      expect(minimaxAccountService.updateUsageQuota).toHaveBeenCalledWith('acc-1', 1.25)
      expect(updateRateLimitCounters).toHaveBeenCalled()
      expect(result).toEqual({ totalInputTokens: 3, outputTokens: 2 })
    })

    test('records Anthropic usage without assistant content metadata', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      const {
        buildUsageMetadata,
        buildInputMessagesBlock
      } = require('../src/utils/userInputExtractor')

      buildInputMessagesBlock.mockClear()
      buildUsageMetadata.mockReturnValue({ meta: 'anthropic' })
      apiKeyService.recordUsageWithDetails.mockResolvedValue({ realCost: 0 })

      const req = {
        apiKey: { id: 'key-1' },
        headers: {},
        rateLimitInfo: {}
      }

      await svc._recordUsage(req, {
        usage: { input_tokens: 4, output_tokens: 5 },
        body: { messages: [{ role: 'user', content: 'hi' }] },
        model: 'MiniMax-M3',
        accountId: 'acc-1',
        sessionHash: 'hashed-session',
        stream: true,
        statusCode: 200,
        protocol: 'anthropic',
        assistantContent: [{ type: 'text', text: 'done' }],
        requestedModel: 'MiniMax-M3'
      })

      expect(buildInputMessagesBlock).not.toHaveBeenCalled()
      expect(buildUsageMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          format: 'anthropic',
          assistantContent: null
        })
      )
    })

    test('marks unauthorized, rate-limited and canceled upstream errors correctly', async () => {
      const axios = require('axios')
      const unifiedMiniMaxScheduler = require('../src/services/scheduler/unifiedMinimaxScheduler')
      const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

      await svc._handleUpstreamStatus(401, { error: 'bad auth' }, 'acc-1', 'session-hash')
      expect(unifiedMiniMaxScheduler.markAccountUnauthorized).toHaveBeenCalledWith(
        'acc-1',
        'MiniMax upstream auth failed (401)'
      )
      expect(unifiedMiniMaxScheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash')
      unifiedMiniMaxScheduler.markAccountUnauthorized.mockClear()
      unifiedMiniMaxScheduler.clearSessionMapping.mockClear()

      await svc._handleUpstreamStatus(429, { error: 'rate limited' }, 'acc-1', 'session-hash')
      expect(unifiedMiniMaxScheduler.markAccountRateLimited).toHaveBeenCalledWith(
        'acc-1',
        'session-hash'
      )

      await svc._handleUpstreamStatus(
        402,
        { error: { message: 'NO_FREE_PACKAGE', code: '401007' } },
        'acc-1',
        'session-hash'
      )
      expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
        'acc-1',
        'minimax',
        402,
        null,
        { response: { error: { message: 'NO_FREE_PACKAGE', code: '401007' } } }
      )
      expect(unifiedMiniMaxScheduler.markAccountUnauthorized).not.toHaveBeenCalled()
      expect(unifiedMiniMaxScheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash')

      await svc._handleUpstreamStatus(529, { error: 'overloaded' }, 'acc-1', 'session-hash')
      expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
        'acc-1',
        'minimax',
        529,
        null,
        { response: { error: 'overloaded' } }
      )

      axios.isCancel.mockReturnValue(true)
      const req = {}
      const res = {
        headersSent: false,
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        end: jest.fn()
      }

      await svc._handleRequestError(req, res, new Error('canceled'), 'acc-1', 'session-hash')

      expect(res.status).toHaveBeenCalledWith(499)
      expect(res.json).toHaveBeenCalledWith({
        error: { message: 'Client closed request' }
      })
    })
  })
})
