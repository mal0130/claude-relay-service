jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000,
    logging: { truncate: false }
  }),
  { virtual: true }
)

jest.mock('axios', () => {
  const axios = jest.fn()
  axios.isCancel = jest.fn(() => false)
  return axios
})

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/headerFilter', () => ({
  filterForOpenAI: jest.fn((headers) => headers || {})
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  _deleteSessionMapping: jest.fn(),
  markAccountRateLimited: jest.fn()
}))

jest.mock('../src/services/webhookService', () => ({
  sendNotification: jest.fn(() => Promise.resolve())
}))

jest.mock('../src/utils/userInputExtractor', () => ({
  buildUsageMetadata: jest.fn(() => null),
  buildInputMessagesBlock: jest.fn(() => null)
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null),
  extractOpenAICacheReadTokens: jest.fn(() => 0),
  buildCompletionUsageSummary: jest.fn(() => ({
    actualInputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0
  })),
  formatCompletionUsageLog: jest.fn(() => 'usage-log')
}))

const axios = require('axios')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const webhookService = require('../src/services/webhookService')
const relayService = require('../src/services/relay/openaiResponsesRelayService')

function createReq(overrides = {}) {
  return {
    method: 'POST',
    path: '/v1/responses',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'jest-test/1.0',
      'x-session-id': 'sanitize-test-session',
      ...overrides.headers
    },
    body: {
      model: 'gpt-5.4',
      stream: false,
      input: 'hello',
      ...overrides.body
    },
    once: jest.fn(),
    removeListener: jest.fn(),
    on: jest.fn(),
    ...overrides
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    destroyed: false,
    once: jest.fn(),
    removeListener: jest.fn(),
    end: jest.fn(),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.payload = payload
      return res
    })
  }
  return res
}

describe('openaiResponsesRelayService error sanitizing', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'Responses Test Account',
      apiKey: 'sk-responses',
      baseApi: 'https://api.example.com',
      providerEndpoint: 'responses',
      proxy: null
    })
  })

  test('sanitizes upstream 400 JSON error payload before returning to client', async () => {
    axios.mockResolvedValue({
      status: 400,
      statusText: 'Bad Request',
      data: {
        error: {
          message:
            "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account. [codex/codex]"
        }
      }
    })

    const req = createReq()
    const res = createRes()

    await relayService.handleRequest(req, res, { id: 'resp-1', name: 'Responses Test Account' }, {})

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: 'Account temporarily unavailable'
      }
    })
    expect(webhookService.sendNotification).toHaveBeenCalledWith(
      'systemError',
      expect.objectContaining({
        status: 400,
        response: {
          error: {
            message: 'Account temporarily unavailable'
          }
        }
      })
    )
  })

  test('sanitizes string payloads in axios catch handler before returning to client', async () => {
    axios.mockRejectedValue({
      message: 'Request failed with status code 400',
      code: 'ERR_BAD_REQUEST',
      response: {
        status: 400,
        statusText: 'Bad Request',
        data: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."
      }
    })

    const req = createReq()
    const res = createRes()

    await relayService.handleRequest(req, res, { id: 'resp-1', name: 'Responses Test Account' }, {})

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: 'Account temporarily unavailable',
        type: 'api_error',
        code: 'ERR_BAD_REQUEST'
      }
    })
    expect(webhookService.sendNotification).toHaveBeenCalledWith(
      'systemError',
      expect.objectContaining({
        status: 400,
        response: {
          error: {
            message: 'Account temporarily unavailable',
            type: 'api_error',
            code: 'ERR_BAD_REQUEST'
          }
        }
      })
    )
  })

  test('sanitizes string-shaped error fields before returning to client', async () => {
    axios.mockResolvedValue({
      status: 400,
      statusText: 'Bad Request',
      data: {
        error: 'subscription expired [foo/bar]'
      }
    })

    const req = createReq()
    const res = createRes()

    await relayService.handleRequest(req, res, { id: 'resp-1', name: 'Responses Test Account' }, {})

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: 'Account temporarily unavailable'
      }
    })
  })
})
