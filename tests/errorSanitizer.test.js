jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/utils/tempUnavailablePolicy', () => ({
  normalizeTempUnavailablePolicyFromAccountData: jest.fn(() => ({
    disableTempUnavailable: false,
    ttl503Seconds: null,
    ttl5xxSeconds: null
  }))
}))

const {
  getSafeMessage,
  isAccountDisabledError,
  isNoAvailableAccountsError,
  mapToErrorCode
} = require('../src/utils/errorSanitizer')
const {
  extractAccountQuotaResetAt,
  markAccountQuotaExceededWithService,
  checkAndClearQuotaExceededWithService,
  isAccountQuotaExceededError,
  sanitizeErrorForClient,
  sanitizeRelayErrorResponse
} = require('../src/utils/upstreamErrorHelper')

describe('errorSanitizer account-related interception', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('maps ChatGPT account unsupported-model error to account temporarily unavailable', () => {
    const message = "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."

    expect(getSafeMessage(message)).toBe('Account temporarily unavailable')
    expect(mapToErrorCode(message)).toMatchObject({
      code: 'E011',
      status: 503
    })
  })

  test('maps expired subscription style errors to account temporarily unavailable', () => {
    expect(getSafeMessage('subscription expired for this account')).toBe(
      'Account temporarily unavailable'
    )
    expect(getSafeMessage('workspace expired, please renew')).toBe(
      'Account temporarily unavailable'
    )
  })

  test('maps billing exhaustion style errors to account temporarily unavailable', () => {
    expect(getSafeMessage('insufficient balance')).toBe('Account temporarily unavailable')
    expect(getSafeMessage('FREE_QUOTA_EXHAUSTED')).toBe('Account temporarily unavailable')
    expect(getSafeMessage('BILLING_ISOLATED')).toBe('Account temporarily unavailable')
  })

  test('maps no available accounts errors to model vendor capacity message', () => {
    const message = 'No available DeepSeek accounts support the requested model: deepseek-chat'

    expect(isNoAvailableAccountsError(message)).toBe(true)
    expect(getSafeMessage(message)).toBe(
      '模型供应商（上游服务商）算力不足，请重试。若持续报错，建议临时切换其他模型继续任务。'
    )
    expect(mapToErrorCode(message)).toMatchObject({
      code: 'E017',
      status: 503
    })
  })

  test('detects upstream account quota exceeded responses for any reset window', () => {
    const response = {
      error: {
        code: 'AccountQuotaExceeded',
        message:
          'You have exceeded the weekly usage quota. It will reset at 2026-06-29 00:00:00 +0800 CST.',
        type: 'TooManyRequests'
      }
    }

    expect(isAccountQuotaExceededError(429, response)).toBe(true)
    expect(extractAccountQuotaResetAt(response)).toBe('2026-06-28T16:00:00.000Z')
    expect(getSafeMessage(response)).toBe('Quota exceeded')
    expect(
      isAccountQuotaExceededError(429, {
        error: {
          message: 'You have exceeded the 5-hour usage quota. It will reset later.'
        }
      })
    ).toBe(true)
    expect(
      isAccountQuotaExceededError(429, {
        error: {
          message: 'You have exceeded the monthly usage quota. It will reset later.'
        }
      })
    ).toBe(true)
  })

  test('quota-exceeded helper mutates accounts only through the account service', async () => {
    const response = {
      error: {
        message:
          'You have exceeded the weekly usage quota. It will reset at 2026-06-29 00:00:00 +0800 CST.'
      }
    }
    const accountService = {
      getAccount: jest.fn().mockResolvedValue({
        id: 'acct-1',
        name: 'Quota Account',
        disableAutoProtection: 'false'
      }),
      updateAccount: jest.fn().mockResolvedValue(undefined)
    }

    await expect(
      markAccountQuotaExceededWithService({
        accountService,
        accountId: 'acct-1',
        accountType: 'deepseek',
        platformName: 'DeepSeek',
        responseBody: response
      })
    ).resolves.toEqual({ success: true })

    expect(accountService.updateAccount).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({
        status: 'quotaExceeded',
        schedulable: 'false',
        providerQuotaResetAt: '2026-06-28T16:00:00.000Z',
        errorMessage: response.error.message
      })
    )
  })

  test('quota-exceeded clear helper resumes scheduling after reset time', async () => {
    const accountService = {
      getAccount: jest.fn().mockResolvedValue({
        id: 'acct-1',
        name: 'Quota Account',
        status: 'quotaExceeded',
        providerQuotaResetAt: new Date(Date.now() - 1000).toISOString()
      }),
      updateAccount: jest.fn().mockResolvedValue(undefined)
    }

    await expect(
      checkAndClearQuotaExceededWithService({
        accountService,
        accountId: 'acct-1',
        platformName: 'DeepSeek'
      })
    ).resolves.toBe(true)

    expect(accountService.updateAccount).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({
        status: 'active',
        schedulable: 'true',
        quotaStoppedAt: '',
        providerQuotaResetAt: '',
        errorMessage: ''
      })
    )
  })

  test('keeps generic model errors mapped to model not available', () => {
    expect(getSafeMessage('requested model not supported by upstream')).toBe('Model not available')
  })

  test('maps envoy upstream reset errors to service temporarily unavailable', () => {
    const message =
      'Service Unavailable: upstream connect error or disconnect/reset before headers. reset reason: connection termination'

    expect(getSafeMessage(message)).toBe('Service temporarily unavailable')
    expect(mapToErrorCode(message)).toMatchObject({
      code: 'E001',
      status: 503
    })
  })

  test('detects disabled-account style upstream 400 responses', () => {
    expect(
      isAccountDisabledError(400, {
        error: {
          message: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."
        }
      })
    ).toBe(true)

    expect(
      isAccountDisabledError(400, {
        error: {
          message: 'subscription expired for this account'
        }
      })
    ).toBe(true)

    expect(
      isAccountDisabledError(400, {
        error: {
          message: 'workspace expired, please renew'
        }
      })
    ).toBe(true)
  })

  test('does not mark unrelated 400 errors as disabled-account problems', () => {
    expect(
      isAccountDisabledError(400, {
        error: {
          message: 'some unrelated bad request'
        }
      })
    ).toBe(false)

    expect(
      isAccountDisabledError(503, {
        error: {
          message: 'subscription expired for this account'
        }
      })
    ).toBe(false)
  })
})

