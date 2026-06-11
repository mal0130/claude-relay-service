/**
 * DeepSeek 平台功能测试
 * 覆盖范围：deepseekPlatform 工具函数、deepseekAccountService 核心逻辑、deepseekRelayService 辅助方法
 */

// ─────────────────────────────────────────────────────────────
// deepseekPlatform.js 测试
// ─────────────────────────────────────────────────────────────
describe('deepseekPlatform', () => {
  let platform

  beforeEach(() => {
    jest.resetModules()
    platform = require('../src/services/deepseekPlatform')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('normalizeBaseApi', () => {
    test('removes trailing slash', () => {
      expect(platform.normalizeBaseApi('https://api.deepseek.com/')).toBe(
        'https://api.deepseek.com'
      )
    })

    test('returns default when empty', () => {
      expect(platform.normalizeBaseApi('')).toBe(platform.DEEPSEEK_DEFAULT_BASE_API)
    })

    test('returns default when null', () => {
      expect(platform.normalizeBaseApi(null)).toBe(platform.DEEPSEEK_DEFAULT_BASE_API)
    })

    test('keeps valid url unchanged', () => {
      expect(platform.normalizeBaseApi('https://api.deepseek.com')).toBe('https://api.deepseek.com')
    })
  })

  describe('buildChatCompletionsUrl', () => {
    test('always appends /chat/completions to normalized base', () => {
      expect(platform.buildChatCompletionsUrl('https://api.deepseek.com')).toBe(
        'https://api.deepseek.com/chat/completions'
      )
    })

    test('removes trailing slash then appends', () => {
      expect(platform.buildChatCompletionsUrl('https://api.deepseek.com/')).toBe(
        'https://api.deepseek.com/chat/completions'
      )
    })

    test('works with custom base url', () => {
      expect(platform.buildChatCompletionsUrl('https://custom.proxy.com')).toBe(
        'https://custom.proxy.com/chat/completions'
      )
    })
  })

  describe('buildAnthropicMessagesUrl', () => {
    test('appends anthropic path to bare base', () => {
      expect(platform.buildAnthropicMessagesUrl('https://api.deepseek.com')).toBe(
        'https://api.deepseek.com/anthropic/v1/messages'
      )
    })

    test('returns as-is when already full anthropic path', () => {
      const url = 'https://api.deepseek.com/anthropic/v1/messages'
      expect(platform.buildAnthropicMessagesUrl(url)).toBe(url)
    })

    test('appends /messages to /anthropic/v1', () => {
      expect(platform.buildAnthropicMessagesUrl('https://api.deepseek.com/anthropic/v1')).toBe(
        'https://api.deepseek.com/anthropic/v1/messages'
      )
    })

    test('appends /v1/messages to /anthropic', () => {
      expect(platform.buildAnthropicMessagesUrl('https://api.deepseek.com/anthropic')).toBe(
        'https://api.deepseek.com/anthropic/v1/messages'
      )
    })

    test('converts /v1 suffix to anthropic messages url', () => {
      expect(platform.buildAnthropicMessagesUrl('https://api.deepseek.com/v1')).toBe(
        'https://api.deepseek.com/anthropic/v1/messages'
      )
    })
  })

  describe('isDeepSeekModel', () => {
    test('returns true for deepseek- prefixed model', () => {
      expect(platform.isDeepSeekModel('deepseek-chat')).toBe(true)
    })

    test('case-insensitive match', () => {
      expect(platform.isDeepSeekModel('DeepSeek-V4')).toBe(true)
    })

    test('returns false for non-deepseek model', () => {
      expect(platform.isDeepSeekModel('gpt-4')).toBe(false)
    })

    test('returns false for null/undefined', () => {
      expect(platform.isDeepSeekModel(null)).toBe(false)
      expect(platform.isDeepSeekModel(undefined)).toBe(false)
    })
  })

  describe('normalizeDeepSeekModel', () => {
    test('maps deepseek-chat alias to deepseek-v4-flash', () => {
      expect(platform.normalizeDeepSeekModel('deepseek-chat')).toBe('deepseek-v4-flash')
    })

    test('maps deepseek-reasoner alias to deepseek-v4-flash', () => {
      expect(platform.normalizeDeepSeekModel('deepseek-reasoner')).toBe('deepseek-v4-flash')
    })

    test('returns model as-is when no alias', () => {
      expect(platform.normalizeDeepSeekModel('deepseek-v4-flash')).toBe('deepseek-v4-flash')
    })

    test('returns default model for empty input', () => {
      expect(platform.normalizeDeepSeekModel('')).toBe(platform.DEEPSEEK_DEFAULT_MODEL)
    })

    test('returns default model for null', () => {
      expect(platform.normalizeDeepSeekModel(null)).toBe(platform.DEEPSEEK_DEFAULT_MODEL)
    })
  })

  describe('normalizeDeepSeekUsage', () => {
    test('uses miss_tokens as input_tokens when cache breakdown present', () => {
      const result = platform.normalizeDeepSeekUsage({
        prompt_tokens: 200,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 120
      })
      expect(result.input_tokens).toBe(120)
      expect(result.cache_read_input_tokens).toBe(80)
      expect(result.output_tokens).toBe(50)
    })

    test('uses prompt_tokens as input_tokens when no cache breakdown', () => {
      const result = platform.normalizeDeepSeekUsage({
        prompt_tokens: 200,
        completion_tokens: 50
      })
      expect(result.input_tokens).toBe(200)
      expect(result.cache_read_input_tokens).toBe(0)
    })

    test('uses input_tokens field as fallback', () => {
      const result = platform.normalizeDeepSeekUsage({ input_tokens: 150, output_tokens: 30 })
      expect(result.input_tokens).toBe(150)
      expect(result.output_tokens).toBe(30)
    })

    test('cache_creation_input_tokens is always 0 (DeepSeek no cache write)', () => {
      const result = platform.normalizeDeepSeekUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 20
      })
      expect(result.cache_creation_input_tokens).toBe(0)
    })

    test('returns zeros for empty usage', () => {
      const result = platform.normalizeDeepSeekUsage({})
      expect(result.input_tokens).toBe(0)
      expect(result.output_tokens).toBe(0)
      expect(result.cache_read_input_tokens).toBe(0)
      expect(result.cache_creation_input_tokens).toBe(0)
    })

    test('hit_tokens only triggers cache path', () => {
      const result = platform.normalizeDeepSeekUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_cache_hit_tokens: 40,
        prompt_cache_miss_tokens: 0
      })
      // hasCacheBreakdown is true (hitTokens > 0), input = max(0, missTokens) = 0
      expect(result.input_tokens).toBe(0)
      expect(result.cache_read_input_tokens).toBe(40)
    })
  })

  describe('normalizeDeepSeekAnthropicUsage', () => {
    test('uses prompt_cache_miss_tokens as input_tokens when present', () => {
      const result = platform.normalizeDeepSeekAnthropicUsage({
        input_tokens: 200,
        output_tokens: 50,
        prompt_cache_miss_tokens: 120,
        cache_read_input_tokens: 80
      })
      expect(result.input_tokens).toBe(120)
      expect(result.cache_read_input_tokens).toBe(80)
    })

    test('uses input_tokens when no miss_tokens', () => {
      const result = platform.normalizeDeepSeekAnthropicUsage({
        input_tokens: 200,
        output_tokens: 50
      })
      expect(result.input_tokens).toBe(200)
    })

    test('prefers cache_read_input_tokens over prompt_cache_hit_tokens', () => {
      const result = platform.normalizeDeepSeekAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 60,
        prompt_cache_hit_tokens: 40
      })
      expect(result.cache_read_input_tokens).toBe(60)
    })

    test('sums ephemeral cache_creation tokens', () => {
      const result = platform.normalizeDeepSeekAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation: {
          ephemeral_5m_input_tokens: 10,
          ephemeral_1h_input_tokens: 15
        }
      })
      expect(result.cache_creation_input_tokens).toBe(25)
    })

    test('prefers explicit cache_creation_input_tokens over sum', () => {
      const result = platform.normalizeDeepSeekAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 15 }
      })
      expect(result.cache_creation_input_tokens).toBe(30)
    })

    test('returns zeros for empty usage', () => {
      const result = platform.normalizeDeepSeekAnthropicUsage({})
      expect(result.input_tokens).toBe(0)
      expect(result.output_tokens).toBe(0)
      expect(result.cache_creation_input_tokens).toBe(0)
      expect(result.cache_read_input_tokens).toBe(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────
// deepseekAccountService.js 纯逻辑测试
// ─────────────────────────────────────────────────────────────
describe('DeepSeekAccountService — pure logic', () => {
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

    service = require('../src/services/account/deepseekAccountService')
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
      expect(service._processModelMapping(['deepseek-chat', 'deepseek-reasoner'])).toEqual({
        'deepseek-chat': 'deepseek-chat',
        'deepseek-reasoner': 'deepseek-reasoner'
      })
    })

    test('returns object as-is', () => {
      const mapping = { 'deepseek-chat': 'deepseek-v4-flash' }
      expect(service._processModelMapping(mapping)).toEqual(mapping)
    })

    test('filters out non-string entries in array', () => {
      expect(service._processModelMapping(['valid-model', null, '', 42])).toEqual({
        'valid-model': 'valid-model'
      })
    })
  })

  describe('isModelSupported', () => {
    test('returns true when mapping is empty', () => {
      expect(service.isModelSupported({}, 'deepseek-chat')).toBe(true)
    })

    test('returns true when mapping is null', () => {
      expect(service.isModelSupported(null, 'deepseek-chat')).toBe(true)
    })

    test('returns true for exact key match', () => {
      expect(
        service.isModelSupported({ 'deepseek-chat': 'deepseek-v4-flash' }, 'deepseek-chat')
      ).toBe(true)
    })

    test('returns true for case-insensitive key match', () => {
      expect(
        service.isModelSupported({ 'DeepSeek-Chat': 'deepseek-v4-flash' }, 'deepseek-chat')
      ).toBe(true)
    })

    test('returns false when model not in mapping', () => {
      expect(service.isModelSupported({ 'deepseek-chat': 'deepseek-v4-flash' }, 'gpt-4')).toBe(
        false
      )
    })
  })

  describe('getMappedModel', () => {
    test('returns requestedModel when mapping is empty', () => {
      expect(service.getMappedModel({}, 'deepseek-chat')).toBe('deepseek-chat')
    })

    test('returns mapped value for exact key match', () => {
      expect(
        service.getMappedModel({ 'deepseek-chat': 'deepseek-v4-flash' }, 'deepseek-chat')
      ).toBe('deepseek-v4-flash')
    })

    test('case-insensitive key lookup returns mapped value', () => {
      expect(
        service.getMappedModel({ 'DeepSeek-Chat': 'deepseek-v4-flash' }, 'deepseek-chat')
      ).toBe('deepseek-v4-flash')
    })

    test('returns original model when not found in mapping', () => {
      expect(service.getMappedModel({ 'deepseek-chat': 'deepseek-v4-flash' }, 'gpt-4')).toBe(
        'gpt-4'
      )
    })

    test('returns requestedModel when mapping is null', () => {
      expect(service.getMappedModel(null, 'deepseek-chat')).toBe('deepseek-chat')
    })
  })

  describe('createAccount — validation', () => {
    test('throws when apiKey is missing', async () => {
      await expect(service.createAccount({ name: 'Test DeepSeek' })).rejects.toThrow(
        'API Key is required for DeepSeek account'
      )
    })

    test('creates account and returns masked apiKey', async () => {
      const redis = require('../src/models/redis')
      redis.getClientSafe.mockReturnValue({
        hset: jest.fn(async () => {}),
        sadd: jest.fn(async () => {})
      })

      const result = await service.createAccount({
        apiKey: 'sk-deepseek-key',
        name: 'Test DeepSeek'
      })
      expect(result.apiKey).toBe('***')
      expect(result.name).toBe('Test DeepSeek')
      expect(result.platform).toBe('deepseek')
    })
  })
})

