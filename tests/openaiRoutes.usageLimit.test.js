describe('openaiRoutes.handleResponses usage snapshot guard', () => {
  function loadRouteHarness() {
    jest.resetModules()

    const axios = {
      post: jest.fn(async () => ({
        status: 200,
        headers: {},
        data: {
          id: 'resp_123',
          model: 'codex-mini-latest'
        }
      }))
    }

    const unifiedOpenAIScheduler = {
      selectAccountForApiKey: jest.fn(async () => ({
        accountId: 'account-1',
        accountType: 'openai'
      })),
      isAccountRateLimited: jest.fn(async () => false),
      removeAccountRateLimit: jest.fn(async () => {}),
      markAccountRateLimited: jest.fn(async () => {}),
      markAccountUnauthorized: jest.fn(async () => {})
    }

    const openaiAccountService = {
      getAccount: jest.fn(async () => ({
        id: 'account-1',
        name: 'OpenAI Test',
        accessToken: 'encrypted-token',
        accountId: 'chatgpt-account-1'
      })),
      decrypt: jest.fn((value) => value),
      isTokenExpired: jest.fn(() => false),
      refreshAccountToken: jest.fn(async () => {}),
      updateCodexUsageSnapshot: jest.fn(async () => {}),
      checkAndApplyUsageLimitStop: jest.fn(async () => {})
    }

    jest.doMock('axios', () => axios)
    jest.doMock('../config/config', () => ({
      requestTimeout: 1000,
      logging: {
        truncate: true
      }
    }))
    jest.doMock('../src/utils/logger', () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      security: jest.fn()
    }))
    jest.doMock('../src/middleware/auth', () => ({
      authenticateApiKey: (req, res, next) => next()
    }))
    jest.doMock('../src/services/scheduler/unifiedOpenAIScheduler', () => unifiedOpenAIScheduler)
    jest.doMock('../src/services/account/openaiAccountService', () => openaiAccountService)
    jest.doMock('../src/services/account/openaiResponsesAccountService', () => ({
      getAccount: jest.fn(async () => null)
    }))
    jest.doMock('../src/services/relay/openaiResponsesRelayService', () => ({
      handleRequest: jest.fn(async () => {})
    }))
    jest.doMock('../src/services/apiKeyService', () => ({
      hasPermission: jest.fn(() => true),
      recordUsage: jest.fn(async () => ({}))
    }))
    jest.doMock('../src/models/redis', () => ({
      getUsageStats: jest.fn(async () => null)
    }))
    jest.doMock('../src/utils/proxyHelper', () => ({
      createProxyAgent: jest.fn(() => null),
      getProxyDescription: jest.fn(() => 'none')
    }))
    jest.doMock('../src/utils/rateLimitHelper', () => ({
      updateRateLimitCounters: jest.fn(async () => {})
    }))
    jest.doMock('../src/utils/requestContext', () => ({
      setSessionId: jest.fn()
    }))
    jest.doMock('../src/utils/sseParser', () => ({
      IncrementalSSEParser: jest.fn()
    }))
    jest.doMock('../src/utils/errorSanitizer', () => ({
      getSafeMessage: jest.fn((error) => error?.message || 'error')
    }))
    jest.doMock('../src/utils/userInputExtractor', () => ({
      buildUsageMetadata: jest.fn(() => ({})),
      buildInputMessagesBlock: jest.fn(() => null)
    }))

    const { handleResponses } = require('../src/routes/openaiRoutes')

    return {
      handleResponses,
      axios,
      openaiAccountService
    }
  }

  beforeEach(() => {
    jest.resetModules()
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  it('does not update usage snapshot state when the upstream response has no codex usage headers', async () => {
    const { handleResponses, openaiAccountService } = loadRouteHarness()

    const req = {
      apiKey: {
        id: 'key-1',
        permissions: ['openai']
      },
      headers: {
        'user-agent': 'codex_cli_rs/1.0.0'
      },
      body: {
        model: 'codex-mini-latest',
        stream: false
      },
      originalUrl: '/responses',
      path: '/responses'
    }

    const res = {
      statusCode: 200,
      headersSent: false,
      status(code) {
        this.statusCode = code
        return this
      },
      setHeader: jest.fn(),
      json: jest.fn(function json(_payload) {
        return this
      })
    }

    await handleResponses(req, res)

    expect(res.statusCode).toBe(200)
    expect(openaiAccountService.updateCodexUsageSnapshot).not.toHaveBeenCalled()
    expect(openaiAccountService.checkAndApplyUsageLimitStop).not.toHaveBeenCalled()
  })
})
