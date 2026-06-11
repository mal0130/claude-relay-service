/**
 * Kimi 平台功能测试
 * 覆盖范围：kimiPlatform 工具函数、kimiAccountService 核心逻辑、kimiRelayService 辅助方法
 */

// ─────────────────────────────────────────────────────────────
// kimiPlatform.js 测试
// ─────────────────────────────────────────────────────────────
describe('kimiPlatform', () => {
  let platform

  beforeEach(() => {
    jest.resetModules()
    platform = require('../src/services/kimiPlatform')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('normalizeBaseApi', () => {
    test('removes trailing slash', () => {
      expect(platform.normalizeBaseApi('https://api.moonshot.cn/')).toBe('https://api.moonshot.cn')
    })

    test('returns default when empty', () => {
      expect(platform.normalizeBaseApi('')).toBe(platform.KIMI_DEFAULT_BASE_API)
    })

    test('returns default when null', () => {
      expect(platform.normalizeBaseApi(null)).toBe(platform.KIMI_DEFAULT_BASE_API)
    })

    test('keeps valid url unchanged', () => {
      expect(platform.normalizeBaseApi('https://api.moonshot.cn')).toBe('https://api.moonshot.cn')
    })
  })

  describe('buildChatCompletionsUrl', () => {
    test('appends /chat/completions to /v1 base', () => {
      expect(platform.buildChatCompletionsUrl('https://api.moonshot.cn/v1')).toBe(
        'https://api.moonshot.cn/v1/chat/completions'
      )
    })

    test('returns as-is when already ends with /chat/completions', () => {
      const url = 'https://api.moonshot.cn/v1/chat/completions'
      expect(platform.buildChatCompletionsUrl(url)).toBe(url)
    })

    test('handles base without /v1 suffix', () => {
      const result = platform.buildChatCompletionsUrl('https://api.moonshot.cn')
      expect(result).toBe('https://api.moonshot.cn/v1/chat/completions')
    })
  })

  describe('buildAnthropicMessagesUrl', () => {
    test('converts /v1 base to anthropic messages url', () => {
      expect(platform.buildAnthropicMessagesUrl('https://api.moonshot.cn/v1')).toBe(
        'https://api.moonshot.cn/anthropic/v1/messages'
      )
    })

    test('returns as-is when already full anthropic path', () => {
      const url = 'https://api.moonshot.cn/anthropic/v1/messages'
      expect(platform.buildAnthropicMessagesUrl(url)).toBe(url)
    })

    test('appends /messages to /anthropic/v1', () => {
      expect(platform.buildAnthropicMessagesUrl('https://api.moonshot.cn/anthropic/v1')).toBe(
        'https://api.moonshot.cn/anthropic/v1/messages'
      )
    })

    test('appends /v1/messages to /anthropic', () => {
      expect(platform.buildAnthropicMessagesUrl('https://api.moonshot.cn/anthropic')).toBe(
        'https://api.moonshot.cn/anthropic/v1/messages'
      )
    })

    test('handles custom base without recognized suffix', () => {
      const result = platform.buildAnthropicMessagesUrl('https://custom.api.com')
      expect(result).toContain('/anthropic/v1/messages')
    })
  })

  describe('isKimiModel', () => {
    test('returns true for moonshot- prefixed model', () => {
      expect(platform.isKimiModel('moonshot-v1-8k')).toBe(true)
    })

    test('returns true for kimi- prefixed model', () => {
      expect(platform.isKimiModel('kimi-latest')).toBe(true)
    })

    test('returns true for moonshotai/ prefixed model', () => {
      expect(platform.isKimiModel('moonshotai/moonshot-v1-8k')).toBe(true)
    })

    test('case-insensitive match', () => {
      expect(platform.isKimiModel('Moonshot-V1-8K')).toBe(true)
      expect(platform.isKimiModel('KIMI-latest')).toBe(true)
    })

    test('returns false for non-kimi model', () => {
      expect(platform.isKimiModel('gpt-4')).toBe(false)
    })

    test('returns false for null/undefined', () => {
      expect(platform.isKimiModel(null)).toBe(false)
      expect(platform.isKimiModel(undefined)).toBe(false)
    })
  })

  describe('normalizeKimiModel', () => {
    test('maps kimi-latest alias to moonshot-v1-128k', () => {
      expect(platform.normalizeKimiModel('kimi-latest')).toBe('moonshot-v1-128k')
    })

    test('returns model as-is when no alias', () => {
      expect(platform.normalizeKimiModel('moonshot-v1-8k')).toBe('moonshot-v1-8k')
    })

    test('returns default model for empty input', () => {
      expect(platform.normalizeKimiModel('')).toBe(platform.KIMI_DEFAULT_MODEL)
    })

    test('returns default model for null', () => {
      expect(platform.normalizeKimiModel(null)).toBe(platform.KIMI_DEFAULT_MODEL)
    })
  })

  describe('normalizeKimiUsage', () => {
    test('maps prompt_tokens to input_tokens', () => {
      const result = platform.normalizeKimiUsage({ prompt_tokens: 100, completion_tokens: 50 })
      expect(result.input_tokens).toBe(100)
      expect(result.output_tokens).toBe(50)
    })

    test('maps input_tokens / output_tokens fields', () => {
      const result = platform.normalizeKimiUsage({ input_tokens: 200, output_tokens: 80 })
      expect(result.input_tokens).toBe(200)
      expect(result.output_tokens).toBe(80)
    })

    test('always returns zero cache tokens (Kimi no cache)', () => {
      const result = platform.normalizeKimiUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 30
      })
      expect(result.cache_creation_input_tokens).toBe(0)
      expect(result.cache_read_input_tokens).toBe(0)
    })

    test('returns zeros for empty usage', () => {
      const result = platform.normalizeKimiUsage({})
      expect(result.input_tokens).toBe(0)
      expect(result.output_tokens).toBe(0)
    })
  })

  describe('normalizeKimiAnthropicUsage', () => {
    test('maps anthropic usage fields', () => {
      const result = platform.normalizeKimiAnthropicUsage({
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
      const result = platform.normalizeKimiAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation: {
          ephemeral_5m_input_tokens: 8,
          ephemeral_1h_input_tokens: 12
        }
      })
      expect(result.cache_creation_input_tokens).toBe(20)
    })

    test('prefers explicit cache_creation_input_tokens over sum', () => {
      const result = platform.normalizeKimiAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
        cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 12 }
      })
      expect(result.cache_creation_input_tokens).toBe(30)
    })

    test('returns zeros for empty usage', () => {
      const result = platform.normalizeKimiAnthropicUsage({})
      expect(result.input_tokens).toBe(0)
      expect(result.output_tokens).toBe(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────
// kimiAccountService.js 纯逻辑测试
// ─────────────────────────────────────────────────────────────
describe('KimiAccountService — pure logic', () => {
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

    service = require('../src/services/account/kimiAccountService')
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
      expect(service._processModelMapping(['moonshot-v1-8k', 'moonshot-v1-128k'])).toEqual({
        'moonshot-v1-8k': 'moonshot-v1-8k',
        'moonshot-v1-128k': 'moonshot-v1-128k'
      })
    })

    test('returns object as-is', () => {
      const mapping = { 'kimi-latest': 'moonshot-v1-128k' }
      expect(service._processModelMapping(mapping)).toEqual(mapping)
    })
  })

  describe('isModelSupported', () => {
    test('returns true when mapping is empty', () => {
      expect(service.isModelSupported({}, 'moonshot-v1-8k')).toBe(true)
    })

    test('returns true for exact key match', () => {
      expect(
        service.isModelSupported({ 'moonshot-v1-8k': 'moonshot-v1-8k' }, 'moonshot-v1-8k')
      ).toBe(true)
    })

    test('returns true for case-insensitive key match', () => {
      expect(
        service.isModelSupported({ 'MOONSHOT-V1-8K': 'moonshot-v1-8k' }, 'moonshot-v1-8k')
      ).toBe(true)
    })

    test('returns false when model not in mapping', () => {
      expect(service.isModelSupported({ 'moonshot-v1-8k': 'moonshot-v1-8k' }, 'gpt-4')).toBe(false)
    })
  })

  describe('getMappedModel', () => {
    test('returns requestedModel when mapping is empty', () => {
      expect(service.getMappedModel({}, 'moonshot-v1-8k')).toBe('moonshot-v1-8k')
    })

    test('returns mapped value for exact key match', () => {
      expect(service.getMappedModel({ 'kimi-latest': 'moonshot-v1-128k' }, 'kimi-latest')).toBe(
        'moonshot-v1-128k'
      )
    })

    test('returns original model when not found in mapping', () => {
      expect(service.getMappedModel({ 'kimi-latest': 'moonshot-v1-128k' }, 'gpt-4')).toBe('gpt-4')
    })
  })

  describe('createAccount — validation', () => {
    test('throws when apiKey is missing', async () => {
      await expect(service.createAccount({ name: 'Test Kimi' })).rejects.toThrow(
        'API Key is required for Kimi account'
      )
    })

    test('creates account and returns masked apiKey', async () => {
      const redis = require('../src/models/redis')
      redis.getClientSafe.mockReturnValue({
        hset: jest.fn(async () => {}),
        sadd: jest.fn(async () => {})
      })

      const result = await service.createAccount({ apiKey: 'kimi-test-key', name: 'Test Kimi' })
      expect(result.apiKey).toBe('***')
      expect(result.name).toBe('Test Kimi')
      expect(result.platform).toBe('kimi')
    })
  })
})

