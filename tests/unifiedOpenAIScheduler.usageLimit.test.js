describe('unifiedOpenAIScheduler._ensureAccountReadyForScheduling usage-limit recovery', () => {
  function loadScheduler(now = '2026-04-09T10:30:00.000Z') {
    jest.resetModules()
    jest.useFakeTimers()
    jest.setSystemTime(new Date(now))

    const openaiAccountService = {
      updateAccount: jest.fn(async () => ({})),
      recordUsage: jest.fn(async () => {}),
      getAccount: jest.fn(async () => null)
    }

    const openaiResponsesAccountService = {
      recordUsage: jest.fn(async () => {})
    }

    jest.doMock('../src/services/account/openaiAccountService', () => openaiAccountService)
    jest.doMock(
      '../src/services/account/openaiResponsesAccountService',
      () => openaiResponsesAccountService
    )
    jest.doMock('../src/services/accountGroupService', () => ({
      getGroupMembers: jest.fn(async () => [])
    }))
    jest.doMock('../src/models/redis', () => ({}))
    jest.doMock('../src/utils/logger', () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }))
    jest.doMock('../src/utils/commonHelper', () => ({
      isSchedulable: jest.fn((value) => value === true || value === 'true'),
      sortAccountsByPriority: jest.fn((accounts) => accounts)
    }))
    jest.doMock('../src/utils/upstreamErrorHelper', () => ({
      isTempUnavailable: jest.fn(async () => false)
    }))

    const scheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')

    return {
      scheduler,
      openaiAccountService
    }
  }

  beforeEach(() => {
    jest.resetModules()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  it('keeps the 5-hour stop active before the primary reset time', async () => {
    const { scheduler, openaiAccountService } = loadScheduler()

    const result = await scheduler._ensureAccountReadyForScheduling(
      {
        name: 'OpenAI Test',
        schedulable: 'false',
        rateLimitStatus: { status: 'normal', isRateLimited: false },
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '5小时限额使用量接近上限，已自动停止调度',
        codexUsageUpdatedAt: '2026-04-09T10:29:30.000Z',
        codexPrimaryResetAfterSeconds: '120'
      },
      'account-1',
      { sanitized: false }
    )

    expect(result).toEqual({ canUse: false, reason: 'usage_limit_stopped' })
    expect(openaiAccountService.updateAccount).not.toHaveBeenCalled()
  })

  it('restores scheduling after the 5-hour reset time passes', async () => {
    const { scheduler, openaiAccountService } = loadScheduler()

    const result = await scheduler._ensureAccountReadyForScheduling(
      {
        name: 'OpenAI Test',
        schedulable: 'false',
        rateLimitStatus: { status: 'normal', isRateLimited: false },
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '5小时限额使用量接近上限，已自动停止调度',
        codexUsageUpdatedAt: '2026-04-09T10:25:00.000Z',
        codexPrimaryResetAfterSeconds: '60'
      },
      'account-1',
      { sanitized: false }
    )

    expect(result).toEqual({ canUse: true })
    expect(openaiAccountService.updateAccount).toHaveBeenCalledWith('account-1', {
      schedulable: 'true',
      usageLimitAutoStopped: 'false',
      usageLimitStoppedAt: '',
      usageLimitStopReason: '',
      usageLimitResumeAt: ''
    })
  })

  it('keeps the weekly stop active before the secondary reset time', async () => {
    const { scheduler, openaiAccountService } = loadScheduler()

    const result = await scheduler._ensureAccountReadyForScheduling(
      {
        name: 'OpenAI Test',
        schedulable: 'false',
        rateLimitStatus: { status: 'normal', isRateLimited: false },
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '周限额使用量接近上限，已自动停止调度',
        codexUsageUpdatedAt: '2026-04-09T10:28:00.000Z',
        codexSecondaryResetAfterSeconds: '300'
      },
      'account-1',
      { sanitized: false }
    )

    expect(result).toEqual({ canUse: false, reason: 'usage_limit_stopped' })
    expect(openaiAccountService.updateAccount).not.toHaveBeenCalled()
  })

  it('restores scheduling after the weekly reset time passes', async () => {
    const { scheduler, openaiAccountService } = loadScheduler()

    const result = await scheduler._ensureAccountReadyForScheduling(
      {
        name: 'OpenAI Test',
        schedulable: 'false',
        rateLimitStatus: { status: 'normal', isRateLimited: false },
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '周限额使用量接近上限，已自动停止调度',
        codexUsageUpdatedAt: '2026-04-09T10:20:00.000Z',
        codexSecondaryResetAfterSeconds: '60'
      },
      'account-1',
      { sanitized: false }
    )

    expect(result).toEqual({ canUse: true })
    expect(openaiAccountService.updateAccount).toHaveBeenCalledTimes(1)
  })

  it('keeps the daily-overuse stop active before the midnight resume time', async () => {
    const { scheduler, openaiAccountService } = loadScheduler()

    const result = await scheduler._ensureAccountReadyForScheduling(
      {
        name: 'OpenAI Test',
        schedulable: 'false',
        rateLimitStatus: { status: 'normal', isRateLimited: false },
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '周限额当日均摊用量已超限，已自动停止调度',
        usageLimitResumeAt: '2026-04-09T16:00:00.000Z'
      },
      'account-1',
      { sanitized: false }
    )

    expect(result).toEqual({ canUse: false, reason: 'usage_limit_stopped' })
    expect(openaiAccountService.updateAccount).not.toHaveBeenCalled()
  })

  it('restores scheduling after the daily-overuse midnight resume time passes', async () => {
    const { scheduler, openaiAccountService } = loadScheduler('2026-04-09T16:00:00.000Z')

    const result = await scheduler._ensureAccountReadyForScheduling(
      {
        name: 'OpenAI Test',
        schedulable: 'false',
        rateLimitStatus: { status: 'normal', isRateLimited: false },
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '周限额当日均摊用量已超限，已自动停止调度',
        usageLimitResumeAt: '2026-04-09T16:00:00.000Z'
      },
      'account-1',
      { sanitized: false }
    )

    expect(result).toEqual({ canUse: true })
    expect(openaiAccountService.updateAccount).toHaveBeenCalledWith('account-1', {
      schedulable: 'true',
      usageLimitAutoStopped: 'false',
      usageLimitStoppedAt: '',
      usageLimitStopReason: '',
      usageLimitResumeAt: ''
    })
  })
})
