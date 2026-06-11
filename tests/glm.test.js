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

  describe('handleChatCompletions — forwarding paths', () => {
    test('forwards non-stream requests to json handler with mapped model', async () => {
      const crypto = require('crypto')
      const axios = require('axios')
      const platform = require('../src/services/glmPlatform')
      const glmAccountService = require('../src/services/account/glmAccountService')
      const unifiedGlmScheduler = require('../src/services/scheduler/unifiedGlmScheduler')

      glmAccountService.getAccount.mockResolvedValue({
        id: 'acc-glm-1',
        name: 'GLM A',
        apiKey: 'secret-key',
        baseApi: 'https://open.bigmodel.cn/api/paas/v4',
        supportedModels: { 'glm-4-flash': 'glm-4-plus' },
        proxy: null
      })
      glmAccountService.getMappedModel.mockReturnValue('glm-4-plus')

      const upstreamResponse = { status: 200, data: { ok: true } }
      axios.post.mockResolvedValue(upstreamResponse)

      const jsonHandlerSpy = jest
        .spyOn(svc, '_handleJsonResponse')
        .mockResolvedValue({ handled: 'json' })
      const streamHandlerSpy = jest.spyOn(svc, '_handleStreamResponse').mockResolvedValue(null)

      const req = {
        apiKey: { id: 'key-1', permissions: ['glm'] },
        body: { model: 'glm-4-flash', messages: [] },
        headers: { 'x-session-id': 'sess-1', 'x-extra': '1' },
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

      expect(unifiedGlmScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
        req.apiKey,
        sessionHash,
        'glm-4-flash'
      )
      expect(axios.post).toHaveBeenCalledWith(
        platform.buildChatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4'),
        expect.objectContaining({
          model: 'glm-4-plus'
        }),
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
          accountId: 'acc-glm-1',
          requestedModel: 'glm-4-flash',
          sessionHash
        })
      )
      expect(result).toEqual({ handled: 'json' })
    })

    test('forwards stream requests to stream handler and configures proxy agent', async () => {
      const crypto = require('crypto')
      const axios = require('axios')
      const proxyHelper = require('../src/utils/proxyHelper')
      const glmAccountService = require('../src/services/account/glmAccountService')

      const proxyAgent = { kind: 'agent' }
      proxyHelper.createProxyAgent.mockReturnValue(proxyAgent)
      glmAccountService.getAccount.mockResolvedValue({
        id: 'acc-glm-1',
        name: 'GLM Stream',
        apiKey: 'secret-key',
        baseApi: 'https://open.bigmodel.cn/api/paas/v4',
        supportedModels: {},
        proxy: { url: 'http://127.0.0.1:7890' }
      })

      const upstreamResponse = { status: 200, data: { on: jest.fn() } }
      axios.post.mockResolvedValue(upstreamResponse)

      const streamHandlerSpy = jest
        .spyOn(svc, '_handleStreamResponse')
        .mockResolvedValue({ handled: 'stream' })

      const req = {
        apiKey: { id: 'key-1', permissions: ['glm'] },
        body: { model: 'glm-4-flash', messages: [], stream: true, stream_options: { foo: 'bar' } },
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
          accountId: 'acc-glm-1',
          requestedModel: 'glm-4-flash',
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
      const platform = require('../src/services/glmPlatform')
      const glmAccountService = require('../src/services/account/glmAccountService')

      glmAccountService.getAccount.mockResolvedValue({
        id: 'acc-glm-1',
        name: 'GLM Anthropic',
        apiKey: 'anthropic-secret',
        baseApi: 'https://open.bigmodel.cn/api/paas/v4',
        supportedModels: {},
        proxy: null
      })

      const upstreamResponse = { status: 200, data: { ok: true } }
      axios.post.mockResolvedValue(upstreamResponse)

      const anthropicHandlerSpy = jest
        .spyOn(svc, '_handleAnthropicJsonResponse')
        .mockResolvedValue({ handled: 'anthropic' })

      const req = {
        apiKey: { id: 'key-1', permissions: ['glm'] },
        body: { model: 'glm-4-flash', messages: [] },
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
        platform.buildAnthropicMessagesUrl('https://open.bigmodel.cn/api/paas/v4'),
        expect.objectContaining({
          model: 'glm-4-flash'
        }),
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
          accountId: 'acc-glm-1',
          requestedModel: 'glm-4-flash'
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
        accountId: 'acc-glm-1',
        requestedModel: 'glm-4-flash',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(upstreamStatusSpy).toHaveBeenCalledWith(
        429,
        upstreamResponse.data,
        'acc-glm-1',
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
        data: { id: 'resp-1', model: 'glm-4-flash', choices: [] }
      }

      await svc._handleJsonResponse(req, res, {
        upstreamResponse,
        body: { messages: [] },
        accountId: 'acc-glm-1',
        requestedModel: 'glm-4-flash',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(recordUsageSpy).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('GLM non-stream response missing usage')
      )
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith(upstreamResponse.data)
    })

    test('_handleStreamResponse records captured usage and clears rate limits on end', async () => {
      const unifiedGlmScheduler = require('../src/services/scheduler/unifiedGlmScheduler')
      const { IncrementalSSEParser } = require('../src/utils/sseParser')
      const req = createReq()
      const res = createRes()
      const upstreamStream = new EventEmitter()
      upstreamStream.destroy = jest.fn()
      const recordUsageSpy = jest.spyOn(svc, '_recordUsage').mockResolvedValue({
        totalInputTokens: 3
      })

      unifiedGlmScheduler.isAccountRateLimited.mockResolvedValue(true)
      unifiedGlmScheduler.removeAccountRateLimit.mockResolvedValue(undefined)
      jest.spyOn(IncrementalSSEParser.prototype, 'feed').mockReturnValue([
        {
          type: 'data',
          data: {
            id: 'chatcmpl-1',
            created: 123,
            model: 'glm-4-flash',
            usage: { prompt_tokens: 3, completion_tokens: 2 },
            choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }]
          }
        }
      ])
      jest.spyOn(IncrementalSSEParser.prototype, 'getRemaining').mockReturnValue('')

      await svc._handleStreamResponse(req, res, {
        upstreamResponse: { status: 200, data: upstreamStream },
        body: { messages: [{ role: 'user', content: 'hi' }] },
        accountId: 'acc-glm-1',
        requestedModel: 'glm-4-flash',
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
          accountId: 'acc-glm-1',
          stream: true,
          statusCode: 200
        })
      )
      expect(unifiedGlmScheduler.removeAccountRateLimit).toHaveBeenCalledWith('acc-glm-1')
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
        accountId: 'acc-glm-1',
        requestedModel: 'glm-4-flash',
        sessionHash: 'session-hash',
        startTime: Date.now()
      })

      expect(upstreamStatusSpy).toHaveBeenCalledWith(
        503,
        upstreamResponse.data,
        'acc-glm-1',
        'session-hash'
      )
      expect(res.status).toHaveBeenCalledWith(503)
      expect(res.json).toHaveBeenCalledWith(upstreamResponse.data)
    })

    test('_handleAnthropicStreamResponse records assistant content and destroys the upstream stream on close', async () => {
      const unifiedGlmScheduler = require('../src/services/scheduler/unifiedGlmScheduler')
      const { IncrementalSSEParser } = require('../src/utils/sseParser')
      const req = createReq()
      const res = createRes()
      const upstreamStream = new EventEmitter()
      upstreamStream.destroy = jest.fn()
      const recordUsageSpy = jest.spyOn(svc, '_recordUsage').mockResolvedValue({
        totalInputTokens: 4
      })

      unifiedGlmScheduler.isAccountRateLimited.mockResolvedValue(true)
      unifiedGlmScheduler.removeAccountRateLimit.mockResolvedValue(undefined)
      jest.spyOn(IncrementalSSEParser.prototype, 'feed').mockReturnValue([
        {
          type: 'data',
          data: {
            id: 'msg-1',
            message: {
              model: 'glm-4-flash',
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
        accountId: 'acc-glm-1',
        requestedModel: 'glm-4-flash',
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
          accountId: 'acc-glm-1',
          protocol: 'anthropic',
          assistantContent: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'done' }
          ]
        })
      )
      expect(unifiedGlmScheduler.removeAccountRateLimit).toHaveBeenCalledWith('acc-glm-1')
      expect(upstreamStream.destroy).toHaveBeenCalled()
      expect(res.end).toHaveBeenCalled()
    })
  })

  describe('_recordUsage and upstream error helpers', () => {
    test('records OpenAI usage with synthesized input block metadata', async () => {
      const apiKeyService = require('../src/services/apiKeyService')
      const glmAccountService = require('../src/services/account/glmAccountService')
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
        model: 'glm-4-flash',
        accountId: 'acc-glm-1',
        sessionHash: 'hashed-session',
        stream: false,
        statusCode: 200,
        requestedModel: 'glm-4-flash'
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
        'glm-4-flash',
        'acc-glm-1',
        'glm',
        { meta: 'openai' },
        { detail: true }
      )
      expect(glmAccountService.updateUsageQuota).toHaveBeenCalledWith('acc-glm-1', 1.25)
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
        model: 'glm-4-flash',
        accountId: 'acc-glm-1',
        sessionHash: 'hashed-session',
        stream: true,
        statusCode: 200,
        protocol: 'anthropic',
        assistantContent: [{ type: 'text', text: 'done' }],
        requestedModel: 'glm-4-flash'
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
      const unifiedGlmScheduler = require('../src/services/scheduler/unifiedGlmScheduler')
      const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

      await svc._handleUpstreamStatus(401, { error: 'bad auth' }, 'acc-glm-1', 'session-hash')
      expect(unifiedGlmScheduler.markAccountUnauthorized).toHaveBeenCalledWith(
        'acc-glm-1',
        'GLM upstream auth failed (401)'
      )
      expect(unifiedGlmScheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash')

      await svc._handleUpstreamStatus(429, { error: 'rate limited' }, 'acc-glm-1', 'session-hash')
      expect(unifiedGlmScheduler.markAccountRateLimited).toHaveBeenCalledWith(
        'acc-glm-1',
        'session-hash'
      )

      await svc._handleUpstreamStatus(529, { error: 'overloaded' }, 'acc-glm-1', 'session-hash')
      expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
        'acc-glm-1',
        'glm',
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

      await svc._handleRequestError(req, res, new Error('canceled'), 'acc-glm-1', 'session-hash')

      expect(res.status).toHaveBeenCalledWith(499)
      expect(res.json).toHaveBeenCalledWith({
        error: { message: 'Client closed request' }
      })
    })
  })
})
