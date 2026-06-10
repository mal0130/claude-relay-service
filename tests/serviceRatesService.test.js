jest.mock('../src/models/redis', () => ({
  client: {
    get: jest.fn(),
    set: jest.fn()
  }
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

describe('serviceRatesService', () => {
  let serviceRatesService

  beforeEach(() => {
    jest.resetModules()
    serviceRatesService = require('../src/services/serviceRatesService')
    serviceRatesService.clearCache()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('default rates include glm and kimi', () => {
    const defaults = serviceRatesService.getDefaultRates()

    expect(defaults.rates.glm).toBe(1.0)
    expect(defaults.rates.kimi).toBe(1.0)
    expect(defaults.rates.minimax).toBe(1.0)
  })

  test('resolves GLM, Kimi and MiniMax from accountType', () => {
    expect(serviceRatesService.getService('glm', 'claude-sonnet-4')).toBe('glm')
    expect(serviceRatesService.getService('kimi', 'claude-sonnet-4')).toBe('kimi')
    expect(serviceRatesService.getService('minimax', 'claude-sonnet-4')).toBe('minimax')
  })

  test('resolves GLM, Kimi and MiniMax from model name fallback', () => {
    expect(serviceRatesService.getService(null, 'glm-5.1')).toBe('glm')
    expect(serviceRatesService.getService(null, 'z-ai/glm-4')).toBe('glm')
    expect(serviceRatesService.getService(null, 'kimi-k2.6')).toBe('kimi')
    expect(serviceRatesService.getService(null, 'moonshot-v1-32k')).toBe('kimi')
    expect(serviceRatesService.getService(null, 'MiniMax-M3')).toBe('minimax')
  })
})
