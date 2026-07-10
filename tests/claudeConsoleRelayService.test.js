jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('axios', () => jest.fn())

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  _createProxyAgent: jest.fn(),
  isAccountRateLimited: jest.fn(),
  removeAccountRateLimit: jest.fn(),
  isAccountOverloaded: jest.fn(),
  removeAccountOverload: jest.fn()
}))

jest.mock('../config/config', () => ({ system: { timezone: 'Asia/Shanghai' } }), {
  virtual: true
})
jest.mock('../src/models/redis', () => ({}))

jest.mock('../src/utils/testPayloadHelper', () => ({
  createClaudeTestPayload: jest.fn(),
  sendStreamTestRequest: jest.fn()
}))

const claudeConsoleRelayService = require('../src/services/relay/claudeConsoleRelayService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const { createClaudeTestPayload, sendStreamTestRequest } = require('../src/utils/testPayloadHelper')
const axios = require('axios')
const { PassThrough } = require('stream')

describe('claudeConsoleRelayService.testAccountConnection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    claudeConsoleAccountService.isAccountRateLimited.mockResolvedValue(false)
    claudeConsoleAccountService.isAccountOverloaded.mockResolvedValue(false)
  })

  it('passes selected model stream payload and bearer auth for non sk-ant key', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'Console A1',
      apiUrl: 'https://console.example.com',
      apiKey: 'test-key',
      proxy: null,
      userAgent: null
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)

    const payload = {
      model: 'claude-sonnet-4-6',
      stream: true
    }
    createClaudeTestPayload.mockReturnValue(payload)
    sendStreamTestRequest.mockResolvedValue(undefined)

    const res = {}
    await claudeConsoleRelayService.testAccountConnection('a1', res, 'claude-sonnet-4-6')

    expect(createClaudeTestPayload).toHaveBeenCalledWith('claude-sonnet-4-6', { stream: true })
    expect(sendStreamTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        authorization: 'Bearer test-key'
      })
    )
  })

  it('passes selected model stream payload and x-api-key for sk-ant key', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'Console A1',
      apiUrl: 'https://console.example.com',
      apiKey: 'sk-ant-test-key',
      proxy: null,
      userAgent: null
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)

    const payload = {
      model: 'claude-sonnet-4-6',
      stream: true
    }
    createClaudeTestPayload.mockReturnValue(payload)
    sendStreamTestRequest.mockResolvedValue(undefined)

    const res = {}
    await claudeConsoleRelayService.testAccountConnection('a1', res, 'claude-sonnet-4-6')

    expect(createClaudeTestPayload).toHaveBeenCalledWith('claude-sonnet-4-6', { stream: true })
    const requestOptions = sendStreamTestRequest.mock.calls[0][0]
    expect(requestOptions).toEqual(
      expect.objectContaining({
        payload,
        extraHeaders: expect.objectContaining({
          'x-api-key': 'sk-ant-test-key'
        })
      })
    )
    expect(requestOptions).not.toHaveProperty('authorization')
  })

  it('normalizes Opus 4.8 manual thinking before console stream send', async () => {
    const upstreamStream = new PassThrough()
    axios.mockResolvedValue({
      status: 200,
      headers: {},
      data: upstreamStream
    })

    const responseStream = new PassThrough()
    responseStream.headersSent = false
    responseStream.getHeader = jest.fn()
    responseStream.writeHead = jest.fn(() => {
      responseStream.headersSent = true
    })

    const requestPromise = claudeConsoleRelayService._makeClaudeConsoleStreamRequest(
      {
        model: 'claude-opus-4-8',
        max_tokens: 32000,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 20,
        thinking: {
          type: 'enabled',
          budget_tokens: 31999
        }
      },
      {
        name: 'Console A1',
        apiUrl: 'https://console.example.com',
        apiKey: 'test-key',
        userAgent: null
      },
      null,
      {},
      responseStream,
      'a1'
    )

    await new Promise((resolve) => setImmediate(resolve))
    upstreamStream.end()
    await requestPromise

    const requestConfig = axios.mock.calls[0][0]
    expect(requestConfig.data).not.toHaveProperty('temperature')
    expect(requestConfig.data).not.toHaveProperty('top_p')
    expect(requestConfig.data).not.toHaveProperty('top_k')
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          model: 'claude-opus-4-8',
          thinking: {
            type: 'adaptive'
          },
          output_config: {
            effort: 'max'
          }
        })
      })
    )
  })
})
