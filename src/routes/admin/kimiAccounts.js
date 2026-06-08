const express = require('express')
const axios = require('axios')
const kimiAccountService = require('../../services/account/kimiAccountService')
const apiKeyService = require('../../services/apiKeyService')
const accountGroupService = require('../../services/accountGroupService')
const redis = require('../../models/redis')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const webhookNotifier = require('../../utils/webhookNotifier')
const ProxyHelper = require('../../utils/proxyHelper')
const { buildChatCompletionsUrl, KIMI_DEFAULT_MODEL } = require('../../services/kimiPlatform')

const router = express.Router()

function validateAccountType(accountType) {
  return !accountType || ['shared', 'dedicated', 'group'].includes(accountType)
}

async function getAccountUsageStats(accountIds) {
  const client = redis.getClientSafe()
  const today = redis.getDateStringInTimezone()
  const tzDate = redis.getDateInTimezone()
  const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
  const pipeline = client.pipeline()

  for (const accountId of accountIds) {
    pipeline.hgetall(`account_usage:${accountId}`)
    pipeline.hgetall(`account_usage:daily:${accountId}:${today}`)
    pipeline.hgetall(`account_usage:monthly:${accountId}:${currentMonth}`)
  }

  const results = await pipeline.exec()
  const usageMap = new Map()
  const parseUsage = (data) => ({
    requests: parseInt(data?.totalRequests || data?.requests, 10) || 0,
    tokens: parseInt(data?.totalTokens || data?.tokens, 10) || 0,
    inputTokens: parseInt(data?.totalInputTokens || data?.inputTokens, 10) || 0,
    outputTokens: parseInt(data?.totalOutputTokens || data?.outputTokens, 10) || 0,
    cacheCreateTokens: parseInt(data?.totalCacheCreateTokens || data?.cacheCreateTokens, 10) || 0,
    cacheReadTokens: parseInt(data?.totalCacheReadTokens || data?.cacheReadTokens, 10) || 0
  })

  for (let i = 0; i < accountIds.length; i++) {
    const [errTotal, total] = results[i * 3]
    const [errDaily, daily] = results[i * 3 + 1]
    const [errMonthly, monthly] = results[i * 3 + 2]
    usageMap.set(accountIds[i], {
      total: errTotal ? {} : parseUsage(total),
      daily: errDaily ? {} : parseUsage(daily),
      monthly: errMonthly ? {} : parseUsage(monthly)
    })
  }

  return usageMap
}

