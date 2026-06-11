// Mock logger to suppress console output during tests
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

// Mock redis to avoid real connection
jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => ({
    hgetall: jest.fn(),
    hset: jest.fn(),
    sadd: jest.fn(),
    srem: jest.fn(),
    del: jest.fn()
  })),
  getAllIdsByIndex: jest.fn().mockResolvedValue([]),
  batchHgetallChunked: jest.fn().mockResolvedValue([]),
  addToIndex: jest.fn().mockResolvedValue(undefined),
  removeFromIndex: jest.fn().mockResolvedValue(undefined),
  getDateStringInTimezone: jest.fn().mockReturnValue('2026-06-09')
}))

// Mock encryptor
jest.mock('../src/utils/commonHelper', () => ({
  createEncryptor: jest.fn(() => ({
    encrypt: jest.fn((v) => `enc:${v}`),
    decrypt: jest.fn((v) => v.replace('enc:', ''))
  })),
  isActive: jest.fn((v) => v === true || v === 'true'),
  isSchedulable: jest.fn((v) => v !== 'false' && v !== false),
  sortAccountsByPriority: jest.fn((arr) => arr)
}))

// Mock upstreamErrorHelper
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  clearTempUnavailable: jest.fn().mockResolvedValue(undefined),
  recordErrorHistory: jest.fn().mockResolvedValue(undefined),
  isTempUnavailable: jest.fn().mockResolvedValue(false)
}))

// Mock platform modules
jest.mock('../src/services/minimaxPlatform', () => ({
  MINIMAX_PLATFORM: { accountSubType: 'minimax', chatPath: '/chat/completions' },
  MINIMAX_DEFAULT_BASE_API: 'https://api.minimaxi.com/v1',
  MINIMAX_DEFAULT_MODEL: 'MiniMax-Text-01',
  normalizeBaseApi: jest.fn((v) => v || 'https://api.minimaxi.com/v1'),
  buildChatCompletionsUrl: jest.fn((base) => `${base}/chat/completions`),
  buildAnthropicMessagesUrl: jest.fn((base) => `${base}/v1/messages`),
  normalizeMiniMaxUsage: jest.fn(),
  normalizeMiniMaxAnthropicUsage: jest.fn()
}))

jest.mock('../src/services/deepseekPlatform', () => ({
  DEEPSEEK_PLATFORM: { accountSubType: 'deepseek', chatPath: '/chat/completions' },
  DEEPSEEK_DEFAULT_BASE_API: 'https://api.deepseek.com/v1',
  DEEPSEEK_DEFAULT_MODEL: 'deepseek-chat',
  normalizeBaseApi: jest.fn((v) => v || 'https://api.deepseek.com/v1')
}))

jest.mock('../src/services/glmPlatform', () => ({
  GLM_PLATFORM: { accountSubType: 'glm', chatPath: '/chat/completions' },
  GLM_DEFAULT_BASE_API: 'https://open.bigmodel.cn/api/paas/v4',
  GLM_DEFAULT_MODEL: 'glm-4-flash',
  normalizeBaseApi: jest.fn((v) => v || 'https://open.bigmodel.cn/api/paas/v4')
}))

jest.mock('../src/services/kimiPlatform', () => ({
  KIMI_PLATFORM: { accountSubType: 'kimi', chatPath: '/chat/completions' },
  KIMI_DEFAULT_BASE_API: 'https://api.moonshot.cn/v1',
  KIMI_DEFAULT_MODEL: 'moonshot-v1-8k',
  normalizeBaseApi: jest.fn((v) => v || 'https://api.moonshot.cn/v1')
}))

