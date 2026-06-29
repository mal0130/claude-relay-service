const { v4: uuidv4 } = require('uuid')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const { createEncryptor } = require('../../utils/commonHelper')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  DEEPSEEK_PLATFORM,
  DEEPSEEK_DEFAULT_BASE_API,
  normalizeBaseApi,
  normalizeOptionalBaseApi
} = require('../deepseekPlatform')

const encryptor = createEncryptor('deepseek-api-salt')

class DeepSeekAccountService {
  constructor() {
    this.ACCOUNT_KEY_PREFIX = 'deepseek:account:'
    this.ACCOUNT_INDEX_KEY = 'deepseek_account:index'
    this.SHARED_ACCOUNTS_KEY = 'shared_deepseek_accounts'
  }

  async createAccount(options = {}) {
    const {
      name = 'DeepSeek Account',
      description = '',
      baseApi = DEEPSEEK_DEFAULT_BASE_API,
      codeCompletionBaseApi = '',
      apiKey = '',
      priority = 50,
      proxy = null,
      isActive = true,
      accountType = 'shared',
      schedulable = true,
      dailyQuota = 0,
      quotaResetTime = '00:00',
      rateLimitDuration = 60,
      disableAutoProtection = false,
      supportedModels = {}
    } = options

    if (!apiKey) {
      throw new Error('API Key is required for DeepSeek account')
    }

    const accountId = uuidv4()
    const processedModels = this._processModelMapping(supportedModels)
    const accountData = {
      id: accountId,
      platform: 'deepseek',
      accountType,
      accountSubType: DEEPSEEK_PLATFORM.accountSubType,
      name,
      description,
      baseApi: normalizeBaseApi(baseApi),
      codeCompletionBaseApi: normalizeOptionalBaseApi(codeCompletionBaseApi),
      apiKey: encryptor.encrypt(apiKey),
      priority: priority.toString(),
      proxy: proxy ? JSON.stringify(proxy) : '',
      supportedModels: JSON.stringify(processedModels),
      isActive: isActive.toString(),
      schedulable: schedulable.toString(),
      dailyQuota: dailyQuota.toString(),
      dailyUsage: '0',
      lastResetDate: redis.getDateStringInTimezone(),
      quotaResetTime,
      quotaStoppedAt: '',
      providerQuotaResetAt: '',
      rateLimitDuration: rateLimitDuration.toString(),
      disableAutoProtection:
        disableAutoProtection === true || disableAutoProtection === 'true' ? 'true' : 'false',
      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      status: 'active',
      errorMessage: '',
      rateLimitedAt: '',
      rateLimitStatus: '',
      rateLimitResetAt: ''
    }

    await this._saveAccount(accountId, accountData)
    logger.success(`Created DeepSeek account: ${name} (${accountId})`)

    return { ...accountData, apiKey: '***' }
  }

  async getAccount(accountId) {
    const client = redis.getClientSafe()
    const accountData = await client.hgetall(`${this.ACCOUNT_KEY_PREFIX}${accountId}`)

    if (!accountData || !accountData.id) {
      return null
    }

    accountData.apiKey = encryptor.decrypt(accountData.apiKey)
    accountData.baseApi = normalizeBaseApi(accountData.baseApi)
    accountData.codeCompletionBaseApi = normalizeOptionalBaseApi(accountData.codeCompletionBaseApi)

    if (accountData.proxy) {
      try {
        accountData.proxy = JSON.parse(accountData.proxy)
      } catch {
        accountData.proxy = null
      }
    }

    try {
      accountData.supportedModels = JSON.parse(accountData.supportedModels || '{}')
    } catch {
      accountData.supportedModels = {}
    }

    return accountData
  }

  async updateAccount(accountId, updates = {}) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const normalizedUpdates = { ...updates }

    if (normalizedUpdates.apiKey) {
      normalizedUpdates.apiKey = encryptor.encrypt(normalizedUpdates.apiKey)
    } else {
      delete normalizedUpdates.apiKey
    }

    if (normalizedUpdates.proxy !== undefined) {
      normalizedUpdates.proxy = normalizedUpdates.proxy
        ? JSON.stringify(normalizedUpdates.proxy)
        : ''
    }

