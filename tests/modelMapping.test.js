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
  normalizeBaseApi: jest.fn((v) => v || 'https://api.deepseek.com/v1'),
  normalizeOptionalBaseApi: jest.fn((v) => {
    if (v === undefined || v === null) {
      return ''
    }
    return String(v).replace(/\/$/, '')
  })
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
  getGroupById: jest.fn().mockResolvedValue(null),
  getGroupMembers: jest.fn().mockResolvedValue([])
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

describe('Account service mutation helpers are consistent across all four platforms', () => {
  const platforms = [
    {
      name: 'minimax',
      modulePath: '../src/services/account/minimaxAccountService',
      keyPrefix: 'minimax:account:',
      sharedKey: 'shared_minimax_accounts',
      defaultBaseApi: 'https://api.minimaxi.com/v1',
      unsupportedReason: 'MiniMax账号认证失败'
    },
    {
      name: 'deepseek',
      modulePath: '../src/services/account/deepseekAccountService',
      keyPrefix: 'deepseek:account:',
      sharedKey: 'shared_deepseek_accounts',
      defaultBaseApi: 'https://api.deepseek.com/v1',
      unsupportedReason: 'DeepSeek账号认证失败'
    },
    {
      name: 'glm',
      modulePath: '../src/services/account/glmAccountService',
      keyPrefix: 'glm:account:',
      sharedKey: 'shared_glm_accounts',
      defaultBaseApi: 'https://open.bigmodel.cn/api/paas/v4',
      unsupportedReason: 'GLM账号认证失败'
    },
    {
      name: 'kimi',
      modulePath: '../src/services/account/kimiAccountService',
      keyPrefix: 'kimi:account:',
      sharedKey: 'shared_kimi_accounts',
      defaultBaseApi: 'https://api.moonshot.cn/v1',
      unsupportedReason: 'Kimi账号认证失败'
    }
  ]

  const makeRedisClient = () => ({
    hgetall: jest.fn(),
    hset: jest.fn(),
    sadd: jest.fn(),
    srem: jest.fn(),
    del: jest.fn()
  })

  const makeStoredAccount = (platform, overrides = {}) => ({
    id: 'acct-1',
    name: `${platform.name}-account`,
    platform: platform.name,
    accountSubType: platform.name,
    accountType: 'shared',
    apiKey: 'enc:secret-key',
    baseApi: `${platform.defaultBaseApi}/`,
    proxy: '{"host":"127.0.0.1","port":7890}',
    supportedModels: '{"model-a":"model-a-target"}',
    priority: '50',
    dailyQuota: '10',
    dailyUsage: '1.25',
    lastResetDate: '2026-06-09',
    quotaResetTime: '00:00',
    quotaStoppedAt: '',
    rateLimitDuration: '60',
    disableAutoProtection: 'false',
    isActive: 'true',
    schedulable: 'true',
    status: 'active',
    errorMessage: '',
    rateLimitedAt: '',
    rateLimitStatus: '',
    rateLimitResetAt: '',
    ...overrides
  })

  for (const platform of platforms) {
    describe(platform.modulePath.split('/').pop(), () => {
      let service
      let redis
      let upstreamErrorHelper
      let redisClient

      beforeEach(() => {
        jest.resetModules()
        service = require(platform.modulePath)
        redis = require('../src/models/redis')
        upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
        redisClient = makeRedisClient()
        redis.getClientSafe.mockReturnValue(redisClient)
        redis.getDateStringInTimezone.mockReturnValue('2026-06-09')
        redis.getAllIdsByIndex.mockResolvedValue([])
        redis.batchHgetallChunked.mockResolvedValue([])
      })

      afterEach(() => {
        jest.restoreAllMocks()
      })

      it('getAccount decrypts apiKey and parses proxy / supportedModels', async () => {
        redisClient.hgetall.mockResolvedValue(
          makeStoredAccount(platform, {
            proxy: '{"host":"localhost","port":9000}',
            supportedModels: '{"model-a":"model-b"}'
          })
        )

        const account = await service.getAccount('acct-1')

        expect(redisClient.hgetall).toHaveBeenCalledWith(`${platform.keyPrefix}acct-1`)
        expect(account.apiKey).toBe('secret-key')
        expect(account.proxy).toEqual({ host: 'localhost', port: 9000 })
        expect(account.supportedModels).toEqual({ 'model-a': 'model-b' })
      })

      it('updateAccount normalizes persisted fields and updates shared membership', async () => {
        jest
          .spyOn(service, 'getAccount')
          .mockResolvedValueOnce({ accountType: 'private', name: 'Account A' })
          .mockResolvedValueOnce({ accountType: 'shared', name: 'Account B' })

        await service.updateAccount('acct-1', {
          accountType: 'shared',
          apiKey: 'new-key',
          baseApi: 'https://proxy.local',
          proxy: { host: '127.0.0.1', port: 1080 },
          supportedModels: ['model-a', null],
          isActive: false,
          schedulable: true,
          priority: 80,
          dailyQuota: 12.5,
          rateLimitDuration: 90,
          disableAutoProtection: true
        })

        await service.updateAccount('acct-2', { accountType: 'private' })

        expect(redisClient.hset).toHaveBeenNthCalledWith(
          1,
          `${platform.keyPrefix}acct-1`,
          expect.objectContaining({
            accountType: 'shared',
            apiKey: 'enc:new-key',
            baseApi: 'https://proxy.local',
            proxy: '{"host":"127.0.0.1","port":1080}',
            supportedModels: '{"model-a":"model-a"}',
            isActive: 'false',
            schedulable: 'true',
            priority: '80',
            dailyQuota: '12.5',
            rateLimitDuration: '90',
            disableAutoProtection: 'true',
            updatedAt: expect.any(String)
          })
        )
        expect(redisClient.sadd).toHaveBeenCalledWith(platform.sharedKey, 'acct-1')
        expect(redisClient.srem).toHaveBeenCalledWith(platform.sharedKey, 'acct-2')
      })

      it('getAllAccounts filters inactive accounts and formats rate limit metadata', async () => {
        redis.getAllIdsByIndex.mockResolvedValue(['acct-1', 'acct-2', 'acct-3'])
        redis.batchHgetallChunked.mockResolvedValue([
          makeStoredAccount(platform, {
            rateLimitStatus: 'limited',
            rateLimitResetAt: new Date(Date.now() + 5 * 60000).toISOString()
          }),
          makeStoredAccount(platform, {
            id: 'acct-2',
            isActive: 'false'
          }),
          makeStoredAccount(platform, {
            id: 'acct-3',
            proxy: '{bad-json}',
            supportedModels: '{bad-json}'
          })
        ])

        const accounts = await service.getAllAccounts(false)

        expect(accounts).toHaveLength(2)
        expect(accounts[0]).toEqual(
          expect.objectContaining({
            id: 'acct-1',
            apiKey: '***',
            isActive: true,
            schedulable: true,
            rateLimitStatus: expect.objectContaining({
              isRateLimited: true
            })
          })
        )
        expect(accounts[1].proxy).toBeNull()
        expect(accounts[1].supportedModels).toEqual({})
      })

      it('setAccountRateLimited skips protection updates when auto-protection is disabled', async () => {
        jest.spyOn(service, 'getAccount').mockResolvedValue({
          id: 'acct-1',
          name: 'Protected Account',
          disableAutoProtection: 'true'
        })
        const updateAccountSpy = jest.spyOn(service, 'updateAccount').mockResolvedValue(undefined)

        await service.setAccountRateLimited('acct-1', true, 30)

        expect(updateAccountSpy).not.toHaveBeenCalled()
        expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
          'acct-1',
          platform.name,
          429,
          'rate_limit'
        )
      })

      it('setAccountRateLimited writes limited state and clearing resets it', async () => {
        jest
          .spyOn(service, 'getAccount')
          .mockResolvedValueOnce({
            id: 'acct-1',
            name: 'Account A',
            disableAutoProtection: 'false',
            rateLimitDuration: '45'
          })
          .mockResolvedValueOnce({
            id: 'acct-1',
            name: 'Account A',
            disableAutoProtection: 'false'
          })
        const updateAccountSpy = jest.spyOn(service, 'updateAccount').mockResolvedValue(undefined)

        await service.setAccountRateLimited('acct-1', true, 15)
        await service.setAccountRateLimited('acct-1', false)

        expect(updateAccountSpy).toHaveBeenNthCalledWith(
          1,
          'acct-1',
          expect.objectContaining({
            rateLimitStatus: 'limited',
            rateLimitDuration: '15',
            status: 'rateLimited',
            schedulable: 'false',
            errorMessage: expect.stringContaining('Rate limited until')
          })
        )
        expect(updateAccountSpy).toHaveBeenNthCalledWith(
          2,
          'acct-1',
          expect.objectContaining({
            rateLimitStatus: '',
            status: 'active',
            schedulable: 'true',
            errorMessage: ''
          })
        )
      })

      it('markAccountUnauthorized updates state when auto-protection is enabled', async () => {
        jest.spyOn(service, 'getAccount').mockResolvedValue({
          id: 'acct-1',
          name: 'Unauthorized Account',
          disableAutoProtection: 'false'
        })
        const updateAccountSpy = jest.spyOn(service, 'updateAccount').mockResolvedValue(undefined)

        await service.markAccountUnauthorized('acct-1', platform.unsupportedReason)

        expect(updateAccountSpy).toHaveBeenCalledWith(
          'acct-1',
          expect.objectContaining({
            status: 'unauthorized',
            schedulable: 'false',
            errorMessage: platform.unsupportedReason,
            unauthorizedAt: expect.any(String)
          })
        )
      })

      it('checkAndClearRateLimit clears expired limits and toggleSchedulable flips the flag', async () => {
        jest
          .spyOn(service, 'getAccount')
          .mockResolvedValueOnce({
            id: 'acct-1',
            rateLimitStatus: 'limited',
            rateLimitResetAt: new Date(Date.now() - 60000).toISOString()
          })
          .mockResolvedValueOnce({
            id: 'acct-1',
            schedulable: 'true'
          })
        const setAccountRateLimitedSpy = jest
          .spyOn(service, 'setAccountRateLimited')
          .mockResolvedValue(undefined)
        const updateAccountSpy = jest.spyOn(service, 'updateAccount').mockResolvedValue(undefined)

        await expect(service.checkAndClearRateLimit('acct-1')).resolves.toBe(true)
        await expect(service.toggleSchedulable('acct-1')).resolves.toEqual({
          success: true,
          schedulable: false
        })

        expect(setAccountRateLimitedSpy).toHaveBeenCalledWith('acct-1', false)
        expect(updateAccountSpy).toHaveBeenCalledWith('acct-1', { schedulable: 'false' })
      })

      it('resetAccountStatus re-enables scheduling and clears temp unavailable state', async () => {
        jest.spyOn(service, 'getAccount').mockResolvedValue({
          id: 'acct-1',
          apiKey: 'secret-key'
        })
        const updateAccountSpy = jest.spyOn(service, 'updateAccount').mockResolvedValue(undefined)

        await expect(service.resetAccountStatus('acct-1')).resolves.toEqual({
          success: true,
          message: 'Account status reset successfully'
        })

        expect(updateAccountSpy).toHaveBeenCalledWith(
          'acct-1',
          expect.objectContaining({
            status: 'active',
            schedulable: 'true',
            errorMessage: '',
            rateLimitedAt: '',
            rateLimitStatus: '',
            rateLimitResetAt: ''
          })
        )
        expect(upstreamErrorHelper.clearTempUnavailable).toHaveBeenCalledWith(
          'acct-1',
          platform.name
        )
      })

      it('updateUsageQuota accumulates daily usage and stops schedulable accounts at quota', async () => {
        jest.spyOn(service, 'getAccount').mockResolvedValue({
          id: 'acct-1',
          dailyUsage: '9',
          dailyQuota: '10',
          lastResetDate: '2026-06-09',
          quotaStoppedAt: ''
        })
        const updateAccountSpy = jest.spyOn(service, 'updateAccount').mockResolvedValue(undefined)

        await service.updateUsageQuota('acct-1', 2)

        expect(updateAccountSpy).toHaveBeenCalledWith(
          'acct-1',
          expect.objectContaining({
            dailyUsage: '11',
            lastResetDate: '2026-06-09',
            status: 'quotaExceeded',
            schedulable: 'false',
            quotaStoppedAt: expect.any(String),
            errorMessage: 'Daily quota exceeded: $11.00 / $10.00'
          })
        )
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

describe('GLM / Kimi / DeepSeek schedulers reuse the same sticky-session flow', () => {
  const schedulers = [
    {
      name: 'GLM',
      modulePath: '../src/services/scheduler/unifiedGlmScheduler',
      accountServicePath: '../src/services/account/glmAccountService',
      accountType: 'glm',
      bindingKey: 'glm',
      sessionPrefix: 'glm_session_mapping:'
    },
    {
      name: 'Kimi',
      modulePath: '../src/services/scheduler/unifiedKimiScheduler',
      accountServicePath: '../src/services/account/kimiAccountService',
      accountType: 'kimi',
      bindingKey: 'kimi',
      sessionPrefix: 'kimi_session_mapping:'
    },
    {
      name: 'DeepSeek',
      modulePath: '../src/services/scheduler/unifiedDeepSeekScheduler',
      accountServicePath: '../src/services/account/deepseekAccountService',
      accountType: 'deepseek',
      bindingKey: 'deepseek',
      sessionPrefix: 'deepseek_session_mapping:'
    }
  ]

  for (const config of schedulers) {
    describe(`Unified${config.name}Scheduler`, () => {
      let scheduler
      let redis
      let accountService
      let upstreamErrorHelper
      let redisClient

      beforeEach(() => {
        jest.resetModules()
        scheduler = require(config.modulePath)
        redis = require('../src/models/redis')
        accountService = require(config.accountServicePath)
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

      it('reuses sticky accounts while the existing mapping stays available', async () => {
        jest.spyOn(scheduler, '_getSessionMapping').mockResolvedValue({ accountId: 'acct-sticky' })
        jest.spyOn(scheduler, '_isAccountAvailable').mockResolvedValue(true)
        jest.spyOn(scheduler, '_extendSessionMappingTTL').mockResolvedValue(undefined)
        const markAccountUsedSpy = jest
          .spyOn(accountService, 'markAccountUsed')
          .mockResolvedValue(undefined)

        const result = await scheduler.selectAccountForApiKey({ id: 'key-1' }, 'session-hash')

        expect(result).toEqual({ accountId: 'acct-sticky', accountType: config.accountType })
        if (config.accountType === 'deepseek') {
          expect(scheduler._extendSessionMappingTTL).toHaveBeenCalledWith('session-hash', 'chat')
        } else {
          expect(scheduler._extendSessionMappingTTL).toHaveBeenCalledWith('session-hash')
        }
        expect(markAccountUsedSpy).toHaveBeenCalledWith('acct-sticky')
      })

      it('clears stale mappings and selects a fresh account', async () => {
        jest.spyOn(scheduler, '_getSessionMapping').mockResolvedValue({ accountId: 'acct-stale' })
        jest.spyOn(scheduler, '_isAccountAvailable').mockResolvedValue(false)
        jest.spyOn(scheduler, 'clearSessionMapping').mockResolvedValue(undefined)
        jest
          .spyOn(scheduler, '_getAllAvailableAccounts')
          .mockResolvedValue([{ id: 'acct-new', name: `${config.name} A`, priority: 10 }])
        jest.spyOn(scheduler, '_setSessionMapping').mockResolvedValue(undefined)
        jest.spyOn(accountService, 'markAccountUsed').mockResolvedValue(undefined)

        const result = await scheduler.selectAccountForApiKey({ id: 'key-1' }, 'session-hash')

        if (config.accountType === 'deepseek') {
          expect(scheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash', 'chat')
          expect(scheduler._setSessionMapping).toHaveBeenCalledWith(
            'session-hash',
            'acct-new',
            'chat'
          )
        } else {
          expect(scheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash')
          expect(scheduler._setSessionMapping).toHaveBeenCalledWith('session-hash', 'acct-new')
        }
        expect(result).toEqual({ accountId: 'acct-new', accountType: config.accountType })
      })

      it('uses group bindings from api key configuration', async () => {
        const selectAccountFromGroupSpy = jest
          .spyOn(scheduler, 'selectAccountFromGroup')
          .mockResolvedValue([{ id: 'acct-group-1' }])

        const result = await scheduler._getAllAvailableAccounts(
          {
            accountBindings: {
              [config.bindingKey]: {
                groupId: 'group-1'
              }
            }
          },
          'model-a'
        )

        if (config.accountType === 'deepseek') {
          expect(selectAccountFromGroupSpy).toHaveBeenCalledWith(
            'group-1',
            null,
            'model-a',
            expect.objectContaining({
              accountBindings: expect.any(Object)
            }),
            { returnCandidates: true },
            'chat'
          )
        } else {
          expect(selectAccountFromGroupSpy).toHaveBeenCalledWith(
            'group-1',
            null,
            'model-a',
            expect.objectContaining({
              accountBindings: expect.any(Object)
            }),
            { returnCandidates: true }
          )
        }
        expect(result).toEqual([{ id: 'acct-group-1' }])
      })

      it('clears legacy rate-limit state when the flag is missing', async () => {
        jest.spyOn(accountService, 'getAccount').mockResolvedValue({
          id: 'acct-legacy',
          status: 'rateLimited',
          rateLimitStatus: ''
        })
        const setAccountRateLimitedSpy = jest
          .spyOn(accountService, 'setAccountRateLimited')
          .mockResolvedValue(undefined)

        const result = await scheduler.isAccountRateLimited('acct-legacy')

        expect(result).toBe(false)
        expect(setAccountRateLimitedSpy).toHaveBeenCalledWith('acct-legacy', false)
      })

      it('marks accounts rate-limited and clears sticky mappings when session hashes exist', async () => {
        const setAccountRateLimitedSpy = jest
          .spyOn(accountService, 'setAccountRateLimited')
          .mockResolvedValue(undefined)
        jest.spyOn(scheduler, 'clearSessionMapping').mockResolvedValue(undefined)

        await scheduler.markAccountRateLimited('acct-1', 'session-hash', 30)

        expect(setAccountRateLimitedSpy).toHaveBeenCalledWith('acct-1', true, 30)
        if (config.accountType === 'deepseek') {
          expect(scheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash', 'chat')
        } else {
          expect(scheduler.clearSessionMapping).toHaveBeenCalledWith('session-hash')
        }
      })

      it('parses redis-backed session mappings safely and can clear them', async () => {
        redisClient.get
          .mockResolvedValueOnce('{"accountId":"acct-1"}')
          .mockResolvedValueOnce('bad json')

        await expect(scheduler._getSessionMapping('hash-1')).resolves.toEqual({
          accountId: 'acct-1'
        })
        await expect(scheduler._getSessionMapping('hash-2')).resolves.toBeNull()

        await scheduler.clearSessionMapping('hash-3')
        expect(redisClient.del).toHaveBeenCalledWith(`${config.sessionPrefix}hash-3`)
      })
    })
  }
})

describe('All platform schedulers cover binding, rate-limit, and redis helper branches', () => {
  const schedulers = [
    {
      name: 'MiniMax',
      modulePath: '../src/services/scheduler/unifiedMinimaxScheduler',
      accountServicePath: '../src/services/account/minimaxAccountService',
      accountType: 'minimax',
      bindingKey: 'minimax',
      bindingMethod: '_getMiniMaxBinding',
      sessionPrefix: 'minimax_session_mapping:',
      unavailableMessage: 'No available MiniMax accounts',
      unavailableGroupMessage: 'No available MiniMax accounts in group',
      unauthorizedReason: 'MiniMax账号认证失败'
    },
    {
      name: 'GLM',
      modulePath: '../src/services/scheduler/unifiedGlmScheduler',
      accountServicePath: '../src/services/account/glmAccountService',
      accountType: 'glm',
      bindingKey: 'glm',
      bindingMethod: '_getGlmBinding',
      sessionPrefix: 'glm_session_mapping:',
      unavailableMessage: 'No available GLM accounts',
      unavailableGroupMessage: 'No available GLM accounts in group',
      unauthorizedReason: 'GLM账号认证失败'
    },
    {
      name: 'Kimi',
      modulePath: '../src/services/scheduler/unifiedKimiScheduler',
      accountServicePath: '../src/services/account/kimiAccountService',
      accountType: 'kimi',
      bindingKey: 'kimi',
      bindingMethod: '_getKimiBinding',
      sessionPrefix: 'kimi_session_mapping:',
      unavailableMessage: 'No available Kimi accounts',
      unavailableGroupMessage: 'No available Kimi accounts in group',
      unauthorizedReason: 'Kimi账号认证失败'
    },
    {
      name: 'DeepSeek',
      modulePath: '../src/services/scheduler/unifiedDeepSeekScheduler',
      accountServicePath: '../src/services/account/deepseekAccountService',
      accountType: 'deepseek',
      bindingKey: 'deepseek',
      bindingMethod: '_getDeepSeekBinding',
      sessionPrefix: 'deepseek_session_mapping:',
      unavailableMessage: 'No available DeepSeek accounts',
      unavailableGroupMessage: 'No available DeepSeek accounts in group',
      unauthorizedReason: 'DeepSeek账号认证失败'
    }
  ]

  for (const config of schedulers) {
    describe(`${config.name} scheduler shared branch coverage`, () => {
      let scheduler
      let accountService
      let accountGroupService
      let redis
      let redisClient
      let upstreamErrorHelper

      const makeAccount = (overrides = {}) => ({
        id: 'acct-1',
        name: `${config.name} Account`,
        priority: 10,
        isActive: true,
        schedulable: true,
        status: 'active',
        supportedModels: {},
        ...overrides
      })

      beforeEach(() => {
        jest.resetModules()
        scheduler = require(config.modulePath)
        accountService = require(config.accountServicePath)
        accountGroupService = require('../src/services/accountGroupService')
        redis = require('../src/models/redis')
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

      it('throws when no account can be selected for an api key', async () => {
        jest.spyOn(scheduler, '_getSessionMapping').mockResolvedValue(null)
        jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([])

        await expect(scheduler.selectAccountForApiKey({ id: 'key-1' })).rejects.toThrow(
          config.unavailableMessage
        )
      })

      it('returns a bound account directly when account binding stays usable', async () => {
        const boundAccount = makeAccount({ id: 'acct-bound' })
        jest.spyOn(accountService, 'getAccount').mockResolvedValue(boundAccount)
        jest.spyOn(scheduler, '_isAccountUsable').mockResolvedValue(true)

        const result = await scheduler._getAllAvailableAccounts(
          {
            accountBindings: {
              [config.bindingKey]: {
                accountId: 'acct-bound'
              }
            }
          },
          'model-a'
        )

        expect(result).toEqual([boundAccount])
      })

      it('falls back to the shared pool when a bound account becomes unusable', async () => {
        jest
          .spyOn(accountService, 'getAccount')
          .mockResolvedValue(makeAccount({ id: 'acct-bound', status: 'rateLimited' }))
        jest
          .spyOn(accountService, 'getAllAccounts')
          .mockResolvedValue([
            makeAccount({ id: 'acct-pool-1' }),
            makeAccount({ id: 'acct-pool-2' })
          ])
        jest
          .spyOn(scheduler, '_isAccountUsable')
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false)

        const result = await scheduler._getAllAvailableAccounts(
          {
            accountBindings: {
              [config.bindingKey]: {
                accountId: 'acct-bound'
              }
            }
          },
          'model-a'
        )

        expect(accountService.getAllAccounts).toHaveBeenCalledWith(false)
        expect(result).toEqual([expect.objectContaining({ id: 'acct-pool-1' })])
      })

      if (config.accountType === 'deepseek') {
        it('keeps explicit completion bindings strict when the bound account is unusable', async () => {
          jest
            .spyOn(accountService, 'getAccount')
            .mockResolvedValue(makeAccount({ id: 'acct-bound', status: 'rateLimited' }))
          jest
            .spyOn(accountService, 'getAllAccounts')
            .mockResolvedValue([makeAccount({ id: 'acct-pool-1' })])
          jest.spyOn(scheduler, '_isAccountUsable').mockResolvedValue(false)

          const result = await scheduler._getAllAvailableAccounts(
            {
              accountBindings: {
                [config.bindingKey]: {
                  accountId: 'acct-bound'
                }
              }
            },
            'model-a',
            'completion'
          )

          expect(accountService.getAllAccounts).not.toHaveBeenCalled()
          expect(result).toEqual([])
        })
      }

      it('selects the first usable group account and stores sticky mapping when requested', async () => {
        jest.spyOn(accountGroupService, 'getGroupMembers').mockResolvedValue(['acct-1', 'acct-2'])
        jest
          .spyOn(accountService, 'getAccount')
          .mockResolvedValueOnce(makeAccount({ id: 'acct-1', priority: 10 }))
          .mockResolvedValueOnce(makeAccount({ id: 'acct-2', priority: 20 }))
        jest.spyOn(scheduler, '_isAccountUsable').mockResolvedValue(true)
        jest.spyOn(scheduler, '_setSessionMapping').mockResolvedValue(undefined)
        const markAccountUsedSpy = jest
          .spyOn(accountService, 'markAccountUsed')
          .mockResolvedValue(undefined)

        const result = await scheduler.selectAccountFromGroup('group-1', 'session-hash', 'model-a')

        expect(result).toEqual({ accountId: 'acct-1', accountType: config.accountType })
        if (config.accountType === 'deepseek') {
          expect(scheduler._setSessionMapping).toHaveBeenCalledWith(
            'session-hash',
            'acct-1',
            'chat'
          )
        } else {
          expect(scheduler._setSessionMapping).toHaveBeenCalledWith('session-hash', 'acct-1')
        }
        expect(markAccountUsedSpy).toHaveBeenCalledWith('acct-1')
      })

      it('throws when a group has no usable accounts', async () => {
        jest.spyOn(accountGroupService, 'getGroupMembers').mockResolvedValue([])

        await expect(scheduler.selectAccountFromGroup('group-1')).rejects.toThrow(
          config.unavailableGroupMessage
        )
      })

      it('covers model matching branches for object and array supported models', async () => {
        jest.spyOn(scheduler, 'isAccountRateLimited').mockResolvedValue(false)

        await expect(
          scheduler._isAccountUsable(
            makeAccount({ supportedModels: { 'model-a': 'model-a' } }),
            'model-a'
          )
        ).resolves.toBe(true)

        await expect(
          scheduler._isAccountUsable(makeAccount({ supportedModels: ['model-a'] }), 'model-a')
        ).resolves.toBe(true)

        await expect(
          scheduler._isAccountUsable(makeAccount({ supportedModels: ['model-a'] }), 'model-b')
        ).resolves.toBe(false)
      })

      it('rejects unusable accounts for rate-limit, resync, status, and temp-unavailable branches', async () => {
        jest.spyOn(scheduler, 'isAccountRateLimited').mockResolvedValue(true)
        await expect(scheduler._isAccountUsable(makeAccount(), 'model-a')).resolves.toBe(false)

        scheduler.isAccountRateLimited.mockResolvedValue(false)
        jest.spyOn(accountService, 'getAccount').mockResolvedValue(null)
        await expect(
          scheduler._isAccountUsable(makeAccount({ status: 'rateLimited' }), 'model-a')
        ).resolves.toBe(false)

        await expect(
          scheduler._isAccountUsable(makeAccount({ schedulable: 'false' }), 'model-a')
        ).resolves.toBe(false)

        await expect(
          scheduler._isAccountUsable(makeAccount({ status: 'disabled' }), 'model-a')
        ).resolves.toBe(false)

        upstreamErrorHelper.isTempUnavailable.mockResolvedValue(true)
        await expect(scheduler._isAccountUsable(makeAccount(), 'model-a')).resolves.toBe(false)
      })

      it('resolves account availability through getAccount plus _isAccountUsable', async () => {
        const account = makeAccount({ id: 'acct-available' })
        jest.spyOn(accountService, 'getAccount').mockResolvedValue(account)
        jest.spyOn(scheduler, '_isAccountUsable').mockResolvedValue(true)

        await expect(scheduler._isAccountAvailable('acct-available')).resolves.toBe(true)
      })

      it('handles missing and uncleared rate-limit flags', async () => {
        jest.spyOn(accountService, 'getAccount').mockResolvedValue(null)
        await expect(scheduler.isAccountRateLimited('missing-account')).resolves.toBe(false)

        accountService.getAccount.mockResolvedValue({
          id: 'acct-limited',
          rateLimitStatus: 'limited',
          status: 'active'
        })
        jest.spyOn(accountService, 'checkAndClearRateLimit').mockResolvedValue(false)

        await expect(scheduler.isAccountRateLimited('acct-limited')).resolves.toBe(true)
      })

      it('delegates rate-limit removal and unauthorized markers to the account service', async () => {
        const setAccountRateLimitedSpy = jest
          .spyOn(accountService, 'setAccountRateLimited')
          .mockResolvedValue(undefined)
        const markAccountUnauthorizedSpy = jest
          .spyOn(accountService, 'markAccountUnauthorized')
          .mockResolvedValue(undefined)

        await scheduler.removeAccountRateLimit('acct-1')
        await scheduler.markAccountUnauthorized('acct-1')

        expect(setAccountRateLimitedSpy).toHaveBeenCalledWith('acct-1', false)
        expect(markAccountUnauthorizedSpy).toHaveBeenCalledWith('acct-1', config.unauthorizedReason)
      })

      it('parses account bindings from accountId, groupId, and group-prefixed accountIds', () => {
        expect(
          scheduler[config.bindingMethod]({
            accountBindings: {
              [config.bindingKey]: {
                accountId: 'acct-1'
              }
            }
          })
        ).toEqual({ accountId: 'acct-1' })

        expect(
          scheduler[config.bindingMethod]({
            accountBindings: {
              [config.bindingKey]: {
                groupId: 'group-1'
              }
            }
          })
        ).toEqual({ groupId: 'group-1' })

        expect(
          scheduler[config.bindingMethod]({
            accountBindings: {
              [config.bindingKey]: {
                accountId: 'group:group-2'
              }
            }
          })
        ).toEqual({ groupId: 'group-2' })

        expect(
          scheduler[config.bindingMethod]({
            accountBindings: {
              [config.bindingKey]: 'invalid'
            }
          })
        ).toBeNull()
      })

      it('writes sticky mappings to redis and safely skips empty clear requests', async () => {
        await scheduler._setSessionMapping('hash-1', 'acct-1')
        await scheduler._extendSessionMappingTTL('hash-1')
        await scheduler.clearSessionMapping()

        expect(redisClient.setex).toHaveBeenCalledTimes(1)
        expect(redisClient.setex).toHaveBeenCalledWith(
          `${config.sessionPrefix}hash-1`,
          24 * 60 * 60,
          expect.any(String)
        )
        expect(JSON.parse(redisClient.setex.mock.calls[0][2])).toEqual(
          expect.objectContaining({
            accountId: 'acct-1',
            accountType: config.accountType
          })
        )
        expect(redisClient.expire).toHaveBeenCalledWith(
          `${config.sessionPrefix}hash-1`,
          24 * 60 * 60
        )
        expect(redisClient.del).not.toHaveBeenCalled()
      })

      if (config.accountType === 'deepseek') {
        it('uses completion-scoped sticky keys only for completion mappings', async () => {
          await scheduler._setSessionMapping('hash-completion', 'acct-1', 'completion')
          await scheduler._extendSessionMappingTTL('hash-completion', 'completion')
          await scheduler.clearSessionMapping('hash-completion', 'completion')

          expect(redisClient.setex).toHaveBeenCalledWith(
            'deepseek_session_mapping:completion:hash-completion',
            24 * 60 * 60,
            expect.any(String)
          )
          expect(redisClient.expire).toHaveBeenCalledWith(
            'deepseek_session_mapping:completion:hash-completion',
            24 * 60 * 60
          )
          expect(redisClient.del).toHaveBeenCalledWith(
            'deepseek_session_mapping:completion:hash-completion'
          )
        })
      }
    })
  }
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
  const {
    GLM_MODELS,
    KIMI_MODELS,
    PLATFORM_TEST_MODELS,
    getModelsByService,
    getAllModels,
    OPENAI_MODELS,
    DEEPSEEK_MODELS,
    OTHER_MODELS
  } = require('../config/models')

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

  it('getModelsByService returns the expected lists for owned platform additions', () => {
    expect(getModelsByService('openai')).toBe(OPENAI_MODELS)
    expect(getModelsByService('deepseek')).toBe(DEEPSEEK_MODELS)
    expect(getModelsByService('unknown')).toEqual([])
  })

  it('getAllModels includes owned additions from openai, deepseek, and fallback models', () => {
    const models = getAllModels()
    expect(models).toEqual(expect.arrayContaining(OPENAI_MODELS))
    expect(models).toEqual(expect.arrayContaining(DEEPSEEK_MODELS))
    expect(models).toEqual(expect.arrayContaining(OTHER_MODELS))
  })
})
