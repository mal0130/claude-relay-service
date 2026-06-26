const deepseekAccountService = require('../account/deepseekAccountService')
const accountGroupService = require('../accountGroupService')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const { isActive, isSchedulable, sortAccountsByPriority } = require('../../utils/commonHelper')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')

class UnifiedDeepSeekScheduler {
  constructor() {
    this.SESSION_MAPPING_PREFIX = 'deepseek_session_mapping:'
  }

  async selectAccountForApiKey(
    apiKeyData,
    sessionHash = null,
    requestedModel = null,
    endpointType = 'chat'
  ) {
    if (sessionHash) {
      const mapped = await this._getSessionMapping(sessionHash, endpointType)
      if (
        mapped &&
        (await this._isAccountAvailable(mapped.accountId, requestedModel, endpointType))
      ) {
        await this._extendSessionMappingTTL(sessionHash, endpointType)
        await deepseekAccountService.markAccountUsed(mapped.accountId)
        logger.info(`🎯 Using sticky DeepSeek account: ${mapped.accountId}`)
        return { accountId: mapped.accountId, accountType: 'deepseek' }
      }
      if (mapped) {
        await this.clearSessionMapping(sessionHash, endpointType)
      }
    }

    const accounts = await this._getAllAvailableAccounts(apiKeyData, requestedModel, endpointType)
    if (accounts.length === 0) {
      throw new Error(
        endpointType === 'completion'
          ? 'No available DeepSeek completion accounts'
          : 'No available DeepSeek accounts'
      )
    }

    const selected = sortAccountsByPriority(accounts)[0]

    if (sessionHash) {
      await this._setSessionMapping(sessionHash, selected.id, endpointType)
    }

    await deepseekAccountService.markAccountUsed(selected.id)
    logger.info(
      `🎯 Selected DeepSeek account: ${selected.name} (${selected.id}) with priority ${selected.priority}`
    )

    return { accountId: selected.id, accountType: 'deepseek' }
  }

  async _getAllAvailableAccounts(apiKeyData, requestedModel = null, endpointType = 'chat') {
    const binding = this._getDeepSeekBinding(apiKeyData)
    if (binding?.accountId) {
      const account = await deepseekAccountService.getAccount(binding.accountId)
      if (account && (await this._isAccountUsable(account, requestedModel, endpointType))) {
        return [account]
      }
      if (endpointType === 'completion') {
        logger.warn(
          `⚠️ Bound DeepSeek completion account ${binding.accountId} unavailable, keeping binding strict`
        )
        return []
      }
      logger.warn(
        `⚠️ Bound DeepSeek account ${binding.accountId} unavailable, falling back to pool`
      )
    }

    if (binding?.groupId) {
      return await this.selectAccountFromGroup(
        binding.groupId,
        null,
        requestedModel,
        apiKeyData,
        {
          returnCandidates: true
        },
        endpointType
      )
    }

    const accounts = await deepseekAccountService.getAllAccounts(false)
    const available = []

    for (const account of accounts) {
      if (await this._isAccountUsable(account, requestedModel, endpointType)) {
        available.push(account)
      }
    }

    return available
  }

  async selectAccountFromGroup(
    groupId,
    sessionHash = null,
    requestedModel = null,
    apiKeyData = null,
    options = {},
    endpointType = 'chat'
  ) {
    const members = await accountGroupService.getGroupMembers(groupId)
    const accounts = []

    for (const accountId of members) {
      const account = await deepseekAccountService.getAccount(accountId)
      if (account && (await this._isAccountUsable(account, requestedModel, endpointType))) {
        accounts.push(account)
      }
    }

    if (options.returnCandidates) {
      return accounts
    }

    if (accounts.length === 0) {
      throw new Error('No available DeepSeek accounts in group')
    }

    const selected = sortAccountsByPriority(accounts)[0]
    if (sessionHash) {
      await this._setSessionMapping(sessionHash, selected.id, endpointType)
    }
    await deepseekAccountService.markAccountUsed(selected.id)

    return { accountId: selected.id, accountType: 'deepseek' }
  }

