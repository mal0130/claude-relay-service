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
  mapToErrorCode
} = require('../src/utils/errorSanitizer')
const {
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