router.get('/kimi-accounts', authenticateAdmin, async (req, res) => {
  try {
    const { platform, groupId } = req.query
    let accounts = await kimiAccountService.getAllAccounts(true)

    if (platform && platform !== 'kimi') {
      accounts = []
    }

    if (groupId) {
      const group = await accountGroupService.getGroup(groupId)
      if (group && group.platform === 'kimi') {
        const groupMembers = await accountGroupService.getGroupMembers(groupId)
        accounts = accounts.filter((account) => groupMembers.includes(account.id))
      } else {
        accounts = []
      }
    }

    const accountIds = accounts.map((account) => account.id)
    await Promise.all(accountIds.map((id) => kimiAccountService.checkAndClearRateLimit(id)))

    const [allGroupInfosMap, dailyCostMap, usageMap] = await Promise.all([
      accountGroupService.batchGetAccountGroupsByIndex(accountIds, 'kimi'),
      redis.batchGetAccountDailyCost(accountIds),
      getAccountUsageStats(accountIds)
    ])

    const accountsWithStats = accounts.map((account) => ({
      ...account,
      groupInfos: allGroupInfosMap.get(account.id) || [],
      usage: {
        daily: {
          ...(usageMap.get(account.id)?.daily || {}),
          cost: dailyCostMap.get(account.id) || 0
        },
        total: usageMap.get(account.id)?.total || {},
        monthly: usageMap.get(account.id)?.monthly || {}
      },
      boundApiKeys: 0
    }))

    return res.json({ success: true, data: accountsWithStats })
  } catch (error) {
    logger.error('Failed to get Kimi accounts:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
})

router.post('/kimi-accounts', authenticateAdmin, async (req, res) => {
  try {
    const { accountType, groupId, groupIds } = req.body
    if (!validateAccountType(accountType)) {
      return res.status(400).json({ success: false, error: 'Invalid account type' })
    }
    if (accountType === 'group' && !groupId && (!groupIds || groupIds.length === 0)) {
      return res.status(400).json({ success: false, error: 'Group ID is required' })
    }

    const account = await kimiAccountService.createAccount(req.body)

    if (accountType === 'group') {
      if (groupIds && groupIds.length > 0) {
        await accountGroupService.setAccountGroups(account.id, groupIds, 'kimi')
      } else if (groupId) {
        await accountGroupService.addAccountToGroup(account.id, groupId, 'kimi')
      }
    }

    logger.success(`🏢 Admin created Kimi account: ${account.name}`)
    return res.json({ success: true, data: account })
  } catch (error) {
    logger.error('Failed to create Kimi account:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.get('/kimi-accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    const account = await kimiAccountService.getAccount(req.params.id)
    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' })
    }
    account.apiKey = '***'
    return res.json({ success: true, data: account })
  } catch (error) {
    logger.error('Failed to get Kimi account:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.put('/kimi-accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const updates = req.body

    if (updates.priority !== undefined) {
      const priority = parseInt(updates.priority, 10)
      if (Number.isNaN(priority) || priority < 1 || priority > 100) {
        return res.status(400).json({ success: false, message: 'Priority must be 1-100' })
      }
    }

    if (!validateAccountType(updates.accountType)) {
      return res.status(400).json({ success: false, error: 'Invalid account type' })
    }

    const currentAccount = await kimiAccountService.getAccount(id)
    if (!currentAccount) {
      return res.status(404).json({ success: false, error: 'Account not found' })
    }

    if (updates.accountType !== undefined) {
      if (currentAccount.accountType === 'group') {
        await accountGroupService.removeAccountFromAllGroups(id)
      }
      if (updates.accountType === 'group') {
        if (updates.groupIds && updates.groupIds.length > 0) {
          await accountGroupService.setAccountGroups(id, updates.groupIds, 'kimi')
        } else if (updates.groupId) {
          await accountGroupService.addAccountToGroup(id, updates.groupId, 'kimi')
        }
      }
    }

    const result = await kimiAccountService.updateAccount(id, updates)
    return res.json({ success: true, ...result })
  } catch (error) {
    logger.error('Failed to update Kimi account:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.delete('/kimi-accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const account = await kimiAccountService.getAccount(id)
    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' })
    }

    const unboundCount = await apiKeyService.unbindAccountFromAllKeys(id, 'kimi')

    if (account.accountType === 'group') {
      await accountGroupService.removeAccountFromAllGroups(id)
    }

    const result = await kimiAccountService.deleteAccount(id)
    return res.json({ success: true, ...result, unboundKeys: unboundCount })
  } catch (error) {
    logger.error('Failed to delete Kimi account:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.put('/kimi-accounts/:id/toggle-schedulable', authenticateAdmin, async (req, res) => {
  try {
    const result = await kimiAccountService.toggleSchedulable(req.params.id)
    if (!result.schedulable) {
      await webhookNotifier.sendAccountEvent('account.status_changed', {
        accountId: req.params.id,
        platform: 'kimi',
        schedulable: result.schedulable,
        changedBy: 'admin',
        action: 'stopped_scheduling'
      })
    }
    return res.json(result)
  } catch (error) {
    logger.error('Failed to toggle Kimi account schedulable:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.put('/kimi-accounts/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    const account = await kimiAccountService.getAccount(req.params.id)
    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' })
    }
    const isActive = account.isActive === 'true' ? 'false' : 'true'
    await kimiAccountService.updateAccount(req.params.id, { isActive })
    return res.json({ success: true, isActive: isActive === 'true' })
  } catch (error) {
    logger.error('Failed to toggle Kimi account:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/kimi-accounts/:id/reset-rate-limit', authenticateAdmin, async (req, res) => {
  try {
    await kimiAccountService.setAccountRateLimited(req.params.id, false)
    return res.json({ success: true, message: 'Rate limit reset successfully' })
  } catch (error) {
    logger.error('Failed to reset Kimi account rate limit:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/kimi-accounts/:id/reset-status', authenticateAdmin, async (req, res) => {
  try {
    const result = await kimiAccountService.resetAccountStatus(req.params.id)
    return res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Failed to reset Kimi account status:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/kimi-accounts/:accountId/test', authenticateAdmin, async (req, res) => {
  const { accountId } = req.params
  const { model = KIMI_DEFAULT_MODEL, prompt = 'hi' } = req.body
  const maxTokens = Math.min(Math.max(parseInt(req.body.maxTokens, 10) || 100, 1), 4096)

  try {
    const account = await kimiAccountService.getAccount(accountId)
    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' })
    }
    if (!account.apiKey) {
      return res
        .status(401)
        .json({ success: false, error: 'API Key not found or decryption failed' })
    }

    const requestConfig = {
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000,
      validateStatus: () => true
    }

    if (account.proxy) {
      const agent = ProxyHelper.createProxyAgent(account.proxy)
      if (agent) {
        requestConfig.httpAgent = agent
        requestConfig.httpsAgent = agent
      }
    }

    const response = await axios.post(
      buildChatCompletionsUrl(account.baseApi),
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        stream: false
      },
      requestConfig
    )

    return res.status(response.status >= 400 ? 400 : 200).json({
      success: response.status < 400,
      status: response.status,
      data: response.data
    })
  } catch (error) {
    logger.error('Kimi account test failed:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

module.exports = router