    if (normalizedUpdates.baseApi !== undefined) {
      normalizedUpdates.baseApi = normalizeBaseApi(normalizedUpdates.baseApi)
    }

    if (normalizedUpdates.codeCompletionBaseApi !== undefined) {
      normalizedUpdates.codeCompletionBaseApi = normalizeOptionalBaseApi(
        normalizedUpdates.codeCompletionBaseApi
      )
    }

    if (normalizedUpdates.disableAutoProtection !== undefined) {
      normalizedUpdates.disableAutoProtection =
        normalizedUpdates.disableAutoProtection === true ||
        normalizedUpdates.disableAutoProtection === 'true'
          ? 'true'
          : 'false'
    }

    if (normalizedUpdates.supportedModels !== undefined) {
      const processedModels = this._processModelMapping(normalizedUpdates.supportedModels)
      normalizedUpdates.supportedModels = JSON.stringify(processedModels)
    }

    for (const field of ['priority', 'dailyQuota', 'rateLimitDuration']) {
      if (normalizedUpdates[field] !== undefined) {
        normalizedUpdates[field] = normalizedUpdates[field].toString()
      }
    }

    for (const field of ['isActive', 'schedulable']) {
      if (normalizedUpdates[field] !== undefined) {
        normalizedUpdates[field] = normalizedUpdates[field].toString()
      }
    }

    const previousAccountType = account.accountType
    normalizedUpdates.updatedAt = new Date().toISOString()

