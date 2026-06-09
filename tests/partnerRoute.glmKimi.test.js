function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    json: jest.fn((payload) => {
      res.body = payload
      return res
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    })
  }

  return res
}

describe('partner route GLM/Kimi bindings', () => {
  function loadRouteHarness() {
    jest.resetModules()

    const mockRouter = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn()
    }

    const authenticatePartner = jest.fn((_req, _res, next) => next())
    const apiKeyService = {
      generateApiKey: jest.fn(async (params) => ({
        id: 'generated-key-id',
        name: params.name,
        apiKey: 'cr_generated'
      })),
      updateApiKey: jest.fn(async () => {}),
      initializeRateLimitWindows: jest.fn(async () => {})
    }
    const redis = {
      getClientSafe: jest.fn(() => ({
        smembers: jest.fn(async () => [])
      })),
      getApiKey: jest.fn(async () => null),
      getUsageRecords: jest.fn(async () => []),
      scanKeys: jest.fn(async () => []),
      getDateInTimezone: jest.fn(() => new Date('2026-06-09T00:00:00.000Z')),
      getDateStringInTimezone: jest.fn(() => '2026-06-09')
    }
    const accountGroupService = {
      getGroup: jest.fn(async () => null)
    }
    const openaiResponsesAccountService = {
      getAccount: jest.fn(async () => null)
    }
    const deepseekAccountService = {
      getAccount: jest.fn(async (accountId) => ({ id: accountId }))
    }
    const minimaxAccountService = {
      getAccount: jest.fn(async (accountId) => ({ id: accountId }))
    }
    const glmAccountService = {
      getAccount: jest.fn(async (accountId) => ({ id: accountId }))
    }
    const kimiAccountService = {
      getAccount: jest.fn(async (accountId) => ({ id: accountId }))
    }
    const claudeConsoleAccountService = {
      getAccount: jest.fn(async (accountId) => ({ id: accountId }))
    }
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      success: jest.fn()
    }

    jest.doMock('express', () => ({
      Router: () => mockRouter
    }))
    jest.doMock('../src/middleware/partnerAuth', () => ({
      authenticatePartner
    }))
    jest.doMock('../src/models/redis', () => redis)
    jest.doMock('../src/utils/logger', () => logger)
    jest.doMock('../src/services/apiKeyService', () => apiKeyService)
    jest.doMock('../src/services/accountGroupService', () => accountGroupService)
    jest.doMock('../src/services/account/openaiResponsesAccountService', () => openaiResponsesAccountService)
    jest.doMock('../src/services/account/deepseekAccountService', () => deepseekAccountService)
    jest.doMock('../src/services/account/minimaxAccountService', () => minimaxAccountService)
    jest.doMock('../src/services/account/glmAccountService', () => glmAccountService)
    jest.doMock('../src/services/account/kimiAccountService', () => kimiAccountService)
    jest.doMock('../src/services/account/claudeConsoleAccountService', () => claudeConsoleAccountService)
    jest.doMock('../config/config', () => ({
      partnerApi: {
        defaultClaudeAccountId: 'claude-default'
      }
    }))

    require('../src/routes/partner')

    function findPostHandler(path) {
      const route = mockRouter.post.mock.calls.find((call) => call[0] === path)
      return route?.[2]
    }

    return {
      apiKeyService,
      redis,
      glmAccountService,
      kimiAccountService,
      findPostHandler
    }
  }

  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  test('create route writes GLM/Kimi grouped accountBindings and serviceRates', async () => {
    const { apiKeyService, findPostHandler } = loadRouteHarness()
    const handler = findPostHandler('/api-key/create')
    const res = createResponse()

    await handler(
      {
        body: {
          name: 'Partner GLM Kimi Key',
          glm_account_id: 'glm-account-1',
          kimi_account_id: 'kimi-account-1',
          glm_rate: 1.4,
          kimi_rate: 1.5
        }
      },
      res
    )

    expect(apiKeyService.generateApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Partner GLM Kimi Key',
        permissions: ['claude', 'glm', 'kimi'],
        serviceRates: {
          glm: 1.4,
          kimi: 1.5
        },
        accountBindings: {
          glm: { mode: 'shared', accountId: 'glm-account-1' },
          kimi: { mode: 'shared', accountId: 'kimi-account-1' }
        }
      })
    )

    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({
      code: 0,
      msg: 'success',
      data: {
        keyId: 'generated-key-id',
        keyName: 'Partner GLM Kimi Key',
        apiKey: 'cr_generated'
      }
    })
  })

  test('create route rejects missing GLM account before generating key', async () => {
    const { apiKeyService, glmAccountService, findPostHandler } = loadRouteHarness()
    const handler = findPostHandler('/api-key/create')
    const res = createResponse()

    glmAccountService.getAccount.mockResolvedValueOnce(null)

    await handler(
      {
        body: {
          name: 'Partner Invalid GLM Key',
          glm_account_id: 'glm-missing',
          glm_rate: 1.4
        }
      },
      res
    )

    expect(apiKeyService.generateApiKey).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      code: 1001,
      msg: 'GLM account not found or inactive',
      data: null
    })
  })

  test('update route merges GLM/Kimi bindings into grouped accountBindings', async () => {
    const { apiKeyService, redis, findPostHandler } = loadRouteHarness()
    const handler = findPostHandler('/api-key/:keyId/update')
    const res = createResponse()

    redis.getApiKey.mockResolvedValueOnce({
      id: 'key-1',
      name: 'Existing Key',
      permissions: JSON.stringify(['claude', 'deepseek']),
      serviceRates: JSON.stringify({ deepseek: 1.2 }),
      accountBindings: JSON.stringify({
        deepseek: { mode: 'shared', accountId: 'deepseek-account-1' }
      }),
      tags: '[]',
      isActivated: 'true'
    })

    await handler(
      {
        params: { keyId: 'key-1' },
        body: {
          glm_account_id: 'glm-account-1',
          kimi_account_id: 'kimi-account-1',
          glm_rate: 1.7,
          kimi_rate: 1.8
        }
      },
      res
    )

    expect(apiKeyService.updateApiKey).toHaveBeenCalledWith(
      'key-1',
      expect.objectContaining({
        serviceRates: {
          deepseek: 1.2,
          glm: 1.7,
          kimi: 1.8
        },
        accountBindings: {
          deepseek: { mode: 'shared', accountId: 'deepseek-account-1' },
          glm: { mode: 'shared', accountId: 'glm-account-1' },
          kimi: { mode: 'shared', accountId: 'kimi-account-1' }
        },
        permissions: expect.arrayContaining(['claude', 'deepseek', 'glm', 'kimi'])
      })
    )

    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({
      code: 0,
      msg: 'success',
      data: {
        keyId: 'key-1',
        keyName: 'Existing Key'
      }
    })
  })

  test('batch update route preserves existing bindings while adding GLM/Kimi', async () => {
    const { apiKeyService, redis, findPostHandler } = loadRouteHarness()
    const handler = findPostHandler('/api-key/update-config')
    const res = createResponse()

    redis.getApiKey.mockResolvedValueOnce({
      id: 'key-1',
      name: 'Existing Key',
      permissions: JSON.stringify(['claude', 'minimax']),
      serviceRates: JSON.stringify({ minimax: 1.6 }),
      accountBindings: JSON.stringify({
        minimax: { mode: 'shared', accountId: 'minimax-account-1' }
      })
    })

    await handler(
      {
        body: {
          glm_account_id: 'glm-account-1',
          kimi_account_id: 'kimi-account-1',
          configs: [
            {
              key_id: 'key-1',
              glm_rate: 1.9,
              kimi_rate: 2.0
            }
          ]
        }
      },
      res
    )

    expect(apiKeyService.updateApiKey).toHaveBeenCalledWith(
      'key-1',
      expect.objectContaining({
        serviceRates: {
          minimax: 1.6,
          glm: 1.9,
          kimi: 2.0
        },
        accountBindings: {
          minimax: { mode: 'shared', accountId: 'minimax-account-1' },
          glm: { mode: 'shared', accountId: 'glm-account-1' },
          kimi: { mode: 'shared', accountId: 'kimi-account-1' }
        },
        permissions: expect.arrayContaining(['claude', 'minimax', 'glm', 'kimi'])
      })
    )

    expect(res.status).not.toHaveBeenCalled()
    expect(res.body).toEqual({
      code: 0,
      msg: 'success',
      data: {
        total: 1,
        success: 1,
        failed: 0,
        failedDetails: []
      }
    })
  })
})