// ─────────────────────────────────────────────────────────────
// deepseekRelayService.js 辅助方法单元测试
// ─────────────────────────────────────────────────────────────
describe('DeepSeekRelayService — helper methods', () => {
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
    jest.doMock('../src/services/account/deepseekAccountService', () => ({
      getAccount: jest.fn(async () => null),
      getMappedModel: jest.fn((mapping, model) => model),
      updateUsageQuota: jest.fn(async () => {})
    }))
    jest.doMock('../src/services/scheduler/unifiedDeepSeekScheduler', () => ({
      selectAccountForApiKey: jest.fn(async () => ({ accountId: 'acc-ds-1' })),
      isAccountRateLimited: jest.fn(async () => false),
      removeAccountRateLimit: jest.fn(async () => {}),
      markAccountUnauthorized: jest.fn(async () => {}),
      markAccountRateLimited: jest.fn(async () => {}),
      clearSessionMapping: jest.fn(async () => {})
    }))
    jest.doMock('../src/utils/upstreamErrorHelper', () => ({
      markTempUnavailable: jest.fn(async () => {})
    }))

    svc = require('../src/services/relay/deepseekRelayService')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('_normalizeRequestModel', () => {
    test('applies alias mapping — deepseek-chat maps to deepseek-v4-flash', () => {
      expect(svc._normalizeRequestModel('deepseek-chat')).toBe('deepseek-v4-flash')
    })

    test('applies alias mapping — deepseek-reasoner maps to deepseek-v4-flash', () => {
      expect(svc._normalizeRequestModel('deepseek-reasoner')).toBe('deepseek-v4-flash')
    })

    test('returns model as-is when already canonical', () => {
      expect(svc._normalizeRequestModel('deepseek-v4-flash')).toBe('deepseek-v4-flash')
    })

    test('returns DEEPSEEK_DEFAULT_MODEL when null', () => {
      const { DEEPSEEK_DEFAULT_MODEL } = require('../src/services/deepseekPlatform')
      expect(svc._normalizeRequestModel(null)).toBe(DEEPSEEK_DEFAULT_MODEL)
    })

    test('returns DEEPSEEK_DEFAULT_MODEL when undefined', () => {
      const { DEEPSEEK_DEFAULT_MODEL } = require('../src/services/deepseekPlatform')
      expect(svc._normalizeRequestModel(undefined)).toBe(DEEPSEEK_DEFAULT_MODEL)
    })
  })

  describe('_isModelRestricted', () => {
    test('returns false when enableModelRestriction is false', () => {
      expect(
        svc._isModelRestricted(
          { enableModelRestriction: false, restrictedModels: ['deepseek-chat'] },
          'deepseek-chat'
        )
      ).toBe(false)
    })

    test('returns false when restrictedModels is empty', () => {
      expect(
        svc._isModelRestricted(
          { enableModelRestriction: true, restrictedModels: [] },
          'deepseek-chat'
        )
      ).toBe(false)
    })

    test('returns true when model is in restrictedModels', () => {
      expect(
        svc._isModelRestricted(
          { enableModelRestriction: true, restrictedModels: ['deepseek-chat'] },
          'deepseek-chat'
        )
      ).toBe(true)
    })

    test('returns false when model is not in restrictedModels', () => {
      expect(
        svc._isModelRestricted(
          { enableModelRestriction: true, restrictedModels: ['deepseek-reasoner'] },
          'deepseek-chat'
        )
      ).toBe(false)
    })

    test('returns falsy when apiKeyData is null', () => {
      expect(svc._isModelRestricted(null, 'deepseek-chat')).toBeFalsy()
    })
  })

  describe('_buildRequestBody', () => {
    test('sets mapped model on body', () => {
      const result = svc._buildRequestBody(
        { model: 'deepseek-chat', messages: [] },
        'deepseek-v4-flash'
      )
      expect(result.model).toBe('deepseek-v4-flash')
    })

    test('adds stream_options.include_usage for streaming', () => {
      const result = svc._buildRequestBody(
        { model: 'deepseek-chat', messages: [], stream: true },
        'deepseek-v4-flash'
      )
      expect(result.stream_options).toMatchObject({ include_usage: true })
    })

    test('does not add stream_options for non-streaming', () => {
      const result = svc._buildRequestBody(
        { model: 'deepseek-chat', messages: [], stream: false },
        'deepseek-v4-flash'
      )
      expect(result.stream_options).toBeUndefined()
    })

    test('merges existing stream_options', () => {
      const result = svc._buildRequestBody(
        { model: 'deepseek-chat', messages: [], stream: true, stream_options: { extra: true } },
        'deepseek-v4-flash'
      )
      expect(result.stream_options).toMatchObject({ include_usage: true, extra: true })
    })

    test('does not mutate original body', () => {
      const body = { model: 'deepseek-chat', messages: [] }
      svc._buildRequestBody(body, 'deepseek-v4-flash')
      expect(body.model).toBe('deepseek-chat')
    })
  })

  describe('handleChatCompletions — permission check', () => {
    test('returns 403 when missing deepseek permission', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      apiKeyService.hasPermission.mockReturnValue(false)

      const req = {
        apiKey: { permissions: ['claude'] },
        body: { model: 'deepseek-chat' },
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
          permissions: ['deepseek'],
          enableModelRestriction: true,
          restrictedModels: ['deepseek-v4-flash']
        },
        body: { model: 'deepseek-v4-flash' },
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
    test('returns 403 when missing deepseek permission', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      apiKeyService.hasPermission.mockReturnValue(false)

      const req = {
        apiKey: { permissions: ['claude'] },
        body: { model: 'deepseek-chat', messages: [] },
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
      expect(svc._getHeaderValue({ 'x-custom': ['a', 'b'] }, 'x-custom')).toBe('a')
    })
  })

  describe('handleChatCompletions — forwarding paths', () => {
    test('forwards non-stream requests to json handler with mapped model', async () => {
      const crypto = require('crypto')
      const axios = require('axios')
      const platform = require('../src/services/deepseekPlatform')
      const deepseekAccountService = require('../src/services/account/deepseekAccountService')
      const unifiedDeepSeekScheduler = require('../src/services/scheduler/unifiedDeepSeekScheduler')

      deepseekAccountService.getAccount.mockResolvedValue({
        id: 'acc-ds-1',
        name: 'DeepSeek A',
        apiKey: 'secret-key',
        baseApi: 'https://api.deepseek.com/v1',
        supportedModels: { 'deepseek-v4-flash': 'deepseek-v4-plus' },
        proxy: null
      })
      deepseekAccountService.getMappedModel.mockReturnValue('deepseek-v4-plus')

      const upstreamResponse = { status: 200, data: { ok: true } }
      axios.post.mockResolvedValue(upstreamResponse)

      const jsonHandlerSpy = jest
        .spyOn(svc, '_handleJsonResponse')
        .mockResolvedValue({ handled: 'json' })
      const streamHandlerSpy = jest.spyOn(svc, '_handleStreamResponse').mockResolvedValue(null)

      const req = {
        apiKey: { id: 'key-1', permissions: ['deepseek'] },
        body: { model: 'deepseek-chat', messages: [] },
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
      const normalizedModel = svc._normalizeRequestModel('deepseek-chat')

      expect(unifiedDeepSeekScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
        req.apiKey,
        sessionHash,
        normalizedModel
      )
      expect(axios.post).toHaveBeenCalledWith(
        platform.buildChatCompletionsUrl('https://api.deepseek.com/v1'),
        expect.objectContaining({ model: 'deepseek-v4-plus' }),
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
          accountId: 'acc-ds-1',
          requestedModel: normalizedModel,
          sessionHash
        })
      )
      expect(result).toEqual({ handled: 'json' })
    })

    test('forwards stream requests to stream handler and configures proxy agent', async () => {
      const crypto = require('crypto')
      const axios = require('axios')
      const proxyHelper = require('../src/utils/proxyHelper')
      const deepseekAccountService = require('../src/services/account/deepseekAccountService')

      const proxyAgent = { kind: 'agent' }
      proxyHelper.createProxyAgent.mockReturnValue(proxyAgent)
      deepseekAccountService.getAccount.mockResolvedValue({
        id: 'acc-ds-1',
        name: 'DeepSeek Stream',
        apiKey: 'secret-key',
        baseApi: 'https://api.deepseek.com/v1',
        supportedModels: {},
        proxy: { url: 'http://127.0.0.1:7890' }
      })

      const upstreamResponse = { status: 200, data: { on: jest.fn() } }
      axios.post.mockResolvedValue(upstreamResponse)

      const streamHandlerSpy = jest
        .spyOn(svc, '_handleStreamResponse')
        .mockResolvedValue({ handled: 'stream' })

      const req = {
        apiKey: { id: 'key-1', permissions: ['deepseek'] },
        body: {
          model: 'deepseek-chat',
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
      const normalizedModel = svc._normalizeRequestModel('deepseek-chat')

      expect(requestConfig.responseType).toBe('stream')
      expect(requestConfig.httpAgent).toBe(proxyAgent)
      expect(requestConfig.httpsAgent).toBe(proxyAgent)
      expect(streamHandlerSpy).toHaveBeenCalledWith(
        req,
        res,
        expect.objectContaining({
          upstreamResponse,
          accountId: 'acc-ds-1',
          requestedModel: normalizedModel,
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
      const platform = require('../src/services/deepseekPlatform')
      const deepseekAccountService = require('../src/services/account/deepseekAccountService')

      deepseekAccountService.getAccount.mockResolvedValue({
        id: 'acc-ds-1',
        name: 'DeepSeek Anthropic',
        apiKey: 'anthropic-secret',
        baseApi: 'https://api.deepseek.com/v1',
        supportedModels: {},
        proxy: null
      })

      const upstreamResponse = { status: 200, data: { ok: true } }
      axios.post.mockResolvedValue(upstreamResponse)

      const anthropicHandlerSpy = jest
        .spyOn(svc, '_handleAnthropicJsonResponse')
        .mockResolvedValue({ handled: 'anthropic' })

      const req = {
        apiKey: { id: 'key-1', permissions: ['deepseek'] },
        body: { model: 'deepseek-chat', messages: [] },
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
      const normalizedModel = svc._normalizeRequestModel('deepseek-chat')

      expect(axios.post).toHaveBeenCalledWith(
        platform.buildAnthropicMessagesUrl('https://api.deepseek.com/v1'),
        expect.objectContaining({ model: normalizedModel }),
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
          accountId: 'acc-ds-1',
          requestedModel: normalizedModel
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
        accountId: 'acc-ds-1',
        requestedModel: 'deepseek-v4-flash',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(upstreamStatusSpy).toHaveBeenCalledWith(
        429,
        upstreamResponse.data,
        'acc-ds-1',
        'session-hash'
      )
      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.json).toHaveBeenCalledWith(upstreamResponse.data)
    })

    test('_handleJsonResponse logs when usage is missing', async () => {
      const logger = require('../src/utils/logger')
      const req = createReq()
      const res = createRes()
      const recordUsageSpy = jest.spyOn(svc, '_recordUsage').mockResolvedValue({})
      const upstreamResponse = {
        status: 200,
        data: { id: 'resp-1', model: 'deepseek-v4-flash', choices: [] }
      }

      await svc._handleJsonResponse(req, res, {
        upstreamResponse,
        body: { messages: [] },
        accountId: 'acc-ds-1',
        requestedModel: 'deepseek-v4-flash',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(recordUsageSpy).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('DeepSeek non-stream response missing usage')
      )
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith(upstreamResponse.data)
    })

    test('_handleStreamResponse records captured usage and clears rate limits on end', async () => {
      const unifiedDeepSeekScheduler = require('../src/services/scheduler/unifiedDeepSeekScheduler')
      const { IncrementalSSEParser } = require('../src/utils/sseParser')
      const req = createReq()
      const res = createRes()
      const upstreamStream = new EventEmitter()
      upstreamStream.destroy = jest.fn()
      const recordUsageSpy = jest.spyOn(svc, '_recordUsage').mockResolvedValue({
        totalInputTokens: 3
      })

      unifiedDeepSeekScheduler.isAccountRateLimited.mockResolvedValue(true)
      unifiedDeepSeekScheduler.removeAccountRateLimit.mockResolvedValue(undefined)
      jest.spyOn(IncrementalSSEParser.prototype, 'feed').mockReturnValue([
        {
          type: 'data',
          data: {
            id: 'chatcmpl-1',
            created: 123,
            model: 'deepseek-v4-flash',
            usage: { prompt_tokens: 3, completion_tokens: 2 },
            choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }]
          }
        }
      ])
      jest.spyOn(IncrementalSSEParser.prototype, 'getRemaining').mockReturnValue('')

      await svc._handleStreamResponse(req, res, {
        upstreamResponse: { status: 200, data: upstreamStream },
        body: { messages: [{ role: 'user', content: 'hi' }] },
        accountId: 'acc-ds-1',
        requestedModel: 'deepseek-v4-flash',
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
          accountId: 'acc-ds-1',
          stream: true,
          statusCode: 200
        })
      )
      expect(unifiedDeepSeekScheduler.removeAccountRateLimit).toHaveBeenCalledWith('acc-ds-1')
      expect(upstreamStream.destroy).toHaveBeenCalled()
      expect(res.end).toHaveBeenCalled()
    })

    test('_handleAnthropicJsonResponse delegates upstream error payloads', async () => {
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
        accountId: 'acc-ds-1',
        requestedModel: 'deepseek-v4-flash',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(upstreamStatusSpy).toHaveBeenCalledWith(
        503,
        upstreamResponse.data,
        'acc-ds-1',
        'session-hash'
      )
      expect(res.status).toHaveBeenCalledWith(503)
      expect(res.json).toHaveBeenCalledWith(upstreamResponse.data)
    })

    test('_handleAnthropicStreamResponse records assistant content and destroys the upstream stream on close', async () => {
      const unifiedDeepSeekScheduler = require('../src/services/scheduler/unifiedDeepSeekScheduler')
      const { IncrementalSSEParser } = require('../src/utils/sseParser')
      const req = createReq()
      const res = createRes()
      const upstreamStream = new EventEmitter()
      upstreamStream.destroy = jest.fn()
      const recordUsageSpy = jest.spyOn(svc, '_recordUsage').mockResolvedValue({
        totalInputTokens: 4
      })

      unifiedDeepSeekScheduler.isAccountRateLimited.mockResolvedValue(true)
      unifiedDeepSeekScheduler.removeAccountRateLimit.mockResolvedValue(undefined)
      jest.spyOn(IncrementalSSEParser.prototype, 'feed').mockReturnValue([
        {
          type: 'data',
          data: {
            id: 'msg-1',
            message: {
              model: 'deepseek-v4-flash',
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
        accountId: 'acc-ds-1',
        requestedModel: 'deepseek-v4-flash',
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
          accountId: 'acc-ds-1',
          protocol: 'anthropic',
          assistantContent: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'done' }
          ]
        })
      )
      expect(unifiedDeepSeekScheduler.removeAccountRateLimit).toHaveBeenCalledWith('acc-ds-1')
      expect(upstreamStream.destroy).toHaveBeenCalled()
      expect(res.end).toHaveBeenCalled()
    })
  })

  describe('_recordUsage and upstream error helpers', () => {
    test('records OpenAI usage with synthesized input block metadata', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      const deepseekAccountService = require('../src/services/account/deepseekAccountService')
      const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')
      const {
        createRequestDetailMeta,
        buildCompletionUsageSummary
      } = require('../src/utils/requestDetailHelper')
      const {
        buildUsageMetadata,
        buildInputMessagesBlock
      } = require('../src/utils/userInputExtractor')

      buildInputMessagesBlock.mockReturnValue({
        type: 'input_messages',
        messages: [{ role: 'user' }]
      })
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
        model: 'deepseek-v4-flash',
        accountId: 'acc-ds-1',
        sessionHash: 'hashed-session',
        stream: false,
        statusCode: 200,
        requestedModel: 'deepseek-v4-flash'
      })

      expect(buildInputMessagesBlock).toHaveBeenCalled()
      expect(buildUsageMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          format: 'openai',
          sessionId: 'hashed-session',
          rawSessionId: 'raw-session',
          assistantContent: [{ type: 'input_messages', messages: [{ role: 'user' }] }]
        })
      )
      expect(apiKeyService.recordUsageWithDetails).toHaveBeenCalledWith(
        'key-1',
        expect.any(Object),
        'deepseek-v4-flash',
        'acc-ds-1',
        'deepseek',
        { meta: 'openai' },
        { detail: true }
      )
      expect(deepseekAccountService.updateUsageQuota).toHaveBeenCalledWith('acc-ds-1', 1.25)
      expect(updateRateLimitCounters).toHaveBeenCalled()
      expect(result).toEqual({ totalInputTokens: 3, outputTokens: 2 })
    })

    test('records Anthropic usage with provided assistant content', async () => {
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
        model: 'deepseek-v4-flash',
        accountId: 'acc-ds-1',
        sessionHash: 'hashed-session',
        stream: true,
        statusCode: 200,
        protocol: 'anthropic',
        assistantContent: [{ type: 'text', text: 'done' }],
        requestedModel: 'deepseek-v4-flash'
      })

      expect(buildInputMessagesBlock).not.toHaveBeenCalled()
      expect(buildUsageMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          format: 'anthropic',
          assistantContent: [{ type: 'text', text: 'done' }]
        })
      )
    })

    test('marks unauthorized, rate-limited and canceled upstream errors correctly', async () => {
      const axios = require('axios')
      const unifiedDeepSeekScheduler = require('../src/services/scheduler/unifiedDeepSeekScheduler')
      const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

      await svc._handleUpstreamStatus(401, { error: 'bad auth' }, 'acc-ds-1', 'session-hash')
      expect(unifiedDeepSeekScheduler.markAccountUnauthorized).toHaveBeenCalledWith(
        'acc-ds-1',
        'DeepSeek upstream auth failed (401)'
      )
      expect(unifiedDeepSeekScheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash')

      await svc._handleUpstreamStatus(429, { error: 'rate limited' }, 'acc-ds-1', 'session-hash')
      expect(unifiedDeepSeekScheduler.markAccountRateLimited).toHaveBeenCalledWith(
        'acc-ds-1',
        'session-hash'
      )

      await svc._handleUpstreamStatus(529, { error: 'overloaded' }, 'acc-ds-1', 'session-hash')
      expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
        'acc-ds-1',
        'deepseek',
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

      await svc._handleRequestError(req, res, new Error('canceled'), 'acc-ds-1', 'session-hash')

      expect(res.status).toHaveBeenCalledWith(499)
      expect(res.json).toHaveBeenCalledWith({
        error: { message: 'Client closed request' }
      })
    })
  })
})