// ─────────────────────────────────────────────────────────────
// kimiRelayService.js 辅助方法单元测试
// ─────────────────────────────────────────────────────────────
describe('KimiRelayService — helper methods', () => {
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
    jest.doMock('../src/services/account/kimiAccountService', () => ({
      getAccount: jest.fn(async () => null),
      getMappedModel: jest.fn((mapping, model) => model),
      updateUsageQuota: jest.fn(async () => {})
    }))
    jest.doMock('../src/services/scheduler/unifiedKimiScheduler', () => ({
      selectAccountForApiKey: jest.fn(async () => ({ accountId: 'acc-kimi-1' })),
      isAccountRateLimited: jest.fn(async () => false),
      removeAccountRateLimit: jest.fn(async () => {}),
      markAccountUnauthorized: jest.fn(async () => {}),
      markAccountRateLimited: jest.fn(async () => {}),
      clearSessionMapping: jest.fn(async () => {})
    }))
    jest.doMock('../src/utils/upstreamErrorHelper', () => ({
      markTempUnavailable: jest.fn(async () => {})
    }))

    svc = require('../src/services/relay/kimiRelayService')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('_normalizeRequestModel', () => {
    test('returns model when provided', () => {
      expect(svc._normalizeRequestModel('moonshot-v1-8k')).toBe('moonshot-v1-8k')
    })

    test('returns KIMI_DEFAULT_MODEL when null', () => {
      const { KIMI_DEFAULT_MODEL } = require('../src/services/kimiPlatform')
      expect(svc._normalizeRequestModel(null)).toBe(KIMI_DEFAULT_MODEL)
    })
  })

  describe('_isModelRestricted', () => {
    test('returns false when enableModelRestriction is false', () => {
      expect(
        svc._isModelRestricted(
          { enableModelRestriction: false, restrictedModels: ['moonshot-v1-8k'] },
          'moonshot-v1-8k'
        )
      ).toBe(false)
    })

    test('returns true when model is in restrictedModels', () => {
      expect(
        svc._isModelRestricted(
          { enableModelRestriction: true, restrictedModels: ['moonshot-v1-8k'] },
          'moonshot-v1-8k'
        )
      ).toBe(true)
    })

    test('returns false when model is not restricted', () => {
      expect(
        svc._isModelRestricted(
          { enableModelRestriction: true, restrictedModels: ['moonshot-v1-128k'] },
          'moonshot-v1-8k'
        )
      ).toBe(false)
    })

    test('returns falsy when apiKeyData is null', () => {
      expect(svc._isModelRestricted(null, 'moonshot-v1-8k')).toBeFalsy()
    })
  })

  describe('_buildRequestBody', () => {
    test('sets mapped model on body', () => {
      const result = svc._buildRequestBody(
        { model: 'kimi-latest', messages: [] },
        'moonshot-v1-128k'
      )
      expect(result.model).toBe('moonshot-v1-128k')
    })

    test('adds stream_options.include_usage for streaming', () => {
      const result = svc._buildRequestBody(
        { model: 'kimi-latest', messages: [], stream: true },
        'moonshot-v1-128k'
      )
      expect(result.stream_options).toMatchObject({ include_usage: true })
    })

    test('does not add stream_options for non-streaming', () => {
      const result = svc._buildRequestBody(
        { model: 'kimi-latest', messages: [], stream: false },
        'moonshot-v1-128k'
      )
      expect(result.stream_options).toBeUndefined()
    })
  })

  describe('handleChatCompletions — permission check', () => {
    test('returns 403 when missing kimi permission', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      apiKeyService.hasPermission.mockReturnValue(false)

      const req = {
        apiKey: { permissions: ['claude'] },
        body: { model: 'moonshot-v1-8k' },
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
          permissions: ['kimi'],
          enableModelRestriction: true,
          restrictedModels: ['moonshot-v1-8k']
        },
        body: { model: 'moonshot-v1-8k' },
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
    test('returns 403 when missing kimi permission', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      apiKeyService.hasPermission.mockReturnValue(false)

      const req = {
        apiKey: { permissions: ['claude'] },
        body: { model: 'moonshot-v1-8k', messages: [] },
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

  describe('handleChatCompletions — forwarding paths', () => {
    test('forwards non-stream requests to json handler with mapped model', async () => {
      const crypto = require('crypto')
      const axios = require('axios')
      const platform = require('../src/services/kimiPlatform')
      const kimiAccountService = require('../src/services/account/kimiAccountService')
      const unifiedKimiScheduler = require('../src/services/scheduler/unifiedKimiScheduler')

      kimiAccountService.getAccount.mockResolvedValue({
        id: 'acc-kimi-1',
        name: 'Kimi A',
        apiKey: 'secret-key',
        baseApi: 'https://api.moonshot.cn/v1',
        supportedModels: { 'moonshot-v1-8k': 'moonshot-v1-128k' },
        proxy: null
      })
      kimiAccountService.getMappedModel.mockReturnValue('moonshot-v1-128k')

      const upstreamResponse = { status: 200, data: { ok: true } }
      axios.post.mockResolvedValue(upstreamResponse)

      const jsonHandlerSpy = jest
        .spyOn(svc, '_handleJsonResponse')
        .mockResolvedValue({ handled: 'json' })
      const streamHandlerSpy = jest.spyOn(svc, '_handleStreamResponse').mockResolvedValue(null)

      const req = {
        apiKey: { id: 'key-1', permissions: ['kimi'] },
        body: { model: 'moonshot-v1-8k', messages: [] },
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

      expect(unifiedKimiScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
        req.apiKey,
        sessionHash,
        'moonshot-v1-8k'
      )
      expect(axios.post).toHaveBeenCalledWith(
        platform.buildChatCompletionsUrl('https://api.moonshot.cn/v1'),
        expect.objectContaining({ model: 'moonshot-v1-128k' }),
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
          accountId: 'acc-kimi-1',
          requestedModel: 'moonshot-v1-8k',
          sessionHash
        })
      )
      expect(result).toEqual({ handled: 'json' })
    })

    test('forwards stream requests to stream handler and configures proxy agent', async () => {
      const crypto = require('crypto')
      const axios = require('axios')
      const proxyHelper = require('../src/utils/proxyHelper')
      const kimiAccountService = require('../src/services/account/kimiAccountService')

      const proxyAgent = { kind: 'agent' }
      proxyHelper.createProxyAgent.mockReturnValue(proxyAgent)
      kimiAccountService.getAccount.mockResolvedValue({
        id: 'acc-kimi-1',
        name: 'Kimi Stream',
        apiKey: 'secret-key',
        baseApi: 'https://api.moonshot.cn/v1',
        supportedModels: {},
        proxy: { url: 'http://127.0.0.1:7890' }
      })

      const upstreamResponse = { status: 200, data: { on: jest.fn() } }
      axios.post.mockResolvedValue(upstreamResponse)

      const streamHandlerSpy = jest
        .spyOn(svc, '_handleStreamResponse')
        .mockResolvedValue({ handled: 'stream' })

      const req = {
        apiKey: { id: 'key-1', permissions: ['kimi'] },
        body: {
          model: 'moonshot-v1-8k',
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
          accountId: 'acc-kimi-1',
          requestedModel: 'moonshot-v1-8k',
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
      const platform = require('../src/services/kimiPlatform')
      const kimiAccountService = require('../src/services/account/kimiAccountService')

      kimiAccountService.getAccount.mockResolvedValue({
        id: 'acc-kimi-1',
        name: 'Kimi Anthropic',
        apiKey: 'anthropic-secret',
        baseApi: 'https://api.moonshot.cn/v1',
        supportedModels: {},
        proxy: null
      })

      const upstreamResponse = { status: 200, data: { ok: true } }
      axios.post.mockResolvedValue(upstreamResponse)

      const anthropicHandlerSpy = jest
        .spyOn(svc, '_handleAnthropicJsonResponse')
        .mockResolvedValue({ handled: 'anthropic' })

      const req = {
        apiKey: { id: 'key-1', permissions: ['kimi'] },
        body: { model: 'moonshot-v1-8k', messages: [] },
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
        platform.buildAnthropicMessagesUrl('https://api.moonshot.cn/v1'),
        expect.objectContaining({ model: 'moonshot-v1-8k' }),
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
          accountId: 'acc-kimi-1',
          requestedModel: 'moonshot-v1-8k'
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
        accountId: 'acc-kimi-1',
        requestedModel: 'moonshot-v1-8k',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(upstreamStatusSpy).toHaveBeenCalledWith(
        429,
        upstreamResponse.data,
        'acc-kimi-1',
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
        data: { id: 'resp-1', model: 'moonshot-v1-8k', choices: [] }
      }

      await svc._handleJsonResponse(req, res, {
        upstreamResponse,
        body: { messages: [] },
        accountId: 'acc-kimi-1',
        requestedModel: 'moonshot-v1-8k',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(recordUsageSpy).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Kimi non-stream response missing usage')
      )
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith(upstreamResponse.data)
    })

    test('_handleStreamResponse records captured usage and clears rate limits on end', async () => {
      const unifiedKimiScheduler = require('../src/services/scheduler/unifiedKimiScheduler')
      const { IncrementalSSEParser } = require('../src/utils/sseParser')
      const req = createReq()
      const res = createRes()
      const upstreamStream = new EventEmitter()
      upstreamStream.destroy = jest.fn()
      const recordUsageSpy = jest.spyOn(svc, '_recordUsage').mockResolvedValue({
        totalInputTokens: 3
      })

      unifiedKimiScheduler.isAccountRateLimited.mockResolvedValue(true)
      unifiedKimiScheduler.removeAccountRateLimit.mockResolvedValue(undefined)
      jest.spyOn(IncrementalSSEParser.prototype, 'feed').mockReturnValue([
        {
          type: 'data',
          data: {
            id: 'chatcmpl-1',
            created: 123,
            model: 'moonshot-v1-8k',
            usage: { prompt_tokens: 3, completion_tokens: 2 },
            choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }]
          }
        }
      ])
      jest.spyOn(IncrementalSSEParser.prototype, 'getRemaining').mockReturnValue('')

      await svc._handleStreamResponse(req, res, {
        upstreamResponse: { status: 200, data: upstreamStream },
        body: { messages: [{ role: 'user', content: 'hi' }] },
        accountId: 'acc-kimi-1',
        requestedModel: 'moonshot-v1-8k',
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
          accountId: 'acc-kimi-1',
          stream: true,
          statusCode: 200
        })
      )
      expect(unifiedKimiScheduler.removeAccountRateLimit).toHaveBeenCalledWith('acc-kimi-1')
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
        accountId: 'acc-kimi-1',
        requestedModel: 'moonshot-v1-8k',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(upstreamStatusSpy).toHaveBeenCalledWith(
        503,
        upstreamResponse.data,
        'acc-kimi-1',
        'session-hash'
      )
      expect(res.status).toHaveBeenCalledWith(503)
      expect(res.json).toHaveBeenCalledWith(upstreamResponse.data)
    })

    test('_handleAnthropicStreamResponse records assistant content and destroys the upstream stream on close', async () => {
      const unifiedKimiScheduler = require('../src/services/scheduler/unifiedKimiScheduler')
      const { IncrementalSSEParser } = require('../src/utils/sseParser')
      const req = createReq()
      const res = createRes()
      const upstreamStream = new EventEmitter()
      upstreamStream.destroy = jest.fn()
      const recordUsageSpy = jest.spyOn(svc, '_recordUsage').mockResolvedValue({
        totalInputTokens: 4
      })

      unifiedKimiScheduler.isAccountRateLimited.mockResolvedValue(true)
      unifiedKimiScheduler.removeAccountRateLimit.mockResolvedValue(undefined)
      jest.spyOn(IncrementalSSEParser.prototype, 'feed').mockReturnValue([
        {
          type: 'data',
          data: {
            id: 'msg-1',
            message: {
              model: 'moonshot-v1-8k',
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
        accountId: 'acc-kimi-1',
        requestedModel: 'moonshot-v1-8k',
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
          accountId: 'acc-kimi-1',
          protocol: 'anthropic',
          assistantContent: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'done' }
          ]
        })
      )
      expect(unifiedKimiScheduler.removeAccountRateLimit).toHaveBeenCalledWith('acc-kimi-1')
      expect(upstreamStream.destroy).toHaveBeenCalled()
      expect(res.end).toHaveBeenCalled()
    })
  })

  describe('_recordUsage and upstream error helpers', () => {
    test('records OpenAI usage with synthesized input block metadata', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      const kimiAccountService = require('../src/services/account/kimiAccountService')
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
        model: 'moonshot-v1-8k',
        accountId: 'acc-kimi-1',
        sessionHash: 'hashed-session',
        stream: false,
        statusCode: 200,
        requestedModel: 'moonshot-v1-8k'
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
        'moonshot-v1-8k',
        'acc-kimi-1',
        'kimi',
        { meta: 'openai' },
        { detail: true }
      )
      expect(kimiAccountService.updateUsageQuota).toHaveBeenCalledWith('acc-kimi-1', 1.25)
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
        model: 'moonshot-v1-8k',
        accountId: 'acc-kimi-1',
        sessionHash: 'hashed-session',
        stream: true,
        statusCode: 200,
        protocol: 'anthropic',
        assistantContent: [{ type: 'text', text: 'done' }],
        requestedModel: 'moonshot-v1-8k'
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
      const unifiedKimiScheduler = require('../src/services/scheduler/unifiedKimiScheduler')
      const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

      await svc._handleUpstreamStatus(401, { error: 'bad auth' }, 'acc-kimi-1', 'session-hash')
      expect(unifiedKimiScheduler.markAccountUnauthorized).toHaveBeenCalledWith(
        'acc-kimi-1',
        'Kimi upstream auth failed (401)'
      )
      expect(unifiedKimiScheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash')

      await svc._handleUpstreamStatus(429, { error: 'rate limited' }, 'acc-kimi-1', 'session-hash')
      expect(unifiedKimiScheduler.markAccountRateLimited).toHaveBeenCalledWith(
        'acc-kimi-1',
        'session-hash'
      )

      await svc._handleUpstreamStatus(529, { error: 'overloaded' }, 'acc-kimi-1', 'session-hash')
      expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
        'acc-kimi-1',
        'kimi',
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

      await svc._handleRequestError(req, res, new Error('canceled'), 'acc-kimi-1', 'session-hash')

      expect(res.status).toHaveBeenCalledWith(499)
      expect(res.json).toHaveBeenCalledWith({
        error: { message: 'Client closed request' }
      })
    })
  })
})
