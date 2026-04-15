describe('openaiAccountService.checkAndApplyUsageLimitStop', () => {
  const accountId = 'account-1'
  const accountKey = `openai:account:${accountId}`

  function loadService(accountOverrides = {}, now = '2026-04-09T10:30:00.000Z') {
    jest.resetModules()
    jest.useFakeTimers()
    jest.setSystemTime(new Date(now))

    const hashStore = new Map([
      [
        accountKey,
        {
          id: accountId,
          name: 'OpenAI Test',
          schedulable: 'true',
          isActive: 'true',
          status: 'active',
          ...accountOverrides
        }
      ]
    ])

    const client = {
      hgetall: jest.fn(async (key) => ({ ...(hashStore.get(key) || {}) })),
      hset: jest.fn(async (key, updates) => {
        const existing = hashStore.get(key) || {}
        hashStore.set(key, { ...existing, ...updates })
      }),
      sadd: jest.fn(async () => 1),
      srem: jest.fn(async () => 1),
      smembers: jest.fn(async () => []),
      del: jest.fn(async () => 1),
      setex: jest.fn(async () => 'OK'),
      expire: jest.fn(async () => 1),
      get: jest.fn(async () => null),
      pipeline: jest.fn(() => ({
        del: jest.fn().mockReturnThis(),
        exec: jest.fn(async () => [])
      }))
    }

    const redisMock = {
      getClientSafe: jest.fn(() => client),
      getDateInTimezone: jest.fn((date = new Date()) => new Date(date.getTime() + 8 * 3600000)),
      addToIndex: jest.fn(async () => {}),
      removeFromIndex: jest.fn(async () => {})
    }

    const webhookNotifier = {
      sendAccountAnomalyNotification: jest.fn(async () => {})
    }

    jest.doMock('../src/models/redis', () => redisMock)
    jest.doMock('../src/utils/logger', () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      success: jest.fn()
    }))
    jest.doMock('../src/utils/webhookNotifier', () => webhookNotifier)
    jest.doMock('../src/utils/proxyHelper', () => ({}))
    jest.doMock('../src/utils/upstreamErrorHelper', () => ({
      recordErrorHistory: jest.fn(async () => {})
    }))
    jest.doMock('../src/utils/tokenRefreshLogger', () => ({
      logRefreshStart: jest.fn(),
      logRefreshSuccess: jest.fn(),
      logRefreshError: jest.fn(),
      logTokenUsage: jest.fn(),
      logRefreshSkipped: jest.fn()
    }))
    jest.doMock('../src/services/tokenRefreshService', () => ({}))
    jest.doMock('../config/config', () => ({
      system: {
        timezoneOffset: 8
      }
    }))
    jest.doMock('../src/utils/commonHelper', () => ({
      createEncryptor: jest.fn(() => ({
        encrypt: (value) => value,
        decrypt: (value) => value,
        clearCache: jest.fn(),
        getStats: jest.fn(() => ({}))
      }))
    }))
    jest.doMock('axios', () => ({
      post: jest.fn()
    }))
    jest.doMock('uuid', () => ({
      v4: jest.fn(() => 'mock-uuid')
    }))

    jest.spyOn(global, 'setInterval').mockImplementation(() => 1)

    const service = require('../src/services/account/openaiAccountService')

    return {
      service,
      hashStore,
      webhookNotifier
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

  it('stops scheduling when the 5-hour limit reaches 95 percent', async () => {
    const { service, hashStore, webhookNotifier } = loadService({
      autoStopOnFiveHourLimit: 'true',
      codexPrimaryUsedPercent: '95'
    })

    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).toEqual(
      expect.objectContaining({
        schedulable: 'false',
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '5小时限额使用量接近上限，已自动停止调度',
        usageLimitResumeAt: ''
      })
    )
    expect(webhookNotifier.sendAccountAnomalyNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        errorCode: 'OPENAI_USAGE_LIMIT_WARNING',
        reason: '5小时限额使用量接近上限，已自动停止调度'
      })
    )
  })

  it('does not stop when all usage-limit switches are disabled', async () => {
    const { service, hashStore, webhookNotifier } = loadService({
      autoStopOnFiveHourLimit: 'false',
      autoStopOnWeeklyLimit: 'false',
      autoStopOnDailyOveruse: 'false',
      codexPrimaryUsedPercent: '99',
      codexSecondaryUsedPercent: '99',
      codexSecondaryResetAfterSeconds: '604800',
      codexSecondaryWindowMinutes: '10080'
    })

    const before = { ...hashStore.get(accountKey) }
    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).toEqual(before)
    expect(webhookNotifier.sendAccountAnomalyNotification).not.toHaveBeenCalled()
  })

  it('does not stop when the 5-hour usage stays below 95 percent', async () => {
    const { service, hashStore, webhookNotifier } = loadService({
      autoStopOnFiveHourLimit: 'true',
      codexPrimaryUsedPercent: '94.99'
    })

    const before = { ...hashStore.get(accountKey) }
    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).toEqual(before)
    expect(webhookNotifier.sendAccountAnomalyNotification).not.toHaveBeenCalled()
  })

  it('stops scheduling when the weekly limit reaches 95 percent', async () => {
    const { service, hashStore } = loadService({
      autoStopOnWeeklyLimit: 'true',
      codexPrimaryUsedPercent: '80',
      codexSecondaryUsedPercent: '95'
    })

    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).toEqual(
      expect.objectContaining({
        schedulable: 'false',
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '周限额使用量接近上限，已自动停止调度',
        usageLimitResumeAt: ''
      })
    )
  })

  it('does not stop when the weekly usage stays below 95 percent', async () => {
    const { service, hashStore, webhookNotifier } = loadService({
      autoStopOnWeeklyLimit: 'true',
      codexSecondaryUsedPercent: '94.99'
    })

    const before = { ...hashStore.get(accountKey) }
    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).toEqual(before)
    expect(webhookNotifier.sendAccountAnomalyNotification).not.toHaveBeenCalled()
  })

  it('stops scheduling for daily overuse and stores the next local midnight resume time', async () => {
    const { service, hashStore } = loadService({
      autoStopOnDailyOveruse: 'true',
      codexSecondaryUsedPercent: '33',
      codexSecondaryResetAfterSeconds: '604800',
      codexSecondaryWindowMinutes: '10080'
    })

    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).toEqual(
      expect.objectContaining({
        schedulable: 'false',
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '周限额当日均摊用量已超限，已自动停止调度',
        usageLimitResumeAt: '2026-04-09T16:00:00.000Z'
      })
    )
  })

  it('does not stop daily overuse at the exact cumulative threshold', async () => {
    const { service, hashStore, webhookNotifier } = loadService({
      autoStopOnDailyOveruse: 'true',
      codexSecondaryUsedPercent: '32',
      codexSecondaryResetAfterSeconds: '604800',
      codexSecondaryWindowMinutes: '10080'
    })

    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).not.toEqual(
      expect.objectContaining({
        usageLimitAutoStopped: 'true'
      })
    )
    expect(webhookNotifier.sendAccountAnomalyNotification).not.toHaveBeenCalled()
  })

  it('uses the day-3 cumulative threshold for daily overuse checks', async () => {
    const underThreshold = loadService({
      autoStopOnDailyOveruse: 'true',
      codexSecondaryUsedPercent: '76',
      codexSecondaryResetAfterSeconds: '432000',
      codexSecondaryWindowMinutes: '10080'
    })

    let account = await underThreshold.service.getAccount(accountId)
    await underThreshold.service.checkAndApplyUsageLimitStop(accountId, account)

    expect(underThreshold.hashStore.get(accountKey)).not.toEqual(
      expect.objectContaining({
        usageLimitAutoStopped: 'true'
      })
    )

    const overThreshold = loadService({
      autoStopOnDailyOveruse: 'true',
      codexSecondaryUsedPercent: '77',
      codexSecondaryResetAfterSeconds: '432000',
      codexSecondaryWindowMinutes: '10080'
    })

    account = await overThreshold.service.getAccount(accountId)
    await overThreshold.service.checkAndApplyUsageLimitStop(accountId, account)

    expect(overThreshold.hashStore.get(accountKey)).toEqual(
      expect.objectContaining({
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '周限额当日均摊用量已超限，已自动停止调度'
      })
    )
  })

  it('clamps day-6 and day-7 daily overuse checks to a 100 percent cumulative budget', async () => {
    const atClampLimit = loadService({
      autoStopOnDailyOveruse: 'true',
      codexSecondaryUsedPercent: '100',
      codexSecondaryResetAfterSeconds: '86400',
      codexSecondaryWindowMinutes: '10080'
    })

    let account = await atClampLimit.service.getAccount(accountId)
    await atClampLimit.service.checkAndApplyUsageLimitStop(accountId, account)

    expect(atClampLimit.hashStore.get(accountKey)).not.toEqual(
      expect.objectContaining({
        usageLimitAutoStopped: 'true'
      })
    )

    const overClampLimit = loadService({
      autoStopOnDailyOveruse: 'true',
      codexSecondaryUsedPercent: '101',
      codexSecondaryResetAfterSeconds: '86400',
      codexSecondaryWindowMinutes: '10080'
    })

    account = await overClampLimit.service.getAccount(accountId)
    await overClampLimit.service.checkAndApplyUsageLimitStop(accountId, account)

    expect(overClampLimit.hashStore.get(accountKey)).toEqual(
      expect.objectContaining({
        usageLimitAutoStopped: 'true',
        usageLimitStopReason: '周限额当日均摊用量已超限，已自动停止调度'
      })
    )
  })

  it('skips duplicate checks after the account is already usage-limit stopped', async () => {
    const { service, hashStore, webhookNotifier } = loadService({
      autoStopOnFiveHourLimit: 'true',
      codexPrimaryUsedPercent: '99',
      usageLimitAutoStopped: 'true',
      usageLimitStopReason: '5小时限额使用量接近上限，已自动停止调度',
      usageLimitStoppedAt: '2026-04-09T09:00:00.000Z'
    })

    const before = { ...hashStore.get(accountKey) }
    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).toEqual(before)
    expect(webhookNotifier.sendAccountAnomalyNotification).not.toHaveBeenCalled()
  })

  it('prioritizes the 5-hour stop reason when multiple rules match', async () => {
    const { service, hashStore } = loadService({
      autoStopOnFiveHourLimit: 'true',
      autoStopOnWeeklyLimit: 'true',
      autoStopOnDailyOveruse: 'true',
      codexPrimaryUsedPercent: '96',
      codexSecondaryUsedPercent: '96',
      codexSecondaryResetAfterSeconds: '604800',
      codexSecondaryWindowMinutes: '10080'
    })

    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).toEqual(
      expect.objectContaining({
        usageLimitStopReason: '5小时限额使用量接近上限，已自动停止调度',
        usageLimitResumeAt: ''
      })
    )
  })

  it('prioritizes the weekly stop reason over daily overuse when 5-hour protection is off', async () => {
    const { service, hashStore } = loadService({
      autoStopOnFiveHourLimit: 'false',
      autoStopOnWeeklyLimit: 'true',
      autoStopOnDailyOveruse: 'true',
      codexPrimaryUsedPercent: '10',
      codexSecondaryUsedPercent: '96',
      codexSecondaryResetAfterSeconds: '604800',
      codexSecondaryWindowMinutes: '10080'
    })

    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).toEqual(
      expect.objectContaining({
        usageLimitStopReason: '周限额使用量接近上限，已自动停止调度',
        usageLimitResumeAt: ''
      })
    )
  })

  it('does not stop daily overuse when required secondary window data is missing', async () => {
    const { service, hashStore, webhookNotifier } = loadService({
      autoStopOnDailyOveruse: 'true',
      codexSecondaryUsedPercent: '50',
      codexSecondaryWindowMinutes: '10080'
    })

    const before = { ...hashStore.get(accountKey) }
    const account = await service.getAccount(accountId)
    await service.checkAndApplyUsageLimitStop(accountId, account)

    expect(hashStore.get(accountKey)).toEqual(before)
    expect(webhookNotifier.sendAccountAnomalyNotification).not.toHaveBeenCalled()
  })
})