describe('upstreamErrorHelper sanitizeErrorForClient', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('sanitizes raw string errors', () => {
    expect(
      sanitizeErrorForClient(
        "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."
      )
    ).toEqual({
      error: {
        message: 'Account temporarily unavailable'
      }
    })
  })

  test('sanitizes nested error.message and strips internal route suffix', () => {
    const result = sanitizeErrorForClient({
      error: {
        message:
          "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account. [codex/codex]"
      }
    })

    expect(result).toEqual({
      error: {
        message: 'Account temporarily unavailable'
      }
    })
  })

  test('sanitizes top-level message fields', () => {
    const result = sanitizeErrorForClient({
      message: 'subscription expired [foo/bar]'
    })

    expect(result).toEqual({
      message: 'Account temporarily unavailable'
    })
  })

  test('sanitizes string-shaped error fields', () => {
    const result = sanitizeErrorForClient({
      error: 'subscription expired [foo/bar]'
    })

    expect(result).toEqual({
      error: {
        message: 'Account temporarily unavailable'
      }
    })
  })

  test('sanitizes non-object errors by coercing to string', () => {
    expect(sanitizeErrorForClient(429)).toEqual({
      error: {
        message: 'Rate limit exceeded'
      }
    })
  })

  test('sanitizes relay billing errors and preserves safe metadata fields', () => {
    expect(
      sanitizeRelayErrorResponse(403, {
        error: {
          message: 'FREE_QUOTA_EXHAUSTED: please recharge',
          code: '401008',
          type: 'insufficient_balance'
        }
      })
    ).toEqual({
      error: {
        message: 'Account temporarily unavailable',
        code: '401008',
        type: 'insufficient_balance'
      }
    })
  })

  test('sanitizes relay errors with status-based fallback when upstream message is opaque', () => {
    expect(
      sanitizeRelayErrorResponse(503, {
        error: {
          message: 'busy'
        }
      })
    ).toEqual({
      error: {
        message: 'Service temporarily unavailable'
      }
    })
  })
})