// Mock dependencies only used in relay service
jest.mock('axios')
jest.mock('../src/utils/proxyHelper', () => jest.fn())
jest.mock('../src/utils/headerFilter', () => ({
  filterForClaude: jest.fn(),
  filterForOpenAI: jest.fn()
}))
jest.mock('../src/utils/sseParser', () => ({
  IncrementalSSEParser: jest.fn()
}))
jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))
jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(),
  buildCompletionUsageSummary: jest.fn(),
  formatCompletionUsageLog: jest.fn()
}))
jest.mock('../src/utils/userInputExtractor', () => ({
  buildUsageMetadata: jest.fn(),
  buildInputMessagesBlock: jest.fn()
}))
jest.mock('../src/services/apiKeyService', () => ({
  recordUsageWithDetails: jest.fn()
}))
jest.mock('../src/services/accountGroupService', () => ({
  getSharedAccounts: jest.fn().mockResolvedValue([]),
  getGroupById: jest.fn().mockResolvedValue(null)
}))
jest.mock('config/config', () => ({ requestTimeout: 600000 }), { virtual: true })
jest.mock('../config/config', () => ({ requestTimeout: 600000 }))

// ─── Account Service: shared model-mapping methods ────────────────────────────

describe('Account Service – _processModelMapping', () => {
  let service

  beforeEach(() => {
    jest.resetModules()
    service = require('../src/services/account/minimaxAccountService')
  })

  it('returns {} for null', () => {
    expect(service._processModelMapping(null)).toEqual({})
  })

  it('returns {} for undefined', () => {
    expect(service._processModelMapping(undefined)).toEqual({})
  })

  it('returns {} for empty array', () => {
    expect(service._processModelMapping([])).toEqual({})
  })

  it('converts string array to identity mapping', () => {
    expect(service._processModelMapping(['gpt-4o', 'gpt-4'])).toEqual({
      'gpt-4o': 'gpt-4o',
      'gpt-4': 'gpt-4'
    })
  })

  it('skips non-string items in array', () => {
    expect(service._processModelMapping(['gpt-4o', null, 42, ''])).toEqual({
      'gpt-4o': 'gpt-4o'
    })
  })

  it('returns plain object as-is', () => {
    const mapping = { 'claude-3': 'claude-3-5-sonnet', 'gpt-4': 'gpt-4o' }
    expect(service._processModelMapping(mapping)).toEqual(mapping)
  })

  it('returns {} for other falsy values', () => {
    expect(service._processModelMapping(0)).toEqual({})
    expect(service._processModelMapping('')).toEqual({})
  })
})

describe('Account Service – isModelSupported', () => {
  let service

  beforeEach(() => {
    jest.resetModules()
    service = require('../src/services/account/minimaxAccountService')
  })

  it('returns true when mapping is empty (no restriction)', () => {
    expect(service.isModelSupported({}, 'any-model')).toBe(true)
  })

  it('returns true when mapping is null', () => {
    expect(service.isModelSupported(null, 'any-model')).toBe(true)
  })

  it('returns true for exact key match', () => {
    expect(service.isModelSupported({ 'gpt-4o': 'gpt-4o' }, 'gpt-4o')).toBe(true)
  })

  it('returns true for case-insensitive key match', () => {
    expect(service.isModelSupported({ 'GPT-4O': 'gpt-4o' }, 'gpt-4o')).toBe(true)
    expect(service.isModelSupported({ 'gpt-4o': 'gpt-4o' }, 'GPT-4O')).toBe(true)
  })

  it('returns false when model is not in mapping', () => {
    expect(service.isModelSupported({ 'gpt-4o': 'gpt-4o' }, 'gpt-3.5')).toBe(false)
  })
})

describe('Account Service – getMappedModel', () => {
  let service

  beforeEach(() => {
    jest.resetModules()
    service = require('../src/services/account/minimaxAccountService')
  })

  it('returns original model when mapping is empty', () => {
    expect(service.getMappedModel({}, 'gpt-4o')).toBe('gpt-4o')
  })

  it('returns original model when mapping is null', () => {
    expect(service.getMappedModel(null, 'gpt-4o')).toBe('gpt-4o')
  })

  it('returns mapped value for exact key match', () => {
    expect(service.getMappedModel({ 'claude-3': 'claude-3-5-sonnet' }, 'claude-3')).toBe(
      'claude-3-5-sonnet'
    )
  })

  it('returns mapped value for case-insensitive key match', () => {
    expect(service.getMappedModel({ 'GPT-4O': 'gpt-4o-mini' }, 'gpt-4o')).toBe('gpt-4o-mini')
  })

  it('returns original model when key is not in mapping', () => {
    expect(service.getMappedModel({ 'gpt-4o': 'gpt-4o-mini' }, 'gpt-3.5')).toBe('gpt-3.5')
  })
})

