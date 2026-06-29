const crypto = require('crypto')

describe('authenticateApiKey enterprise quota prompt', () => {
  const enterpriseUserIdAesKey = '1234567890abcdef'
  const enterpriseUserIdAesIv = 'abcdef1234567890'

  function encryptEnterpriseUserId(userId) {
    const cipher = crypto.createCipheriv(
      'aes-128-cbc',
      Buffer.from(enterpriseUserIdAesKey),
      Buffer.from(enterpriseUserIdAesIv)
    )
    const encrypted = Buffer.concat([cipher.update(`${userId}|member`), cipher.final()])
    return encrypted.toString('base64')
  }

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

  function loadHarness({ personalAvailable }) {
    jest.resetModules()

    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      api: jest.fn(),
      security: jest.fn()
    }

    const apiKeyService = {
      validateApiKey: jest.fn(async () => ({
        valid: true,
        keyData: {
          id: 'source-enterprise-key',
          name: 'source-enterprise-key',
          rateLimits: '[]',
          dailyCostLimit: '0',
          totalCostLimit: '0',
          weeklyOpusCostLimit: '0',
          weeklyResetDay: '1',
          weeklyResetHour: '0',
          packMode: 'enterprise'
        }
      }))
    }

    const redis = {
      getEnterpriseKeysByMemberUid: jest.fn(async () => ['enterprise-pack-key']),
      getKeysByUid: jest.fn(async () =>
        personalAvailable ? ['enterprise-pack-key', 'personal-pack-key'] : ['enterprise-pack-key']
      ),
      getApiKey: jest.fn(async (keyId) => {
        if (keyId === 'enterprise-pack-key') {
          return {
            id: 'enterprise-pack-key',
            name: 'pack-month-1490',
            isActive: 'true',
            expiresAt: '',
            rateLimits: '[]',
            dailyCostLimit: '1',
            totalCostLimit: '0',
            weeklyOpusCostLimit: '0',
            weeklyResetDay: '1',
            weeklyResetHour: '0',
            packMode: 'enterprise',
            memberUids: JSON.stringify(['user-1'])
          }
        }

        if (keyId === 'personal-pack-key') {
          return {
            id: 'personal-pack-key',
            name: 'pack-month-149',
            isActive: 'true',
            expiresAt: '',
            rateLimits: '[]',
            dailyCostLimit: '10',
            totalCostLimit: '0',
            weeklyOpusCostLimit: '0',
            weeklyResetDay: '1',
            weeklyResetHour: '0',
            packMode: 'personal',
            externalUid: 'user-1'
          }
        }

        return null
      }),
      getDailyCost: jest.fn(async (keyId) => (keyId === 'enterprise-pack-key' ? 1 : 0)),
      getCostStats: jest.fn(async () => ({ total: 0 })),
      getClient: jest.fn(() => ({
        get: jest.fn(async () => null)
      }))
    }

    jest.doMock('../config/config', () => ({
      security: {
        enterpriseUserIdAesKey,
        enterpriseUserIdAesIv
      },
      concurrency: {}
    }))
    jest.doMock('../src/services/apiKeyService', () => apiKeyService)
    jest.doMock('../src/services/userService', () => ({}))
    jest.doMock('../src/utils/logger', () => logger)
    jest.doMock('../src/models/redis', () => redis)
    jest.doMock('../src/validators/clientValidator', () => ({}))
    jest.doMock('../src/validators/clients/claudeCodeValidator', () => ({}))
    jest.doMock('../src/services/claudeRelayConfigService', () => ({
      getConfig: jest.fn(async () => ({
        concurrentRequestQueueEnabled: false
      }))
    }))
    jest.doMock('../src/utils/statsHelper', () => ({
      calculateWaitTimeStats: jest.fn(() => null)
    }))
    jest.doMock('../src/utils/modelHelper', () => ({
      isClaudeFamilyModel: jest.fn(() => false)
    }))

    const { authenticateApiKey } = require('../src/middleware/auth')

    return {
      authenticateApiKey,
      redis
    }
  }

  beforeEach(() => {
    jest.resetModules()
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  it('appends a personal switch hint when personal quota is still available', async () => {
    const { authenticateApiKey, redis } = loadHarness({ personalAvailable: true })
    const req = {
      headers: {
        authorization: 'Bearer cr_test_valid_key_1234567890',
        uni_agent_subscription_type: 'enterprise',
        uni_agent_subscription_user_id: encryptEnterpriseUserId('user-1')
      },
      query: {},
      body: {},
      ip: '127.0.0.1'
    }
    const res = createResponse()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(402)
    expect(res.payload.error.code).toBe('enterprise_quota_exhausted')
    expect(res.payload.error.message).toContain('企业版额度已用完')
    expect(res.payload.error.message).toContain('您可尝试切换到个人版继续使用')
    expect(res.payload.error.message).toContain('实际以个人版的权限、模型和额度校验结果为准')
    expect(redis.getKeysByUid).toHaveBeenCalledWith('user-1')
  })

  it('keeps the original enterprise prompt when no personal quota is available', async () => {
    const { authenticateApiKey } = loadHarness({ personalAvailable: false })
    const req = {
      headers: {
        authorization: 'Bearer cr_test_valid_key_1234567890',
        uni_agent_subscription_type: 'enterprise',
        uni_agent_subscription_user_id: encryptEnterpriseUserId('user-1')
      },
      query: {},
      body: {},
      ip: '127.0.0.1'
    }
    const res = createResponse()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(402)
    expect(res.payload.error.code).toBe('enterprise_quota_exhausted')
    expect(res.payload.error.message).toContain('企业版额度已用完')
    expect(res.payload.error.message).not.toContain('您可尝试切换到个人版继续使用')
  })
})
