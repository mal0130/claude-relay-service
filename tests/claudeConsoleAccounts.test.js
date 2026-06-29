jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({
  testAccountConnection: jest.fn(async (accountId, res) =>
    res.status(200).json({ success: true, accountId })
  )
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/routes/admin/utils', () => ({
  formatAccountExpiry: jest.fn((account) => account),
  mapExpiryField: jest.fn((updates) => updates)
}))

const claudeConsoleRelayService = require('../src/services/relay/claudeConsoleRelayService')
const claudeConsoleAccountsRouter = require('../src/routes/admin/claudeConsoleAccounts')

describe('POST /admin/claude-console-accounts/:accountId/test', () => {
  const getRouteHandler = () => {
    const layer = claudeConsoleAccountsRouter.stack.find(
      (item) => item.route?.path === '/claude-console-accounts/:accountId/test'
    )

    if (!layer) {
      throw new Error('Test route handler not found')
    }

    return layer.route.stack[layer.route.stack.length - 1].handle
  }

  const createRes = () => ({
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  })

  const invokeHandler = async (body) => {
    const handler = getRouteHandler()
    const req = {
      params: { accountId: 'account-1' },
      body
    }
    const res = createRes()

    await handler(req, res)
    return { req, res }
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns 400 when model is missing', async () => {
    const { res } = await invokeHandler({})

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'model is required' })
    expect(claudeConsoleRelayService.testAccountConnection).not.toHaveBeenCalled()
  })

  it('passes model through to relay service when provided', async () => {
    const { res } = await invokeHandler({ model: 'claude-sonnet-4-6' })

    expect(res.statusCode).toBe(200)
    expect(claudeConsoleRelayService.testAccountConnection).toHaveBeenCalledTimes(1)
    expect(claudeConsoleRelayService.testAccountConnection).toHaveBeenCalledWith(
      'account-1',
      res,
      'claude-sonnet-4-6'
    )
  })
})