  async _isAccountUsable(account, requestedModel = null, endpointType = 'chat') {
    if (!account) {
      return false
    }

    if (!isActive(account.isActive)) {
      return false
    }

    const wasRateLimited =
      account.status === 'rateLimited' ||
      account.rateLimitStatus === 'limited' ||
      (typeof account.rateLimitStatus === 'object' &&
        account.rateLimitStatus.isRateLimited === true)

    if (await this.isAccountRateLimited(account.id)) {
      return false
    }

    if (wasRateLimited) {
      account = await deepseekAccountService.getAccount(account.id)
      if (!account) {
        return false
      }
    }

    if (!isSchedulable(account.schedulable)) {
      return false
    }

    if (!['active', 'rateLimited', 'quotaExceeded'].includes(account.status || 'active')) {
      return false
    }

    if (account.status === 'quotaExceeded') {
      return false
    }

    if (await upstreamErrorHelper.isTempUnavailable(account.id, 'deepseek')) {
      return false
    }

    if (endpointType === 'completion' && !account.codeCompletionBaseApi) {
      return false
    }

    if (
      requestedModel &&
      account.supportedModels &&
      typeof account.supportedModels === 'object' &&
      !Array.isArray(account.supportedModels) &&
      Object.keys(account.supportedModels).length > 0
    ) {
      return deepseekAccountService.isModelSupported(account.supportedModels, requestedModel)
    }

    if (
      requestedModel &&
      Array.isArray(account.supportedModels) &&
      account.supportedModels.length
    ) {
      return account.supportedModels.includes(requestedModel)
    }

    return true
  }

  async _isAccountAvailable(accountId, requestedModel = null, endpointType = 'chat') {
    const account = await deepseekAccountService.getAccount(accountId)
    return this._isAccountUsable(account, requestedModel, endpointType)
  }

  async isAccountRateLimited(accountId) {
    const account = await deepseekAccountService.getAccount(accountId)
    if (!account) {
      return false
    }

    if (account.rateLimitStatus !== 'limited') {
      if (account.status === 'rateLimited' && !account.rateLimitStatus) {
        await deepseekAccountService.setAccountRateLimited(accountId, false)
      }
      return false
    }

    const cleared = await deepseekAccountService.checkAndClearRateLimit(accountId)
    return !cleared
  }

  async markAccountRateLimited(
    accountId,
    sessionHash = null,
    duration = null,
    endpointType = 'chat'
  ) {
    await deepseekAccountService.setAccountRateLimited(accountId, true, duration)
    if (sessionHash) {
      await this.clearSessionMapping(sessionHash, endpointType)
    }
  }

  async removeAccountRateLimit(accountId) {
    await deepseekAccountService.setAccountRateLimited(accountId, false)
  }

  async markAccountUnauthorized(accountId, reason = null) {
    await deepseekAccountService.markAccountUnauthorized(
      accountId,
      reason || 'DeepSeek账号认证失败'
    )
  }

  _getDeepSeekBinding(apiKeyData = {}) {
    const bindings = apiKeyData.accountBindings || {}
    const deepseek = bindings.deepseek
    if (!deepseek || typeof deepseek !== 'object') {
      return null
    }

    if (deepseek.accountId) {
      if (String(deepseek.accountId).startsWith('group:')) {
        return { groupId: String(deepseek.accountId).replace(/^group:/, '') }
      }
      return { accountId: deepseek.accountId }
    }

    if (deepseek.groupId) {
      return { groupId: deepseek.groupId }
    }

    return null
  }

  _buildSessionMappingKey(sessionHash, endpointType = 'chat') {
    if (endpointType === 'completion') {
      return `${this.SESSION_MAPPING_PREFIX}completion:${sessionHash}`
    }

    return `${this.SESSION_MAPPING_PREFIX}${sessionHash}`
  }

  async _getSessionMapping(sessionHash, endpointType = 'chat') {
    const data = await redis
      .getClientSafe()
      .get(this._buildSessionMappingKey(sessionHash, endpointType))
    if (!data) {
      return null
    }
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  async _setSessionMapping(sessionHash, accountId, endpointType = 'chat') {
    const ttl = 24 * 60 * 60
    await redis.getClientSafe().setex(
      this._buildSessionMappingKey(sessionHash, endpointType),
      ttl,
      JSON.stringify({
        accountId,
        accountType: 'deepseek',
        endpointType,
        createdAt: new Date().toISOString()
      })
    )
  }

  async _extendSessionMappingTTL(sessionHash, endpointType = 'chat') {
    await redis
      .getClientSafe()
      .expire(this._buildSessionMappingKey(sessionHash, endpointType), 24 * 60 * 60)
  }

  async clearSessionMapping(sessionHash, endpointType = 'chat') {
    if (!sessionHash) {
      return
    }
    await redis.getClientSafe().del(this._buildSessionMappingKey(sessionHash, endpointType))
  }
}

module.exports = new UnifiedDeepSeekScheduler()
