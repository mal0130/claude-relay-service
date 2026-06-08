const kimiAccountService = require('../account/kimiAccountService')
const accountGroupService = require('../accountGroupService')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const { isActive, isSchedulable, sortAccountsByPriority } = require('../../utils/commonHelper')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')

class UnifiedKimiScheduler {
  constructor() {
    this.SESSION_MAPPING_PREFIX = 'kimi_session_mapping:'
  }

  async selectAccountForApiKey(apiKeyData, sessionHash = null, requestedModel = null) {
    if (sessionHash) {
      const mapped = await this._getSessionMapping(sessionHash)
      if (mapped && (await this._isAccountAvailable(mapped.accountId))) {
        await this._extendSessionMappingTTL(sessionHash)
        await kimiAccountService.markAccountUsed(mapped.accountId)
        logger.info(`🎯 Using sticky Kimi account: ${mapped.accountId}`)
        return { accountId: mapped.accountId, accountType: 'kimi' }
      }
      if (mapped) {
        await this.clearSessionMapping(sessionHash)
      }
    }

    const accounts = await this._getAllAvailableAccounts(apiKeyData, requestedModel)
    if (accounts.length === 0) {
      throw new Error('No available Kimi accounts')
    }

    const selected = sortAccountsByPriority(accounts)[0]

    if (sessionHash) {
      await this._setSessionMapping(sessionHash, selected.id)
    }

    await kimiAccountService.markAccountUsed(selected.id)
    logger.info(
      `🎯 Selected Kimi account: ${selected.name} (${selected.id}) with priority ${selected.priority}`
    )

    return { accountId: selected.id, accountType: 'kimi' }
  }

  async _getAllAvailableAccounts(apiKeyData, requestedModel = null) {
    const binding = this._getKimiBinding(apiKeyData)
    if (binding?.accountId) {
      const account = await kimiAccountService.getAccount(binding.accountId)
      if (account && (await this._isAccountUsable(account, requestedModel))) {
        return [account]
      }
      logger.warn(`⚠️ Bound Kimi account ${binding.accountId} unavailable, falling back to pool`)
    }

    if (binding?.groupId) {
      return await this.selectAccountFromGroup(binding.groupId, null, requestedModel, apiKeyData, {
        returnCandidates: true
      })
    }

    const accounts = await kimiAccountService.getAllAccounts(false)
    const available = []

    for (const account of accounts) {
      if (await this._isAccountUsable(account, requestedModel)) {
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
    options = {}
  ) {
    const members = await accountGroupService.getGroupMembers(groupId)
    const accounts = []

    for (const accountId of members) {
      const account = await kimiAccountService.getAccount(accountId)
      if (account && (await this._isAccountUsable(account, requestedModel))) {
        accounts.push(account)
      }
    }

    if (options.returnCandidates) {
      return accounts
    }

    if (accounts.length === 0) {
      throw new Error('No available Kimi accounts in group')
    }

    const selected = sortAccountsByPriority(accounts)[0]
    if (sessionHash) {
      await this._setSessionMapping(sessionHash, selected.id)
    }
    await kimiAccountService.markAccountUsed(selected.id)

    return { accountId: selected.id, accountType: 'kimi' }
  }

  async _isAccountUsable(account, requestedModel = null) {
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
      account = await kimiAccountService.getAccount(account.id)
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

    if (await upstreamErrorHelper.isTempUnavailable(account.id, 'kimi')) {
      return false
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

  async _isAccountAvailable(accountId) {
    const account = await kimiAccountService.getAccount(accountId)
    return this._isAccountUsable(account)
  }

  async isAccountRateLimited(accountId) {
    const account = await kimiAccountService.getAccount(accountId)
    if (!account) {
      return false
    }

    if (account.rateLimitStatus !== 'limited') {
      if (account.status === 'rateLimited' && !account.rateLimitStatus) {
        await kimiAccountService.setAccountRateLimited(accountId, false)
      }
      return false
    }

    const cleared = await kimiAccountService.checkAndClearRateLimit(accountId)
    return !cleared
  }

  async markAccountRateLimited(accountId, sessionHash = null, duration = null) {
    await kimiAccountService.setAccountRateLimited(accountId, true, duration)
    if (sessionHash) {
      await this.clearSessionMapping(sessionHash)
    }
  }

  async removeAccountRateLimit(accountId) {
    await kimiAccountService.setAccountRateLimited(accountId, false)
  }

  async markAccountUnauthorized(accountId, reason = null) {
    await kimiAccountService.markAccountUnauthorized(accountId, reason || 'Kimi账号认证失败')
  }

  _getKimiBinding(apiKeyData = {}) {
    const bindings = apiKeyData.accountBindings || {}
    const kimi = bindings.kimi
    if (!kimi || typeof kimi !== 'object') {
      return null
    }

    if (kimi.accountId) {
      if (String(kimi.accountId).startsWith('group:')) {
        return { groupId: String(kimi.accountId).replace(/^group:/, '') }
      }
      return { accountId: kimi.accountId }
    }

    if (kimi.groupId) {
      return { groupId: kimi.groupId }
    }

    return null
  }

  async _getSessionMapping(sessionHash) {
    const data = await redis.getClientSafe().get(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`)
    if (!data) {
      return null
    }
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  async _setSessionMapping(sessionHash, accountId) {
    const ttl = 24 * 60 * 60
    await redis
      .getClientSafe()
      .setex(
        `${this.SESSION_MAPPING_PREFIX}${sessionHash}`,
        ttl,
        JSON.stringify({ accountId, accountType: 'kimi', createdAt: new Date().toISOString() })
      )
  }

  async _extendSessionMappingTTL(sessionHash) {
    await redis.getClientSafe().expire(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`, 24 * 60 * 60)
  }

  async clearSessionMapping(sessionHash) {
    if (!sessionHash) {
      return
    }
    await redis.getClientSafe().del(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`)
  }
}

module.exports = new UnifiedKimiScheduler()
