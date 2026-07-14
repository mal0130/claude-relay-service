describe('authenticateApiKey AI fix pack fallback', () => {
  function createResponse() {
    return {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        this.payload = payload
        return this
      }
    }
  }

  function createKey(overrides = {}) {
    return {
      id: 'package-key',
      name: '392600771@qq.com_pack-month-149',
      externalUid: 'user-1',
      packMode: 'personal',
      isActive: 'true',
      expiresAt: '',
      tags: ['pack_consent'],
      rateLimits: [],
      dailyCostLimit: 0,
      totalCostLimit: 0,
      weeklyOpusCostLimit: 0,
      concurrencyLimit: 0,
      permissions: [],
      ...overrides
    }
  }

  function loadHarness({ initialKeyType = 'package' } = {}) {
    jest.resetModules()

    const packageKey = createKey()
    const resourceKey = createKey({
      id: 'resource-key',
      name: '392600771@qq.com_pack-1000-month',
      tags: []
    })
    const initialKey = initialKeyType === 'resource' ? resourceKey : packageKey
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      api: jest.fn(),
      security: jest.fn()
    }
    const apiKeyService = {
      validateApiKey: jest.fn(async () => ({ valid: true, keyData: initialKey }))
    }
    const redis = {
      getKeysByUid: jest.fn(async () => ['package-key', 'resource-key']),
      getApiKey: jest.fn(async (keyId) => (keyId === 'resource-key' ? resourceKey : packageKey)),
      getDailyCost: jest.fn(async () => 0),
      getCostStats: jest.fn(async () => ({ total: 0 })),
      getClient: jest.fn(() => ({
        get: jest.fn(async () => null),
        set: jest.fn(async () => 'OK'),
        incr: jest.fn(async () => 1)
      }))
    }

    jest.doMock('../config/config', () => ({ security: {}, concurrency: {} }))
    jest.doMock('../src/services/apiKeyService', () => apiKeyService)
    jest.doMock('../src/services/userService', () => ({}))
    jest.doMock('../src/utils/logger', () => logger)
    jest.doMock('../src/models/redis', () => redis)
    jest.doMock('../src/validators/clientValidator', () => ({}))
    jest.doMock('../src/validators/clients/claudeCodeValidator', () => ({}))
    jest.doMock('../src/services/claudeRelayConfigService', () => ({
      getConfig: jest.fn(async () => ({ concurrentRequestQueueEnabled: false }))
    }))
    jest.doMock('../src/utils/statsHelper', () => ({
      calculateWaitTimeStats: jest.fn(() => null)
    }))
    jest.doMock('../src/utils/modelHelper', () => ({
      isClaudeFamilyModel: jest.fn(() => false)
    }))

    const { authenticateApiKey } = require('../src/middleware/auth')
    return { authenticateApiKey, redis }
  }

  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  it('restores the original package instead of consuming a resource pack', async () => {
    const { authenticateApiKey, redis } = loadHarness()
    const req = {
      headers: {
        authorization: 'Bearer cr_test_valid_key_1234567890',
        uni_agent_agent_type: 'primary'
      },
      query: {},
      body: {
        model: 'gpt-5.6-terra',
        messages: [{ role: 'user', content: '请修复当前项目控制台中的错误。' }]
      },
      ip: '127.0.0.1',
      path: '/v1/responses',
      originalUrl: '/openai/v1/responses'
    }
    const res = createResponse()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(req.apiKey.id).toBe('package-key')
    expect(req.apiKey.name).toBe('392600771@qq.com_pack-month-149')
    expect(redis.getApiKey).toHaveBeenCalledWith('resource-key')
    expect(redis.getDailyCost).toHaveBeenCalledTimes(1)
  })

  it('switches from a resource pack to an available package after AI fix packs', async () => {
    const { authenticateApiKey } = loadHarness({ initialKeyType: 'resource' })
    const req = {
      headers: {
        authorization: 'Bearer cr_test_valid_key_1234567890',
        uni_agent_agent_type: 'primary'
      },
      query: {},
      body: {
        model: 'gpt-5.6-terra',
        messages: [{ role: 'user', content: '请修复当前项目控制台中的错误。' }]
      },
      ip: '127.0.0.1',
      path: '/v1/responses',
      originalUrl: '/openai/v1/responses'
    }
    const res = createResponse()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(req.apiKey.id).toBe('package-key')
    expect(req.apiKey.name).toBe('392600771@qq.com_pack-month-149')
  })
})