    const client = redis.getClientSafe()
    await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, normalizedUpdates)

    if (normalizedUpdates.accountType && normalizedUpdates.accountType !== previousAccountType) {
      if (normalizedUpdates.accountType === 'shared') {
        await client.sadd(this.SHARED_ACCOUNTS_KEY, accountId)
      } else {
        await client.srem(this.SHARED_ACCOUNTS_KEY, accountId)
      }
    }

    logger.info(`📝 Updated DeepSeek account: ${account.name}`)
    return { success: true }
  }

  async deleteAccount(accountId) {
    const client = redis.getClientSafe()
    await client.srem(this.SHARED_ACCOUNTS_KEY, accountId)
    await redis.removeFromIndex(this.ACCOUNT_INDEX_KEY, accountId)
    await client.del(`${this.ACCOUNT_KEY_PREFIX}${accountId}`)
    await upstreamErrorHelper.clearTempUnavailable(accountId, 'deepseek').catch(() => {})
    logger.info(`🗑️ Deleted DeepSeek account: ${accountId}`)
    return { success: true }
  }

  async getAllAccounts(includeInactive = false) {
    const accountIds = await redis.getAllIdsByIndex(
      this.ACCOUNT_INDEX_KEY,
      `${this.ACCOUNT_KEY_PREFIX}*`,
      /^deepseek:account:(.+)$/
    )

    if (accountIds.length === 0) {
      return []
    }

    const keys = accountIds.map((id) => `${this.ACCOUNT_KEY_PREFIX}${id}`)
    const dataList = await redis.batchHgetallChunked(keys)
    const accounts = []

    for (const accountData of dataList) {
      if (!accountData || !accountData.id) {
        continue
      }

      if (!includeInactive && accountData.isActive !== 'true') {
        continue
      }

      accountData.apiKey = '***'
      accountData.baseApi = normalizeBaseApi(accountData.baseApi)
      accountData.codeCompletionBaseApi = normalizeOptionalBaseApi(
        accountData.codeCompletionBaseApi
      )
      accountData.platform = accountData.platform || 'deepseek'
      accountData.accountSubType = accountData.accountSubType || DEEPSEEK_PLATFORM.accountSubType

      if (accountData.proxy) {
        try {
          accountData.proxy = JSON.parse(accountData.proxy)
        } catch {
          accountData.proxy = null
        }
      }

      try {
        accountData.supportedModels = JSON.parse(accountData.supportedModels || '{}')
      } catch {
        accountData.supportedModels = {}
      }

      const rateLimitInfo = this._getRateLimitInfo(accountData)
      accountData.rateLimitStatus = rateLimitInfo.isRateLimited
        ? {
            isRateLimited: true,
            rateLimitedAt: accountData.rateLimitedAt || null,
            rateLimitResetAt: accountData.rateLimitResetAt || null,
            minutesRemaining: rateLimitInfo.remainingMinutes || 0
          }
        : {
            isRateLimited: false,
            rateLimitedAt: null,
            rateLimitResetAt: null,
            minutesRemaining: 0
          }

      accountData.schedulable = accountData.schedulable !== 'false'
      accountData.isActive = accountData.isActive === 'true'

      accounts.push(accountData)
    }

    return accounts
  }

  async markAccountUsed(accountId) {
    await this.updateAccount(accountId, { lastUsedAt: new Date().toISOString() })
  }

  async setAccountRateLimited(accountId, isLimited, duration = null) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    if (isLimited) {
      if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') {
        logger.info(`🛡️ DeepSeek account ${accountId} disabled auto-protection, skip rate limit`)
        upstreamErrorHelper
          .recordErrorHistory(accountId, 'deepseek', 429, 'rate_limit')
          .catch(() => {})
        return
      }

      const rateLimitDuration = duration || parseInt(account.rateLimitDuration, 10) || 60
      const now = new Date()
      const resetAt = new Date(now.getTime() + rateLimitDuration * 60000)

      await this.updateAccount(accountId, {
        rateLimitedAt: now.toISOString(),
        rateLimitStatus: 'limited',
        rateLimitResetAt: resetAt.toISOString(),
        rateLimitDuration: rateLimitDuration.toString(),
        status: 'rateLimited',
        schedulable: 'false',
        errorMessage: `Rate limited until ${resetAt.toISOString()}`
      })

      logger.warn(
        `⏳ DeepSeek account ${account.name} marked rate limited for ${rateLimitDuration} minutes`
      )
    } else {
      await this.updateAccount(accountId, {
        rateLimitedAt: '',
        rateLimitStatus: '',
        rateLimitResetAt: '',
        status: 'active',
        schedulable: 'true',
        errorMessage: ''
      })
      logger.info(`✅ Rate limit cleared for DeepSeek account ${account.name}`)
    }
  }

  async markAccountUnauthorized(accountId, reason = 'DeepSeek账号认证失败') {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') {
      logger.info(`🛡️ DeepSeek account ${accountId} disabled auto-protection, skip unauthorized`)
      upstreamErrorHelper
        .recordErrorHistory(accountId, 'deepseek', 401, 'auth_error')
        .catch(() => {})
      return
    }

    await this.updateAccount(accountId, {
      status: 'unauthorized',
      schedulable: 'false',
      errorMessage: reason,
      unauthorizedAt: new Date().toISOString()
    })

    logger.warn(`🚫 DeepSeek account ${account.name || accountId} marked unauthorized`)
  }

  async checkAndClearRateLimit(accountId) {
    const account = await this.getAccount(accountId)
    if (!account || account.rateLimitStatus !== 'limited') {
      return false
    }

    const now = new Date()
    let shouldClear = false

    if (account.rateLimitResetAt) {
      shouldClear = now >= new Date(account.rateLimitResetAt)
    } else if (account.rateLimitedAt) {
      const rateLimitDuration = parseInt(account.rateLimitDuration, 10) || 60
      shouldClear = now - new Date(account.rateLimitedAt) > rateLimitDuration * 60000
    }

    if (shouldClear) {
      await this.setAccountRateLimited(accountId, false)
      return true
    }

    return false
  }

  async toggleSchedulable(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const newSchedulableStatus = account.schedulable === 'true' ? 'false' : 'true'
    await this.updateAccount(accountId, { schedulable: newSchedulableStatus })

    return { success: true, schedulable: newSchedulableStatus === 'true' }
  }

  async resetAccountStatus(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    await this.updateAccount(accountId, {
      status: account.apiKey ? 'active' : 'created',
      schedulable: 'true',
      errorMessage: '',
      quotaStoppedAt: '',
      providerQuotaResetAt: '',
      rateLimitedAt: '',
      rateLimitStatus: '',
      rateLimitResetAt: ''
    })
    await upstreamErrorHelper.clearTempUnavailable(accountId, 'deepseek').catch(() => {})

    return { success: true, message: 'Account status reset successfully' }
  }

  async updateUsageQuota(accountId, amount) {
    if (!amount || amount <= 0) {
      return
    }

    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    const today = redis.getDateStringInTimezone()
    const currentUsage = account.lastResetDate === today ? parseFloat(account.dailyUsage) || 0 : 0
    const newUsage = currentUsage + amount
    const dailyQuota = parseFloat(account.dailyQuota) || 0
    const updates = {
      dailyUsage: newUsage.toString(),
      lastResetDate: today,
      quotaStoppedAt: account.lastResetDate === today ? account.quotaStoppedAt || '' : ''
    }

    if (dailyQuota > 0 && newUsage >= dailyQuota) {
      updates.status = 'quotaExceeded'
      updates.schedulable = 'false'
      updates.quotaStoppedAt = new Date().toISOString()
      updates.errorMessage = `Daily quota exceeded: $${newUsage.toFixed(2)} / $${dailyQuota.toFixed(2)}`
    }

    await this.updateAccount(accountId, updates)
  }

  _getRateLimitInfo(accountData) {
    if (accountData.rateLimitStatus !== 'limited') {
      return { isRateLimited: false }
    }

    const now = new Date()
    let willBeAvailableAt
    let remainingMinutes = 0

    if (accountData.rateLimitResetAt) {
      willBeAvailableAt = new Date(accountData.rateLimitResetAt)
      remainingMinutes = Math.max(0, Math.ceil((willBeAvailableAt - now) / 60000))
    } else if (accountData.rateLimitedAt) {
      const rateLimitDuration = parseInt(accountData.rateLimitDuration, 10) || 60
      willBeAvailableAt = new Date(
        new Date(accountData.rateLimitedAt).getTime() + rateLimitDuration * 60000
      )
      remainingMinutes = Math.max(0, Math.ceil((willBeAvailableAt - now) / 60000))
    }

    return { isRateLimited: remainingMinutes > 0, remainingMinutes, willBeAvailableAt }
  }

  async _saveAccount(accountId, accountData) {
    const client = redis.getClientSafe()
    await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, accountData)
    await redis.addToIndex(this.ACCOUNT_INDEX_KEY, accountId)

    if (accountData.accountType === 'shared') {
      await client.sadd(this.SHARED_ACCOUNTS_KEY, accountId)
    }
  }

  _processModelMapping(supportedModels) {
    if (!supportedModels || (Array.isArray(supportedModels) && supportedModels.length === 0)) {
      return {}
    }
    if (typeof supportedModels === 'object' && !Array.isArray(supportedModels)) {
      return supportedModels
    }
    if (Array.isArray(supportedModels)) {
      const mapping = {}
      supportedModels.forEach((model) => {
        if (model && typeof model === 'string') {
          mapping[model] = model
        }
      })
      return mapping
    }
    return {}
  }

  isModelSupported(modelMapping, requestedModel) {
    if (!modelMapping || Object.keys(modelMapping).length === 0) {
      return true
    }
    if (Object.prototype.hasOwnProperty.call(modelMapping, requestedModel)) {
      return true
    }
    const requestedModelLower = requestedModel.toLowerCase()
    for (const key of Object.keys(modelMapping)) {
      if (key.toLowerCase() === requestedModelLower) {
        return true
      }
    }
    return false
  }

  getMappedModel(modelMapping, requestedModel) {
    if (!modelMapping || Object.keys(modelMapping).length === 0) {
      return requestedModel
    }
    if (modelMapping[requestedModel]) {
      return modelMapping[requestedModel]
    }
    const requestedModelLower = requestedModel.toLowerCase()
    for (const [key, value] of Object.entries(modelMapping)) {
      if (key.toLowerCase() === requestedModelLower) {
        return value
      }
    }
    return requestedModel
  }
}

module.exports = new DeepSeekAccountService()
