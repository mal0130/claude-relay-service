jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({
    stop: jest.fn()
  })),
  validate: jest.fn(() => true)
}))

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(),
  setAccountLock: jest.fn(),
  releaseAccountLock: jest.fn(),
  getDateStringInTimezone: jest.fn(() => '2026-06-23')
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

describe('costInitService scheduler', () => {
  let cron
  let redis
  let costInitService
  const originalSchedulerEnabled = process.env.COST_INIT_SCHEDULER_ENABLED

  beforeEach(() => {
    jest.resetModules()
    delete process.env.COST_INIT_SCHEDULER_ENABLED
    cron = require('node-cron')
    redis = require('../src/models/redis')
    costInitService = require('../src/services/costInitService')
  })

  afterEach(() => {
    costInitService.stopScheduler()
    if (originalSchedulerEnabled === undefined) {
      delete process.env.COST_INIT_SCHEDULER_ENABLED
    } else {
      process.env.COST_INIT_SCHEDULER_ENABLED = originalSchedulerEnabled
    }
    jest.clearAllMocks()
  })

  test('does not start scheduler unless explicitly enabled', () => {
    const started = costInitService.startScheduler()

    expect(started).toBe(false)
    expect(cron.validate).not.toHaveBeenCalled()
    expect(cron.schedule).not.toHaveBeenCalled()
  })

  test('starts daily 2am scheduler in configured timezone when explicitly enabled', () => {
    process.env.COST_INIT_SCHEDULER_ENABLED = 'true'
    costInitService.startScheduler()

    expect(cron.validate).toHaveBeenCalledWith('0 2 * * *')
    expect(cron.schedule).toHaveBeenCalledWith('0 2 * * *', expect.any(Function), {
      scheduled: true,
      timezone: 'Asia/Shanghai'
    })
  })

  test('scheduled initialization acquires lock and marks today as done', async () => {
    const client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK')
    }
    redis.getClientSafe.mockReturnValue(client)
    redis.setAccountLock.mockResolvedValue(true)
    redis.releaseAccountLock.mockResolvedValue(true)
    jest.spyOn(costInitService, 'initializeAllCosts').mockResolvedValue({
      processed: 3,
      errors: 0
    })

    const result = await costInitService.runScheduledInitialization()

    expect(result.success).toBe(true)
    expect(costInitService.initializeAllCosts).toHaveBeenCalled()
    expect(redis.setAccountLock).toHaveBeenCalledWith(
      'lock:init:cost:2026-06-23',
      expect.any(String),
      8 * 60 * 60 * 1000
    )
    expect(client.set).toHaveBeenCalledWith(
      'init:cost:2026-06-23:done',
      expect.any(String),
      'EX',
      2 * 24 * 3600
    )
    expect(redis.releaseAccountLock).toHaveBeenCalledWith(
      'lock:init:cost:2026-06-23',
      expect.any(String)
    )
  })

  test('scheduled initialization skips when already completed today', async () => {
    const client = {
      get: jest.fn().mockResolvedValue('done'),
      set: jest.fn()
    }
    redis.getClientSafe.mockReturnValue(client)
    redis.setAccountLock.mockResolvedValue(true)
    jest.spyOn(costInitService, 'initializeAllCosts').mockResolvedValue({
      processed: 3,
      errors: 0
    })

    const result = await costInitService.runScheduledInitialization()

    expect(result).toEqual({
      success: true,
      skipped: true,
      reason: 'already_done'
    })
    expect(costInitService.initializeAllCosts).not.toHaveBeenCalled()
    expect(redis.setAccountLock).not.toHaveBeenCalled()
  })
})