// ─── All four platforms have identical implementations ────────────────────────

describe('Model mapping methods are consistent across all four platforms', () => {
  const platforms = [
    '../src/services/account/minimaxAccountService',
    '../src/services/account/deepseekAccountService',
    '../src/services/account/glmAccountService',
    '../src/services/account/kimiAccountService'
  ]

  for (const modulePath of platforms) {
    describe(modulePath.split('/').pop(), () => {
      let service

      beforeEach(() => {
        jest.resetModules()
        service = require(modulePath)
      })

      it('_processModelMapping: array → identity mapping', () => {
        expect(service._processModelMapping(['model-a', 'model-b'])).toEqual({
          'model-a': 'model-a',
          'model-b': 'model-b'
        })
      })

      it('isModelSupported: empty mapping allows all', () => {
        expect(service.isModelSupported({}, 'anything')).toBe(true)
      })

      it('getMappedModel: maps correctly', () => {
        expect(service.getMappedModel({ src: 'dst' }, 'src')).toBe('dst')
        expect(service.getMappedModel({ src: 'dst' }, 'unknown')).toBe('unknown')
      })
    })
  }
})

// ─── Scheduler: _isAccountUsable with object supportedModels ─────────────────

describe('UnifiedMiniMaxScheduler – _isAccountUsable with object supportedModels', () => {
  let scheduler

  beforeEach(() => {
    scheduler = require('../src/services/scheduler/unifiedMinimaxScheduler')
    jest.spyOn(Object.getPrototypeOf(scheduler), 'isAccountRateLimited').mockResolvedValue(false)
    require('../src/utils/upstreamErrorHelper').isTempUnavailable.mockResolvedValue(false)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const makeAccount = (overrides = {}) => ({
    id: 'acct-1',
    isActive: true,
    schedulable: true,
    status: 'active',
    supportedModels: {},
    ...overrides
  })

  it('returns true when supportedModels is empty object (no restriction)', async () => {
    const result = await scheduler._isAccountUsable(
      makeAccount({ supportedModels: {} }),
      'any-model'
    )
    expect(result).toBe(true)
  })

  it('returns true when requested model is in object supportedModels', async () => {
    const account = makeAccount({ supportedModels: { 'MiniMax-Text-01': 'MiniMax-Text-01' } })
    const result = await scheduler._isAccountUsable(account, 'MiniMax-Text-01')
    expect(result).toBe(true)
  })

  it('returns false when requested model is NOT in object supportedModels', async () => {
    const account = makeAccount({ supportedModels: { 'MiniMax-Text-01': 'MiniMax-Text-01' } })
    const result = await scheduler._isAccountUsable(account, 'other-model')
    expect(result).toBe(false)
  })

  it('returns true when supportedModels is null (no restriction)', async () => {
    const result = await scheduler._isAccountUsable(
      makeAccount({ supportedModels: null }),
      'any-model'
    )
    expect(result).toBe(true)
  })

  it('returns false when account is not active', async () => {
    const result = await scheduler._isAccountUsable(makeAccount({ isActive: false }), 'any-model')
    expect(result).toBe(false)
  })

  it('returns false when account status is quotaExceeded', async () => {
    const result = await scheduler._isAccountUsable(
      makeAccount({ status: 'quotaExceeded', schedulable: 'false' }),
      'any-model'
    )
    expect(result).toBe(false)
  })
})

describe('UnifiedMiniMaxScheduler – sticky session and binding flows', () => {
  let scheduler
  let redis
  let minimaxAccountService
  let upstreamErrorHelper
  let redisClient

  beforeEach(() => {
    jest.resetModules()
    scheduler = require('../src/services/scheduler/unifiedMinimaxScheduler')
    redis = require('../src/models/redis')
    minimaxAccountService = require('../src/services/account/minimaxAccountService')
    upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

    redisClient = {
      get: jest.fn(),
      setex: jest.fn(),
      expire: jest.fn(),
      del: jest.fn(),
      hgetall: jest.fn(),
      hset: jest.fn(),
      sadd: jest.fn(),
      srem: jest.fn()
    }
    redis.getClientSafe.mockReturnValue(redisClient)
    upstreamErrorHelper.isTempUnavailable.mockResolvedValue(false)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('reuses sticky account when existing mapping is still available', async () => {
    jest.spyOn(scheduler, '_getSessionMapping').mockResolvedValue({ accountId: 'acct-sticky' })
    jest.spyOn(scheduler, '_isAccountAvailable').mockResolvedValue(true)
    jest.spyOn(scheduler, '_extendSessionMappingTTL').mockResolvedValue(undefined)
    const markAccountUsedSpy = jest
      .spyOn(minimaxAccountService, 'markAccountUsed')
      .mockResolvedValue(undefined)

    const result = await scheduler.selectAccountForApiKey({ id: 'key-1' }, 'session-hash')

    expect(result).toEqual({ accountId: 'acct-sticky', accountType: 'minimax' })
    expect(scheduler._extendSessionMappingTTL).toHaveBeenCalledWith('session-hash')
    expect(markAccountUsedSpy).toHaveBeenCalledWith('acct-sticky')
  })

  it('clears stale sticky mapping and selects a fresh account', async () => {
    jest.spyOn(scheduler, '_getSessionMapping').mockResolvedValue({ accountId: 'acct-stale' })
    jest.spyOn(scheduler, '_isAccountAvailable').mockResolvedValue(false)
    jest.spyOn(scheduler, 'clearSessionMapping').mockResolvedValue(undefined)
    jest
      .spyOn(scheduler, '_getAllAvailableAccounts')
      .mockResolvedValue([{ id: 'acct-new', name: 'MiniMax A', priority: 10 }])
    jest.spyOn(scheduler, '_setSessionMapping').mockResolvedValue(undefined)
    jest.spyOn(minimaxAccountService, 'markAccountUsed').mockResolvedValue(undefined)

    const result = await scheduler.selectAccountForApiKey({ id: 'key-1' }, 'session-hash')

    expect(scheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash')
    expect(scheduler._setSessionMapping).toHaveBeenCalledWith('session-hash', 'acct-new')
    expect(result).toEqual({ accountId: 'acct-new', accountType: 'minimax' })
  })

  it('uses group binding when api key is bound to a group', async () => {
    const selectAccountFromGroupSpy = jest
      .spyOn(scheduler, 'selectAccountFromGroup')
      .mockResolvedValue([{ id: 'acct-group-1' }])

    const result = await scheduler._getAllAvailableAccounts(
      {
        accountBindings: {
          minimax: {
            groupId: 'group-1'
          }
        }
      },
      'MiniMax-Text-01'
    )

    expect(selectAccountFromGroupSpy).toHaveBeenCalledWith(
      'group-1',
      null,
      'MiniMax-Text-01',
      expect.objectContaining({
        accountBindings: expect.any(Object)
      }),
      { returnCandidates: true }
    )
    expect(result).toEqual([{ id: 'acct-group-1' }])
  })

  it('clears legacy rate limit state when status is rateLimited but flag is missing', async () => {
    jest.spyOn(minimaxAccountService, 'getAccount').mockResolvedValue({
      id: 'acct-legacy',
      status: 'rateLimited',
      rateLimitStatus: ''
    })
    const setAccountRateLimitedSpy = jest
      .spyOn(minimaxAccountService, 'setAccountRateLimited')
      .mockResolvedValue(undefined)

    const result = await scheduler.isAccountRateLimited('acct-legacy')

    expect(result).toBe(false)
    expect(setAccountRateLimitedSpy).toHaveBeenCalledWith('acct-legacy', false)
  })

  it('marks account rate limited and clears sticky mapping when session hash exists', async () => {
    const setAccountRateLimitedSpy = jest
      .spyOn(minimaxAccountService, 'setAccountRateLimited')
      .mockResolvedValue(undefined)
    jest.spyOn(scheduler, 'clearSessionMapping').mockResolvedValue(undefined)

    await scheduler.markAccountRateLimited('acct-1', 'session-hash', 30)

    expect(setAccountRateLimitedSpy).toHaveBeenCalledWith('acct-1', true, 30)
    expect(scheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash')
  })

  it('parses and clears redis-backed session mappings safely', async () => {
    redisClient.get
      .mockResolvedValueOnce('{"accountId":"acct-1"}')
      .mockResolvedValueOnce('bad json')

    await expect(scheduler._getSessionMapping('hash-1')).resolves.toEqual({ accountId: 'acct-1' })
    await expect(scheduler._getSessionMapping('hash-2')).resolves.toBeNull()

    await scheduler.clearSessionMapping('hash-3')
    expect(redisClient.del).toHaveBeenCalledWith('minimax_session_mapping:hash-3')
  })
})

// ─── Relay Service: _buildRequestBody / _buildAnthropicRequestBody ────────────

describe('MiniMaxRelayService – _buildRequestBody with mappedModel', () => {
  let relayService

  beforeEach(() => {
    jest.resetModules()
    relayService = require('../src/services/relay/minimaxRelayService')
  })

  it('uses mappedModel when provided', () => {
    const body = { model: 'original-model', messages: [] }
    const result = relayService._buildRequestBody(body, 'mapped-model')
    expect(result.model).toBe('mapped-model')
  })

  it('falls back to normalized model when mappedModel is falsy', () => {
    const body = { model: 'original-model', messages: [] }
    const result = relayService._buildRequestBody(body, null)
    expect(result.model).toBe('original-model')
  })

  it('adds stream_options when stream is true', () => {
    const body = { model: 'model-a', stream: true }
    const result = relayService._buildRequestBody(body, 'model-a')
    expect(result.stream_options).toEqual(expect.objectContaining({ include_usage: true }))
  })

  it('does not add stream_options when stream is false', () => {
    const body = { model: 'model-a', stream: false }
    const result = relayService._buildRequestBody(body, 'model-a')
    expect(result.stream_options).toBeUndefined()
  })
})

describe('MiniMaxRelayService – _buildAnthropicRequestBody with mappedModel', () => {
  let relayService

  beforeEach(() => {
    jest.resetModules()
    relayService = require('../src/services/relay/minimaxRelayService')
  })

  it('uses mappedModel when provided', () => {
    const body = { model: 'original-model', messages: [] }
    const result = relayService._buildAnthropicRequestBody(body, 'mapped-model')
    expect(result.model).toBe('mapped-model')
  })

  it('falls back to normalized model when mappedModel is falsy', () => {
    const body = { model: 'original-model', messages: [] }
    const result = relayService._buildAnthropicRequestBody(body, undefined)
    expect(result.model).toBe('original-model')
  })

  it('does not mutate original body', () => {
    const body = { model: 'original-model', messages: [] }
    relayService._buildAnthropicRequestBody(body, 'mapped-model')
    expect(body.model).toBe('original-model')
  })
})

// ─── models config: GLM and Kimi model lists ─────────────────────────────────

describe('models config – GLM and Kimi model lists', () => {
  const { GLM_MODELS, KIMI_MODELS, PLATFORM_TEST_MODELS } = require('../config/models')

  it('exports GLM_MODELS with expected entries', () => {
    expect(Array.isArray(GLM_MODELS)).toBe(true)
    expect(GLM_MODELS.some((m) => m.value === 'glm-4-flash')).toBe(true)
  })

  it('exports KIMI_MODELS with expected entries', () => {
    expect(Array.isArray(KIMI_MODELS)).toBe(true)
    expect(KIMI_MODELS.some((m) => m.value === 'moonshot-v1-8k')).toBe(true)
  })

  it('PLATFORM_TEST_MODELS maps glm and kimi', () => {
    expect(PLATFORM_TEST_MODELS['glm']).toBe(GLM_MODELS)
    expect(PLATFORM_TEST_MODELS['kimi']).toBe(KIMI_MODELS)
  })
})
