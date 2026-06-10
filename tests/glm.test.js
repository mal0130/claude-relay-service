/**
 * GLM 平台功能测试
 * 覆盖范围：glmPlatform 工具函数、glmAccountService 核心逻辑、glmRelayService 辅助方法
 */

// ─────────────────────────────────────────────────────────────
// glmPlatform.js 测试
// ─────────────────────────────────────────────────────────────
describe('glmPlatform', () => {
  let platform

  beforeEach(() => {
    jest.resetModules()
    platform = require('../src/services/glmPlatform')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('normalizeBaseApi', () => {
    test('removes trailing slash', () => {
      expect(platform.normalizeBaseApi('https://open.bigmodel.cn/api/paas/v4/')).toBe(
        'https://open.bigmodel.cn/api/paas/v4'
      )
    })

    test('returns default when empty', () => {
      expect(platform.normalizeBaseApi('')).toBe(platform.GLM_DEFAULT_BASE_API)
    })

    test('returns default when null', () => {
      expect(platform.normalizeBaseApi(null)).toBe(platform.GLM_DEFAULT_BASE_API)
    })

    test('keeps valid url unchanged', () => {
      expect(platform.normalizeBaseApi('https://open.bigmodel.cn/api/paas/v4')).toBe(
        'https://open.bigmodel.cn/api/paas/v4'
      )
    })
  })

  describe('buildChatCompletionsUrl', () => {
    test('appends /chat/completions to /v4 base', () => {
      expect(platform.buildChatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(
        'https://open.bigmodel.cn/api/paas/v4/chat/completions'
      )
    })

    test('appends /chat/completions to /v1 base', () => {
      expect(platform.buildChatCompletionsUrl('https://custom.api.com/v1')).toBe(
        'https://custom.api.com/v1/chat/completions'
      )
    })

    test('returns as-is when already ends with /chat/completions', () => {
      const url = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
      expect(platform.buildChatCompletionsUrl(url)).toBe(url)
    })

    test('handles base without /v4 or /v1 suffix', () => {
      const result = platform.buildChatCompletionsUrl('https://custom.api.com')
      expect(result).toBe('https://custom.api.com/v1/chat/completions')
    })
  })

  describe('buildAnthropicMessagesUrl', () => {
    test('converts /v4 base to anthropic messages url', () => {
      expect(platform.buildAnthropicMessagesUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(
        'https://open.bigmodel.cn/api/paas/anthropic/v1/messages'
      )
    })

    test('returns as-is when already full anthropic path', () => {
      const url = 'https://open.bigmodel.cn/api/paas/anthropic/v1/messages'
      expect(platform.buildAnthropicMessagesUrl(url)).toBe(url)
    })

    test('appends /messages to /anthropic/v1', () => {
      expect(platform.buildAnthropicMessagesUrl('https://custom.api.com/anthropic/v1')).toBe(
        'https://custom.api.com/anthropic/v1/messages'
      )
    })

    test('appends /v1/messages to /anthropic', () => {
      expect(platform.buildAnthropicMessagesUrl('https://custom.api.com/anthropic')).toBe(
        'https://custom.api.com/anthropic/v1/messages'
      )
    })

    test('handles custom base without recognized suffix', () => {
      const result = platform.buildAnthropicMessagesUrl('https://custom.api.com')
      expect(result).toContain('/anthropic/v1/messages')
    })
  })

  describe('isGlmModel', () => {
    test('returns true for glm- prefixed model', () => {
      expect(platform.isGlmModel('glm-4-flash')).toBe(true)
    })

    test('returns true for z-ai/ prefixed model', () => {
      expect(platform.isGlmModel('z-ai/glm-4')).toBe(true)
    })

    test('case-insensitive for GLM- prefix', () => {
      expect(platform.isGlmModel('GLM-4')).toBe(true)
    })

    test('returns false for non-glm model', () => {
      expect(platform.isGlmModel('gpt-4')).toBe(false)
    })

    test('returns false for null/undefined', () => {
      expect(platform.isGlmModel(null)).toBe(false)
      expect(platform.isGlmModel(undefined)).toBe(false)
    })
  })

  describe('normalizeGlmModel', () => {
    test('returns model as-is when no alias exists', () => {
      expect(platform.normalizeGlmModel('glm-4-flash')).toBe('glm-4-flash')
    })

    test('returns default model for empty input', () => {
      expect(platform.normalizeGlmModel('')).toBe(platform.GLM_DEFAULT_MODEL)
    })

    test('returns default model for null', () => {
      expect(platform.normalizeGlmModel(null)).toBe(platform.GLM_DEFAULT_MODEL)
    })
  })

  describe('normalizeGlmUsage', () => {
    test('maps prompt_tokens to input_tokens', () => {
      const result = platform.normalizeGlmUsage({ prompt_tokens: 100, completion_tokens: 50 })
      expect(result.input_tokens).toBe(100)
      expect(result.output_tokens).toBe(50)
    })

    test('maps input_tokens / output_tokens fields', () => {
      const result = platform.normalizeGlmUsage({ input_tokens: 200, output_tokens: 80 })
      expect(result.input_tokens).toBe(200)
      expect(result.output_tokens).toBe(80)
    })

    test('always returns zero cache tokens (GLM has no cache)', () => {
      const result = platform.normalizeGlmUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 30
      })
      expect(result.cache_creation_input_tokens).toBe(0)
      expect(result.cache_read_input_tokens).toBe(0)
    })

    test('returns zeros for empty usage', () => {
      const result = platform.normalizeGlmUsage({})
      expect(result.input_tokens).toBe(0)
      expect(result.output_tokens).toBe(0)
    })
  })

  describe('normalizeGlmAnthropicUsage', () => {
    test('maps anthropic usage fields', () => {
      const result = platform.normalizeGlmAnthropicUsage({
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

    test('sums ephemeral cache_creation tokens', () => {
      const result = platform.normalizeGlmAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation: {
          ephemeral_5m_input_tokens: 6,
          ephemeral_1h_input_tokens: 14
        }
      })
      expect(result.cache_creation_input_tokens).toBe(20)
    })

    test('prefers explicit cache_creation_input_tokens over object sum', () => {
      const result = platform.normalizeGlmAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 25,
        cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 14 }
      })
      expect(result.cache_creation_input_tokens).toBe(25)
    })

    test('returns zeros for empty usage', () => {
      const result = platform.normalizeGlmAnthropicUsage({})
      expect(result.input_tokens).toBe(0)
      expect(result.output_tokens).toBe(0)
      expect(result.cache_creation_input_tokens).toBe(0)
      expect(result.cache_read_input_tokens).toBe(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────
// glmAccountService.js 纯逻辑测试
// ─────────────────────────────────────────────────────────────
describe('GlmAccountService — pure logic', () => {
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

    service = require('../src/services/account/glmAccountService')
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
      expect(service._processModelMapping(['glm-4-flash', 'glm-4-plus'])).toEqual({
        'glm-4-flash': 'glm-4-flash',
        'glm-4-plus': 'glm-4-plus'
      })
    })

    test('returns object as-is', () => {
      const mapping = { 'glm-4': 'glm-4-prod' }
      expect(service._processModelMapping(mapping)).toEqual(mapping)
    })
  })

  describe('isModelSupported', () => {
    test('returns true when mapping is empty', () => {
      expect(service.isModelSupported({}, 'glm-4-flash')).toBe(true)
    })

    test('returns true for exact key match', () => {
      expect(service.isModelSupported({ 'glm-4-flash': 'glm-4-flash' }, 'glm-4-flash')).toBe(true)
    })

    test('returns true for case-insensitive key match', () => {
      expect(service.isModelSupported({ 'GLM-4-FLASH': 'glm-4-flash' }, 'glm-4-flash')).toBe(true)
    })

    test('returns false when model not in mapping', () => {
      expect(service.isModelSupported({ 'glm-4-flash': 'glm-4-flash' }, 'gpt-4')).toBe(false)
    })
  })

  describe('getMappedModel', () => {
    test('returns requestedModel when mapping is empty', () => {
      expect(service.getMappedModel({}, 'glm-4-flash')).toBe('glm-4-flash')
    })

    test('returns mapped value for exact key match', () => {
      expect(service.getMappedModel({ 'glm-4': 'glm-4-prod' }, 'glm-4')).toBe('glm-4-prod')
    })

    test('returns original model when not found in mapping', () => {
      expect(service.getMappedModel({ 'glm-4': 'glm-4-prod' }, 'gpt-4')).toBe('gpt-4')
    })
  })

  describe('createAccount — validation', () => {
    test('throws when apiKey is missing', async () => {
      await expect(service.createAccount({ name: 'Test GLM' })).rejects.toThrow(
        'API Key is required for GLM account'
      )
    })

    test('creates account and returns masked apiKey', async () => {
      const redis = require('../src/models/redis')
      redis.getClientSafe.mockReturnValue({
        hset: jest.fn(async () => {}),
        sadd: jest.fn(async () => {})
      })

      const result = await service.createAccount({ apiKey: 'glm-test-key', name: 'Test GLM' })
      expect(result.apiKey).toBe('***')
      expect(result.name).toBe('Test GLM')
      expect(result.platform).toBe('glm')
    })
  })
})

// ─────────────────────────────────────────────────────────────
// glmRelayService.js 辅助方法单元测试
// ─────────────────────────────────────────────────────────────
describe('GlmRelayService — helper methods', () => {
  let svc

  beforeEach(() => {
    jest.resetModules()

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
    jest.doMock('../src/services/account/glmAccountService', () => ({
      getAccount: jest.fn(async () => null),
      getMappedModel: jest.fn((mapping, model) => model),
      updateUsageQuota: jest.fn(async () => {})
    }))
    jest.doMock('../src/services/scheduler/unifiedGlmScheduler', () => ({
      selectAccountForApiKey: jest.fn(async () => ({ accountId: 'acc-glm-1' })),
      isAccountRateLimited: jest.fn(async () => false),
      removeAccountRateLimit: jest.fn(async () => {}),
      markAccountUnauthorized: jest.fn(async () => {}),
      markAccountRateLimited: jest.fn(async () => {}),
      clearSessionMapping: jest.fn(async () => {})
    }))
    jest.doMock('../src/utils/upstreamErrorHelper', () => ({
      markTempUnavailable: jest.fn(async () => {})
    }))

    svc = require('../src/services/relay/glmRelayService')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('_normalizeRequestModel', () => {
    test('returns model when provided', () => {
      expect(svc._normalizeRequestModel('glm-4-flash')).toBe('glm-4-flash')
    })

    test('returns GLM_DEFAULT_MODEL when null', () => {
      const { GLM_DEFAULT_MODEL } = require('../src/services/glmPlatform')
      expect(svc._normalizeRequestModel(null)).toBe(GLM_DEFAULT_MODEL)
    })
  })

  describe('_isModelRestricted', () => {
    test('returns false when enableModelRestriction is false', () => {
      expect(
        svc._isModelRestricted(
          { enableModelRestriction: false, restrictedModels: ['glm-4-flash'] },
          'glm-4-flash'
        )
      ).toBe(false)
    })

    test('returns true when model is in restrictedModels', () => {
      expect(
        svc._isModelRestricted(
          { enableModelRestriction: true, restrictedModels: ['glm-4-flash'] },
          'glm-4-flash'
        )
      ).toBe(true)
    })

    test('returns false when model is not in restrictedModels', () => {
      expect(
        svc._isModelRestricted(
          { enableModelRestriction: true, restrictedModels: ['glm-4-plus'] },
          'glm-4-flash'
        )
      ).toBe(false)
    })

    test('returns falsy when apiKeyData is null', () => {
      expect(svc._isModelRestricted(null, 'glm-4-flash')).toBeFalsy()
    })
  })

  describe('_buildRequestBody', () => {
    test('sets mapped model on body', () => {
      const result = svc._buildRequestBody({ model: 'glm-4', messages: [] }, 'glm-4-flash')
      expect(result.model).toBe('glm-4-flash')
    })

    test('adds stream_options.include_usage for streaming requests', () => {
      const result = svc._buildRequestBody(
        { model: 'glm-4', messages: [], stream: true },
        'glm-4-flash'
      )
      expect(result.stream_options).toMatchObject({ include_usage: true })
    })

    test('does not add stream_options for non-streaming', () => {
      const result = svc._buildRequestBody(
        { model: 'glm-4', messages: [], stream: false },
        'glm-4-flash'
      )
      expect(result.stream_options).toBeUndefined()
    })
  })

  describe('handleChatCompletions — permission check', () => {
    test('returns 403 when missing glm permission', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      apiKeyService.hasPermission.mockReturnValue(false)

      const req = {
        apiKey: { permissions: ['claude'] },
        body: { model: 'glm-4-flash' },
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
          permissions: ['glm'],
          enableModelRestriction: true,
          restrictedModels: ['glm-4-flash']
        },
        body: { model: 'glm-4-flash' },
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
    test('returns 403 when missing glm permission', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      apiKeyService.hasPermission.mockReturnValue(false)

      const req = {
        apiKey: { permissions: ['claude'] },
        body: { model: 'glm-4-flash', messages: [] },
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
      expect(svc._parseJsonSafe('{"ok":true}')).toEqual({ ok: true })
    })

    test('returns null for invalid JSON', () => {
      expect(svc._parseJsonSafe('bad json')).toBeNull()
    })
  })
})
