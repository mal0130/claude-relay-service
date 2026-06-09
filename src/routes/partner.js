const express = require('express')
const router = express.Router()
const { authenticatePartner } = require('../middleware/partnerAuth')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const apiKeyService = require('../services/apiKeyService')
const accountGroupService = require('../services/accountGroupService')
const openaiResponsesAccountService = require('../services/account/openaiResponsesAccountService')
const deepseekAccountService = require('../services/account/deepseekAccountService')
const minimaxAccountService = require('../services/account/minimaxAccountService')
const glmAccountService = require('../services/account/glmAccountService')
const kimiAccountService = require('../services/account/kimiAccountService')
const config = require('../../config/config')

// Helper: Find API Key by ID or Name
async function findApiKey(keyId, keyName) {
  const client = redis.getClientSafe()

  if (keyId) {
    const targetKey = await redis.getApiKey(keyId)
    if (!targetKey || !targetKey.id || targetKey.deleted) {
      return null
    }
    return targetKey
  }

  if (keyName) {
    const allKeyIds = await client.smembers('apikey:set:active')
    for (const id of allKeyIds) {
      const apiKey = await redis.getApiKey(id)
      if (apiKey && apiKey.name === keyName && !apiKey.deleted) {
        return apiKey
      }
    }
  }
  return null
}

function parseRateLimits(rateLimits) {
  if (!rateLimits) {
    return []
  }

  let parsed = rateLimits
  if (typeof rateLimits === 'string') {
    try {
      parsed = JSON.parse(rateLimits)
    } catch (_error) {
      return []
    }
  }

  return Array.isArray(parsed) ? parsed : []
}

function normalizeMemberUids(memberUids) {
  if (!Array.isArray(memberUids)) {
    return []
  }

  const normalized = []
  const seen = new Set()

  for (const memberUid of memberUids) {
    if (typeof memberUid !== 'string') {
      continue
    }

    const trimmedUid = memberUid.trim()
    if (!trimmedUid || seen.has(trimmedUid)) {
      continue
    }

    seen.add(trimmedUid)
    normalized.push(trimmedUid)
  }

  return normalized
}

// Helper: Get usage summary for a key
async function getUsageSummary(apiKey) {
  const client = redis.getClientSafe()
  const keyId = apiKey.id
  const totalCostKey = `usage:cost:total:${keyId}`
  const totalCost = parseFloat((await client.get(totalCostKey)) || '0')
  const normalizedRateLimits = parseRateLimits(apiKey.rateLimits)
  const effectiveRateLimits =
    normalizedRateLimits.length > 0
      ? normalizedRateLimits
      : (() => {
          const legacyWindow = parseInt(apiKey.rateLimitWindow || 0)
          const legacyRequests = parseInt(apiKey.rateLimitRequests || 0)
          const legacyCost = parseFloat(apiKey.rateLimitCost || 0)
          if (legacyWindow > 0 && (legacyRequests > 0 || legacyCost > 0)) {
            return [{ window: legacyWindow, requests: legacyRequests, cost: legacyCost }]
          }
          return []
        })()

  const windowLimits = []
  const now = Date.now()
  let recentUsageRecords = null
  const loadRecentUsageRecords = async () => {
    if (recentUsageRecords !== null) {
      return recentUsageRecords
    }

    recentUsageRecords = await redis.getUsageRecords(keyId, 200)
    return recentUsageRecords
  }

  for (let index = 0; index < effectiveRateLimits.length; index++) {
    const rule = effectiveRateLimits[index]
    const windowMinutes = parseInt(rule?.window || 0)
    const requestsLimit = parseInt(rule?.requests || 0)
    const costLimit = parseFloat(rule?.cost || 0)

    if (windowMinutes <= 0 || (requestsLimit <= 0 && costLimit <= 0)) {
      continue
    }

    const suffix = effectiveRateLimits.length === 1 ? '' : `:${index}`
    const requestCountKey = `rate_limit:requests:${keyId}${suffix}`
    const costCountKey = `rate_limit:cost:${keyId}${suffix}`
    const windowStartKey = `rate_limit:window_start:${keyId}${suffix}`

    let currentRequests = parseInt((await client.get(requestCountKey)) || '0')
    let currentCost = parseFloat((await client.get(costCountKey)) || '0')
    let windowStartTime = null
    let windowEndTime = null
    let remainingSeconds = null

    const windowStart = await client.get(windowStartKey)
    if (windowStart) {
      windowStartTime = parseInt(windowStart)
      const windowDuration = windowMinutes * 60 * 1000
      windowEndTime = windowStartTime + windowDuration

      if (now < windowEndTime) {
        remainingSeconds = Math.max(0, Math.floor((windowEndTime - now) / 1000))

        // 兼容历史数据：窗口费用计数器缺失时，用最近 usage 记录回算倍率费用。
        if (costLimit > 0 && currentCost <= 0) {
          const usageRecords = await loadRecentUsageRecords()
          currentCost = Number(
            usageRecords
              .filter((record) => {
                if (!record || typeof record.cost !== 'number') {
                  return false
                }

                const timestamp = Date.parse(record.timestamp)
                return Number.isFinite(timestamp) && timestamp >= windowStartTime
              })
              .reduce((sum, record) => sum + record.cost, 0)
              .toFixed(6)
          )
        }
      } else {
        remainingSeconds = 0
        currentRequests = 0
        currentCost = 0
      }
    }

    windowLimits.push({
      windowMinutes,
      windowStartTime,
      windowEndTime,
      remainingSeconds,
      requests:
        requestsLimit > 0
          ? {
              current: currentRequests,
              limit: requestsLimit,
              percentage:
                requestsLimit > 0 ? Number(((currentRequests / requestsLimit) * 100).toFixed(2)) : 0
            }
          : null,
      cost:
        costLimit > 0
          ? {
              current: Number(currentCost.toFixed(6)),
              limit: costLimit,
              percentage: costLimit > 0 ? Number(((currentCost / costLimit) * 100).toFixed(2)) : 0
            }
          : null
    })
  }

  return {
    keyId: apiKey.id,
    keyName: apiKey.name,
    totalCost: parseFloat(totalCost.toFixed(4)),
    totalCostLimit: parseFloat(apiKey.totalCostLimit || 0),
    windowLimits
  }
}

// Helper: Get usage details for a key
function validateRate(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const rateNum = Number(value)
  if (Number.isNaN(rateNum) || rateNum <= 0) {
    return `${fieldName} must be a positive number`
  }

  if (!/^\d+(\.\d)?$/.test(value.toString())) {
    return `${fieldName} must be an integer or have at most 1 decimal place`
  }

  return null
}

function resolveClaudeRate(primaryRate, fallbackRate = undefined) {
  return primaryRate !== undefined && primaryRate !== null && primaryRate !== ''
    ? primaryRate
    : fallbackRate
}

async function resolveClaudeBindingFields(claudeAccountId) {
  const isClaudeGroupBinding = claudeAccountId.startsWith('group:')

  if (isClaudeGroupBinding) {
    const groupId = claudeAccountId.substring('group:'.length)
    const group = await accountGroupService.getGroup(groupId)

    if (!group || group.platform !== 'claude') {
      throw new Error('Claude account group not found or invalid')
    }

    return {
      claudeAccountId,
      claudeConsoleAccountId: null
    }
  }

  const claudeConsoleAccountService = require('../services/account/claudeConsoleAccountService')
  const account = await claudeConsoleAccountService.getAccount(claudeAccountId)

  if (!account) {
    throw new Error('Claude account not found or inactive')
  }

  return {
    claudeAccountId: null,
    claudeConsoleAccountId: claudeAccountId
  }
}

async function validateOpenAIBinding(openaiAccountId) {
  const openaiAccountService = require('../services/account/openaiAccountService')

  if (openaiAccountId.startsWith('group:')) {
    const groupId = openaiAccountId.substring('group:'.length)
    const group = await accountGroupService.getGroup(groupId)
    return !!group && group.platform === 'openai'
  }

  if (openaiAccountId.startsWith('responses:')) {
    const accountId = openaiAccountId.substring('responses:'.length)
    const account = await openaiResponsesAccountService.getAccount(accountId)
    return !!account
  }

  const account = await openaiAccountService.getAccount(openaiAccountId)
  return !!account
}

async function resolveSharedPlatformBinding(accountId, options = {}) {
  const {
    platform,
    service,
    requiredMessage = 'Account ID is required',
    groupNotFoundMessage = 'Account group not found or invalid',
    accountNotFoundMessage = 'Account not found or inactive'
  } = options

  const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : ''

  if (!normalizedAccountId) {
    throw new Error(requiredMessage)
  }

  if (normalizedAccountId.startsWith('group:')) {
    const groupId = normalizedAccountId.substring('group:'.length)
    const group = await accountGroupService.getGroup(groupId)

    if (!group || group.platform !== platform) {
      throw new Error(groupNotFoundMessage)
    }
  } else {
    const account = await service.getAccount(normalizedAccountId)

    if (!account) {
      throw new Error(accountNotFoundMessage)
    }
  }

  return {
    mode: 'shared',
    accountId: normalizedAccountId
  }
}

async function resolveDeepSeekBinding(deepseekAccountId) {
  return resolveSharedPlatformBinding(deepseekAccountId, {
    platform: 'deepseek',
    service: deepseekAccountService,
    requiredMessage: 'DeepSeek account ID is required',
    groupNotFoundMessage: 'DeepSeek account group not found or invalid',
    accountNotFoundMessage: 'DeepSeek account not found or inactive'
  })
}

async function resolveMiniMaxBinding(minimaxAccountId) {
  return resolveSharedPlatformBinding(minimaxAccountId, {
    platform: 'minimax',
    service: minimaxAccountService,
    requiredMessage: 'MiniMax account ID is required',
    groupNotFoundMessage: 'MiniMax account group not found or invalid',
    accountNotFoundMessage: 'MiniMax account not found or inactive'
  })
}

async function resolveGlmBinding(glmAccountId) {
  return resolveSharedPlatformBinding(glmAccountId, {
    platform: 'glm',
    service: glmAccountService,
    requiredMessage: 'GLM account ID is required',
    groupNotFoundMessage: 'GLM account group not found or invalid',
    accountNotFoundMessage: 'GLM account not found or inactive'
  })
}

async function resolveKimiBinding(kimiAccountId) {
  return resolveSharedPlatformBinding(kimiAccountId, {
    platform: 'kimi',
    service: kimiAccountService,
    requiredMessage: 'Kimi account ID is required',
    groupNotFoundMessage: 'Kimi account group not found or invalid',
    accountNotFoundMessage: 'Kimi account not found or inactive'
  })
}

function normalizePermissionList(permissions) {
  if (!permissions) {
    return []
  }

  if (Array.isArray(permissions)) {
    return permissions
  }

  if (typeof permissions === 'string') {
    if (permissions.startsWith('[')) {
      try {
        const parsed = JSON.parse(permissions)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }

    if (permissions === 'all') {
      return []
    }

    if (permissions.includes(',')) {
      return permissions
        .split(',')
        .map((permission) => permission.trim())
        .filter(Boolean)
    }

    return [permissions]
  }

  return []
}

function normalizeServiceRates(serviceRates) {
  if (!serviceRates) {
    return {}
  }

  if (typeof serviceRates === 'string') {
    try {
      const parsed = JSON.parse(serviceRates)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return typeof serviceRates === 'object' && !Array.isArray(serviceRates) ? serviceRates : {}
}

function normalizeAccountBindings(accountBindings) {
  if (!accountBindings) {
    return {}
  }

  if (typeof accountBindings === 'object' && !Array.isArray(accountBindings)) {
    return accountBindings
  }

  if (typeof accountBindings === 'string') {
    try {
      const parsed = JSON.parse(accountBindings)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return {}
}

function buildAccountBindings(
  currentBindings = {},
  deepseekBinding = null,
  minimaxBinding = null,
  glmBinding = null,
  kimiBinding = null
) {
  const accountBindings = { ...normalizeAccountBindings(currentBindings) }

  if (deepseekBinding) {
    accountBindings.deepseek = deepseekBinding
  }

  if (minimaxBinding) {
    accountBindings.minimax = minimaxBinding
  }

  if (glmBinding) {
    accountBindings.glm = glmBinding
  }

  if (kimiBinding) {
    accountBindings.kimi = kimiBinding
  }

  return accountBindings
}

function buildServiceRates(
  currentRates = {},
  claudeRate,
  openaiRate,
  deepseekRate,
  minimaxRate,
  glmRate,
  kimiRate
) {
  const serviceRates = { ...normalizeServiceRates(currentRates) }

  if (claudeRate !== undefined && claudeRate !== null && claudeRate !== '') {
    serviceRates.claude = Number(claudeRate)
  }

  if (openaiRate !== undefined && openaiRate !== null && openaiRate !== '') {
    serviceRates.codex = Number(openaiRate)
  }

  if (deepseekRate !== undefined && deepseekRate !== null && deepseekRate !== '') {
    serviceRates.deepseek = Number(deepseekRate)
  }

  if (minimaxRate !== undefined && minimaxRate !== null && minimaxRate !== '') {
    serviceRates.minimax = Number(minimaxRate)
  }

  if (glmRate !== undefined && glmRate !== null && glmRate !== '') {
    serviceRates.glm = Number(glmRate)
  }

  if (kimiRate !== undefined && kimiRate !== null && kimiRate !== '') {
    serviceRates.kimi = Number(kimiRate)
  }

  return serviceRates
}

async function getUsageDetails(apiKey) {
  const client = redis.getClientSafe()
  const keyId = apiKey.id

  // 1. Generate date list (last 30 days)
  const tzDate = redis.getDateInTimezone()
  const dateStrings = []
  for (let i = 0; i < 30; i++) {
    const d = new Date(tzDate)
    d.setDate(d.getDate() - i)
    dateStrings.push(redis.getDateStringInTimezone(d))
  }

  // 2. Find models used
  const modelSet = new Set()
  const alltimeKeys = await redis.scanKeys(`usage:${keyId}:model:alltime:*`)
  alltimeKeys.forEach((k) => {
    const parts = k.split(':')
    if (parts.length >= 5) {
      modelSet.add(parts.slice(4).join(':'))
    }
  })
  const models = Array.from(modelSet)

  // 3. Pipeline query
  const pipeline = client.pipeline()
  const queryMap = []

  for (const dateStr of dateStrings) {
    pipeline.hgetall(`usage:daily:${keyId}:${dateStr}`)
    queryMap.push({ type: 'daily', date: dateStr })

    pipeline.get(`usage:cost:daily:${keyId}:${dateStr}`)
    queryMap.push({ type: 'cost', date: dateStr })

    for (const model of models) {
      pipeline.hgetall(`usage:${keyId}:model:daily:${model}:${dateStr}`)
      queryMap.push({ type: 'model', date: dateStr, model })
    }
  }

  const results = await pipeline.exec()

  // 4. Aggregate data
  const dailyMap = {}
  const modelStatsMap = {}
  const dailyModelMap = {}

  dateStrings.forEach((date) => {
    dailyMap[date] = {
      date,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      cost: 0
    }
  })

  results.forEach(([err, data], index) => {
    if (err || !data) {
      return
    }
    const query = queryMap[index]

    if (query.type === 'daily') {
      if (Object.keys(data).length > 0) {
        const day = dailyMap[query.date]
        day.requests += parseInt(data.requests || 0)
        day.inputTokens += parseInt(data.inputTokens || 0)
        day.outputTokens += parseInt(data.outputTokens || 0)
        day.cacheCreateTokens += parseInt(data.cacheCreateTokens || 0)
        day.cacheReadTokens += parseInt(data.cacheReadTokens || 0)
      }
    } else if (query.type === 'cost') {
      dailyMap[query.date].cost += parseFloat(data || 0)
    } else if (query.type === 'model') {
      if (Object.keys(data).length > 0) {
        const requests = parseInt(data.requests || 0)
        const inputTokens = parseInt(data.inputTokens || 0)
        const outputTokens = parseInt(data.outputTokens || 0)
        const cacheCreateTokens = parseInt(data.cacheCreateTokens || 0)
        const cacheReadTokens = parseInt(data.cacheReadTokens || 0)
        const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
        let cost = 0
        if (data.ratedCostMicro) {
          cost = parseInt(data.ratedCostMicro) / 1000000
        }

        // Aggregate model stats
        if (!modelStatsMap[query.model]) {
          modelStatsMap[query.model] = {
            model: query.model,
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 0,
            cost: 0
          }
        }
        const ms = modelStatsMap[query.model]
        ms.requests += requests
        ms.inputTokens += inputTokens
        ms.outputTokens += outputTokens
        ms.cacheCreateTokens += cacheCreateTokens
        ms.cacheReadTokens += cacheReadTokens
        ms.totalTokens += totalTokens
        ms.cost += cost

        // Aggregate daily model stats
        const dmKey = `${query.date}:${query.model}`
        if (!dailyModelMap[dmKey]) {
          dailyModelMap[dmKey] = {
            model: query.model,
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 0,
            cost: 0
          }
        }
        const dm = dailyModelMap[dmKey]
        dm.requests += requests
        dm.inputTokens += inputTokens
        dm.outputTokens += outputTokens
        dm.cacheCreateTokens += cacheCreateTokens
        dm.cacheReadTokens += cacheReadTokens
        dm.totalTokens += totalTokens
        dm.cost += cost
      }
    }
  })

  // Calculate daily totalTokens
  for (const day of Object.values(dailyMap)) {
    day.totalTokens =
      day.inputTokens + day.outputTokens + day.cacheCreateTokens + day.cacheReadTokens
  }

  // Build dailyUsage
  const dailyUsage = Object.values(dailyMap)
    .filter((day) => day.requests > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((day) => {
      const dayModels = Object.entries(dailyModelMap)
        .filter(([key]) => key.startsWith(`${day.date}:`))
        .map(([, m]) => ({
          model: m.model,
          requests: m.requests,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cacheCreateTokens: m.cacheCreateTokens,
          cacheReadTokens: m.cacheReadTokens,
          totalTokens: m.totalTokens,
          cost: parseFloat(m.cost.toFixed(6))
        }))
        .sort((a, b) => b.requests - a.requests)

      return {
        date: day.date,
        requests: day.requests,
        inputTokens: day.inputTokens,
        outputTokens: day.outputTokens,
        cacheCreateTokens: day.cacheCreateTokens,
        cacheReadTokens: day.cacheReadTokens,
        totalTokens: day.totalTokens,
        cost: parseFloat(day.cost.toFixed(6)),
        models: dayModels
      }
    })

  // Build modelStats
  const modelStats = Object.values(modelStatsMap)
    .sort((a, b) => b.requests - a.requests)
    .map((m) => ({
      model: m.model,
      requests: m.requests,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheCreateTokens: m.cacheCreateTokens,
      cacheReadTokens: m.cacheReadTokens,
      totalTokens: m.totalTokens,
      cost: parseFloat(m.cost.toFixed(6))
    }))

  // Calculate totalStats
  const totalStats = {
    requests: dailyUsage.reduce((sum, day) => sum + day.requests, 0),
    inputTokens: dailyUsage.reduce((sum, day) => sum + day.inputTokens, 0),
    outputTokens: dailyUsage.reduce((sum, day) => sum + day.outputTokens, 0),
    cacheCreateTokens: dailyUsage.reduce((sum, day) => sum + day.cacheCreateTokens, 0),
    cacheReadTokens: dailyUsage.reduce((sum, day) => sum + day.cacheReadTokens, 0),
    totalTokens: dailyUsage.reduce((sum, day) => sum + day.totalTokens, 0),
    cost: parseFloat(dailyUsage.reduce((sum, day) => sum + day.cost, 0).toFixed(6))
  }

  return {
    keyId: apiKey.id,
    keyName: apiKey.name,
    period: 'last_30_days',
    totalStats,
    dailyUsage,
    modelStats
  }
}

router.post('/api-key/usage', authenticatePartner, async (req, res) => {
  try {
    const { key_ids } = req.body

    if (!key_ids || !Array.isArray(key_ids)) {
      return res.status(400).json({
        code: 1001,
        msg: 'key_ids is required and must be an array',
        data: null
      })
    }

    if (key_ids.length > 100) {
      return res.status(400).json({
        code: 1001,
        msg: 'key_ids length cannot exceed 100',
        data: null
      })
    }

    logger.info(`📊 Partner usage query: count=${key_ids.length}`)
    const results = {}
    for (const id of key_ids) {
      const apiKey = await findApiKey(id, null)
      if (apiKey) {
        const summary = await getUsageSummary(apiKey)
        results[apiKey.id] = summary
      }
    }

    return res.json({
      code: 0,
      msg: 'success',
      data: results
    })
  } catch (error) {
    logger.error('❌ Partner usage query error:', error)
    return res.status(500).json({
      code: 1003,
      msg: error.message || 'Internal server error',
      data: null
    })
  }
})

// 📊 查询 API Key 用量明细（近30天）
router.post('/api-key/usage-details', authenticatePartner, async (req, res) => {
  try {
    const { key_ids } = req.body

    if (!key_ids || !Array.isArray(key_ids)) {
      return res.status(400).json({
        code: 1001,
        msg: 'key_ids is required and must be an array',
        data: null
      })
    }

    if (key_ids.length > 100) {
      return res.status(400).json({
        code: 1001,
        msg: 'key_ids length cannot exceed 100',
        data: null
      })
    }

    logger.info(`📊 Partner usage details query: count=${key_ids.length}`)
    const results = []
    for (const id of key_ids) {
      const apiKey = await findApiKey(id, null)
      if (apiKey) {
        const details = await getUsageDetails(apiKey)
        results.push(details)
      }
    }

    // 聚合数据
    const aggregated = {
      keyId: 'aggregated',
      keyName: 'Aggregated View',
      period: 'last_30_days',
      totalStats: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        cost: 0
      },
      dailyUsage: [],
      modelStats: []
    }

    const dailyMap = {} // date -> { stats..., models: { modelName -> stats } }
    const modelMap = {} // modelName -> stats

    for (const result of results) {
      // 1. 聚合总统计
      aggregated.totalStats.requests += result.totalStats.requests
      aggregated.totalStats.inputTokens += result.totalStats.inputTokens
      aggregated.totalStats.outputTokens += result.totalStats.outputTokens
      aggregated.totalStats.cacheCreateTokens += result.totalStats.cacheCreateTokens
      aggregated.totalStats.cacheReadTokens += result.totalStats.cacheReadTokens
      aggregated.totalStats.totalTokens += result.totalStats.totalTokens
      aggregated.totalStats.cost += result.totalStats.cost

      // 2. 聚合模型统计
      for (const mStat of result.modelStats) {
        if (!modelMap[mStat.model]) {
          modelMap[mStat.model] = { ...mStat }
        } else {
          const exist = modelMap[mStat.model]
          exist.requests += mStat.requests
          exist.inputTokens += mStat.inputTokens
          exist.outputTokens += mStat.outputTokens
          exist.cacheCreateTokens += mStat.cacheCreateTokens
          exist.cacheReadTokens += mStat.cacheReadTokens
          exist.totalTokens += mStat.totalTokens
          exist.cost += mStat.cost
        }
      }

      // 3. 聚合每日用量
      for (const dayStat of result.dailyUsage) {
        if (!dailyMap[dayStat.date]) {
          dailyMap[dayStat.date] = {
            date: dayStat.date,
            requests: dayStat.requests,
            inputTokens: dayStat.inputTokens,
            outputTokens: dayStat.outputTokens,
            cacheCreateTokens: dayStat.cacheCreateTokens,
            cacheReadTokens: dayStat.cacheReadTokens,
            totalTokens: dayStat.totalTokens,
            cost: dayStat.cost,
            models: {}
          }
          // 初始化当日模型
          for (const m of dayStat.models) {
            dailyMap[dayStat.date].models[m.model] = { ...m }
          }
        } else {
          const exist = dailyMap[dayStat.date]
          exist.requests += dayStat.requests
          exist.inputTokens += dayStat.inputTokens
          exist.outputTokens += dayStat.outputTokens
          exist.cacheCreateTokens += dayStat.cacheCreateTokens
          exist.cacheReadTokens += dayStat.cacheReadTokens
          exist.totalTokens += dayStat.totalTokens
          exist.cost += dayStat.cost

          // 合并当日模型数据
          for (const m of dayStat.models) {
            if (!exist.models[m.model]) {
              exist.models[m.model] = { ...m }
            } else {
              const eModel = exist.models[m.model]
              eModel.requests += m.requests
              eModel.inputTokens += m.inputTokens
              eModel.outputTokens += m.outputTokens
              eModel.cacheCreateTokens += m.cacheCreateTokens
              eModel.cacheReadTokens += m.cacheReadTokens
              eModel.totalTokens += m.totalTokens
              eModel.cost += m.cost
            }
          }
        }
      }
    }

    // 4. 格式化输出 - Daily Usage
    aggregated.dailyUsage = Object.values(dailyMap)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((day) => {
        const models = Object.values(day.models)
          .sort((a, b) => b.requests - a.requests)
          .map((m) => ({
            ...m,
            cost: parseFloat(m.cost.toFixed(6))
          }))
        return {
          date: day.date,
          requests: day.requests,
          inputTokens: day.inputTokens,
          outputTokens: day.outputTokens,
          cacheCreateTokens: day.cacheCreateTokens,
          cacheReadTokens: day.cacheReadTokens,
          totalTokens: day.totalTokens,
          cost: parseFloat(day.cost.toFixed(6)),
          models
        }
      })

    // 5. 格式化输出 - Model Stats
    aggregated.modelStats = Object.values(modelMap)
      .sort((a, b) => b.requests - a.requests)
      .map((m) => ({
        ...m,
        cost: parseFloat(m.cost.toFixed(6))
      }))

    // 6. 修正总费用精度
    aggregated.totalStats.cost = parseFloat(aggregated.totalStats.cost.toFixed(6))

    return res.json({
      code: 0,
      msg: 'success',
      data: aggregated
    })
  } catch (error) {
    logger.error('❌ Partner usage details query error:', error)
    return res.status(500).json({
      code: 1003,
      msg: error.message || 'Internal server error',
      data: null
    })
  }
})

// 🔍 查询 API Key 详情（支持批量）
router.post('/api-key/detail', authenticatePartner, async (req, res) => {
  try {
    const { key_ids } = req.body

    if (!key_ids || !Array.isArray(key_ids)) {
      return res.status(400).json({
        code: 1001,
        msg: 'key_ids is required and must be an array',
        data: null
      })
    }

    if (key_ids.length > 100) {
      return res.status(400).json({
        code: 1001,
        msg: 'key_ids length cannot exceed 100',
        data: null
      })
    }

    logger.info(`🔍 Partner detail query: count=${key_ids.length}`)

    const results = {}
    for (const id of key_ids) {
      const apiKey = await findApiKey(id, null)
      if (!apiKey) {
        continue
      }

      let permissions = []
      try {
        permissions = apiKey.permissions ? JSON.parse(apiKey.permissions) : []
        if (!Array.isArray(permissions)) {
          permissions = []
        }
      } catch (_e) {
        permissions = []
      }

      let rateLimits = []
      try {
        rateLimits = apiKey.rateLimits ? JSON.parse(apiKey.rateLimits) : []
      } catch (_e) {
        rateLimits = []
      }

      let tags = []
      try {
        tags = apiKey.tags ? JSON.parse(apiKey.tags) : []
      } catch (_e) {
        tags = []
      }

      let serviceRates = {}
      try {
        serviceRates = apiKey.serviceRates ? JSON.parse(apiKey.serviceRates) : {}
      } catch (_e) {
        serviceRates = {}
      }

      let accountBindings = {}
      try {
        accountBindings = apiKey.accountBindings ? JSON.parse(apiKey.accountBindings) : {}
      } catch (_e) {
        accountBindings = {}
      }

      let memberUids = []
      try {
        memberUids = apiKey.memberUids ? JSON.parse(apiKey.memberUids) : []
      } catch (_e) {
        memberUids = []
      }

      results[apiKey.id] = {
        keyId: apiKey.id,
        keyName: apiKey.name,
        description: apiKey.description || '',
        isActive: apiKey.isActive === 'true',
        expiresAt: apiKey.expiresAt || null,
        expirationMode: apiKey.expirationMode || 'fixed',
        isActivated: apiKey.isActivated === 'true',
        activationDays: parseInt(apiKey.activationDays || 0),
        activationUnit: apiKey.activationUnit || 'days',
        activatedAt: apiKey.activatedAt || null,
        createdAt: apiKey.createdAt || null,
        lastUsedAt: apiKey.lastUsedAt || null,
        permissions,
        rateLimits,
        totalCostLimit: parseFloat(apiKey.totalCostLimit || 0),
        dailyCostLimit: parseFloat(apiKey.dailyCostLimit || 0),
        serviceRates,
        tags,
        claudeAccountId: apiKey.claudeAccountId || null,
        claudeConsoleAccountId: apiKey.claudeConsoleAccountId || null,
        openaiAccountId: apiKey.openaiAccountId || null,
        geminiAccountId: apiKey.geminiAccountId || null,
        accountBindings,
        externalUid: apiKey.externalUid || null,
        packMode: apiKey.packMode || 'personal',
        memberUids
      }
    }

    return res.json({
      code: 0,
      msg: 'success',
      data: results
    })
  } catch (error) {
    logger.error('❌ Partner detail query error:', error)
    return res.status(500).json({
      code: 1003,
      msg: error.message || 'Internal server error',
      data: null
    })
  }
})

// 🔑 创建 API Key
router.post('/api-key/create', authenticatePartner, async (req, res) => {
  try {
    const {
      name,
      totalCostLimit,
      claude_account_id,
      openai_account_id,
      deepseek_account_id,
      minimax_account_id,
      glm_account_id,
      kimi_account_id,
      claude_rate,
      openai_rate,
      deepseek_rate,
      minimax_rate,
      glm_rate,
      kimi_rate,
      rate,
      rateLimits,
      expiresAt,
      expirationMode,
      activationDays,
      activationUnit,
      user_id,
      pack_consent
    } = req.body

    const resolvedClaudeRate = resolveClaudeRate(claude_rate, rate)

    // 参数验证
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        code: 1001,
        msg: 'name is required and must be a non-empty string',
        data: null
      })
    }

    if (name.length > 100) {
      return res.status(400).json({
        code: 1001,
        msg: 'name must be less than 100 characters',
        data: null
      })
    }

    if (
      totalCostLimit !== undefined &&
      totalCostLimit !== null &&
      totalCostLimit !== '' &&
      (Number.isNaN(Number(totalCostLimit)) || Number(totalCostLimit) < 0)
    ) {
      return res.status(400).json({
        code: 1001,
        msg: 'totalCostLimit must be a non-negative number',
        data: null
      })
    }

    if (expirationMode && !['fixed', 'activation'].includes(expirationMode)) {
      return res.status(400).json({
        code: 1001,
        msg: 'expirationMode must be either "fixed" or "activation"',
        data: null
      })
    }

    if (expirationMode === 'activation') {
      if (!activationUnit || !['hours', 'days'].includes(activationUnit)) {
        return res.status(400).json({
          code: 1001,
          msg: 'activationUnit must be either "hours" or "days" when using activation mode',
          data: null
        })
      }

      if (
        !activationDays ||
        !Number.isInteger(Number(activationDays)) ||
        Number(activationDays) < 1
      ) {
        const unitText = activationUnit === 'hours' ? 'hours' : 'days'
        return res.status(400).json({
          code: 1001,
          msg: `activation ${unitText} must be a positive integer when using activation mode`,
          data: null
        })
      }

      if (expiresAt) {
        return res.status(400).json({
          code: 1001,
          msg: 'cannot set fixed expiration date when using activation mode',
          data: null
        })
      }
    }

    if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
      return res.status(400).json({
        code: 1001,
        msg: 'invalid expiration date format',
        data: null
      })
    }

    const claudeRateError = validateRate(resolvedClaudeRate, 'claude_rate')
    if (claudeRateError) {
      return res.status(400).json({
        code: 1001,
        msg: claudeRateError,
        data: null
      })
    }

    const openaiRateError = validateRate(openai_rate, 'openai_rate')
    if (openaiRateError) {
      return res.status(400).json({
        code: 1001,
        msg: openaiRateError,
        data: null
      })
    }

    const deepseekRateError = validateRate(deepseek_rate, 'deepseek_rate')
    if (deepseekRateError) {
      return res.status(400).json({
        code: 1001,
        msg: deepseekRateError,
        data: null
      })
    }

    const minimaxRateError = validateRate(minimax_rate, 'minimax_rate')
    if (minimaxRateError) {
      return res.status(400).json({
        code: 1001,
        msg: minimaxRateError,
        data: null
      })
    }

    const glmRateError = validateRate(glm_rate, 'glm_rate')
    if (glmRateError) {
      return res.status(400).json({
        code: 1001,
        msg: glmRateError,
        data: null
      })
    }

    const kimiRateError = validateRate(kimi_rate, 'kimi_rate')
    if (kimiRateError) {
      return res.status(400).json({
        code: 1001,
        msg: kimiRateError,
        data: null
      })
    }

    if (rateLimits !== undefined && rateLimits !== null && rateLimits !== '') {
      if (!Array.isArray(rateLimits)) {
        return res.status(400).json({
          code: 1001,
          msg: 'rateLimits must be an array',
          data: null
        })
      }
      for (let i = 0; i < rateLimits.length; i++) {
        const rule = rateLimits[i]
        if (!rule || typeof rule !== 'object') {
          return res.status(400).json({
            code: 1001,
            msg: `rateLimits[${i}] must be an object`,
            data: null
          })
        }
        if (!Number.isInteger(rule.window) || rule.window <= 0) {
          return res.status(400).json({
            code: 1001,
            msg: `rateLimits[${i}].window must be a positive integer (minutes)`,
            data: null
          })
        }
        if (rule.requests === undefined && rule.cost === undefined) {
          return res.status(400).json({
            code: 1001,
            msg: `rateLimits[${i}] must have at least one of: requests, cost`,
            data: null
          })
        }
        if (
          rule.requests !== undefined &&
          (!Number.isInteger(rule.requests) || rule.requests <= 0)
        ) {
          return res.status(400).json({
            code: 1001,
            msg: `rateLimits[${i}].requests must be a positive integer`,
            data: null
          })
        }
        if (rule.cost !== undefined && (Number.isNaN(Number(rule.cost)) || Number(rule.cost) < 0)) {
          return res.status(400).json({
            code: 1001,
            msg: `rateLimits[${i}].cost must be a non-negative number`,
            data: null
          })
        }
      }
    }

    logger.info(`🔑 Partner creating API Key: name=${name}`)

    // 确定使用的 Claude 账户 ID
    const targetAccountId = claude_account_id || config.partnerApi.defaultClaudeAccountId

    if (!targetAccountId) {
      logger.warn('❌ Partner default Claude account ID not configured')
      return res.status(500).json({
        code: 1003,
        msg: 'Partner default Claude account ID not configured. Please set PARTNER_DEFAULT_CLAUDE_ACCOUNT_ID environment variable.',
        data: null
      })
    }

    let claudeBindingFields
    try {
      claudeBindingFields = await resolveClaudeBindingFields(targetAccountId)
    } catch (error) {
      return res.status(400).json({
        code: 1001,
        msg: error.message,
        data: null
      })
    }

    if (openai_account_id && !(await validateOpenAIBinding(openai_account_id))) {
      return res.status(400).json({
        code: 1001,
        msg: 'OpenAI account not found or inactive',
        data: null
      })
    }

    let deepseekBinding = null
    if (deepseek_account_id) {
      try {
        deepseekBinding = await resolveDeepSeekBinding(deepseek_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    let minimaxBinding = null
    if (minimax_account_id) {
      try {
        minimaxBinding = await resolveMiniMaxBinding(minimax_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    let glmBinding = null
    if (glm_account_id) {
      try {
        glmBinding = await resolveGlmBinding(glm_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    let kimiBinding = null
    if (kimi_account_id) {
      try {
        kimiBinding = await resolveKimiBinding(kimi_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    const createServiceRates = buildServiceRates(
      {},
      resolvedClaudeRate,
      openai_rate,
      deepseek_rate,
      minimax_rate,
      glm_rate,
      kimi_rate
    )

    const permissions = ['claude']
    if (openai_account_id) {
      permissions.push('openai')
    }
    if (deepseek_account_id) {
      permissions.push('deepseek')
    }
    if (minimax_account_id) {
      permissions.push('minimax')
    }
    if (glm_account_id) {
      permissions.push('glm')
    }
    if (kimi_account_id) {
      permissions.push('kimi')
    }

    // 准备创建参数
    const createParams = {
      name: name.trim(),
      description: 'Created by partner API',
      tags: pack_consent ? ['uni-agent', 'pack_consent'] : ['uni-agent'],
      totalCostLimit: totalCostLimit ? Number(totalCostLimit) : 0,
      ...claudeBindingFields,
      permissions,
      isActive: true
    }

    if (openai_account_id) {
      createParams.openaiAccountId = openai_account_id
    }

    if (deepseekBinding || minimaxBinding || glmBinding || kimiBinding) {
      createParams.accountBindings = buildAccountBindings(
        {},
        deepseekBinding,
        minimaxBinding,
        glmBinding,
        kimiBinding
      )
    }

    if (Object.keys(createServiceRates).length > 0) {
      createParams.serviceRates = createServiceRates
    }

    if (rateLimits && rateLimits.length > 0) {
      createParams.rateLimits = rateLimits
    }

    if (expiresAt) {
      createParams.expiresAt = new Date(expiresAt).toISOString()
    }

    if (expirationMode) {
      createParams.expirationMode = expirationMode
    }

    if (activationDays !== undefined && activationDays !== null && activationDays !== '') {
      createParams.activationDays = Number(activationDays)
    }

    if (activationUnit) {
      createParams.activationUnit = activationUnit
    }

    if (user_id) {
      createParams.externalUid = user_id
    }

    // 调用 apiKeyService 创建 API Key
    const newKey = await apiKeyService.generateApiKey(createParams)

    logger.success(`✅ Partner created API Key: ${newKey.id} (${name})`)

    // 返回响应
    return res.json({
      code: 0,
      msg: 'success',
      data: {
        keyId: newKey.id,
        keyName: newKey.name,
        apiKey: newKey.apiKey // 返回原始 API Key（仅创建时返回一次）
      }
    })
  } catch (error) {
    logger.error('❌ Partner create API Key error:', error)
    return res.status(500).json({
      code: 1003,
      msg: error.message || 'Internal server error',
      data: null
    })
  }
})

router.post('/enterprise/key/batch-create', authenticatePartner, async (req, res) => {
  try {
    const { keys } = req.body

    if (!Array.isArray(keys)) {
      return res.status(400).json({
        code: 1001,
        msg: 'keys is required and must be an array',
        data: null
      })
    }

    if (keys.length === 0 || keys.length > 100) {
      return res.status(400).json({
        code: 1001,
        msg: 'keys length must be between 1 and 100',
        data: null
      })
    }

    const results = []
    const errors = []

    for (const [index, item] of keys.entries()) {
      try {
        const {
          name,
          externalUid,
          memberUids,
          totalCostLimit,
          dailyCostLimit,
          claude_account_id,
          openai_account_id,
          deepseek_account_id,
          minimax_account_id,
          glm_account_id,
          kimi_account_id,
          claude_rate,
          openai_rate,
          deepseek_rate,
          minimax_rate,
          glm_rate,
          kimi_rate,
          rate,
          rateLimits,
          expiresAt,
          expirationMode,
          activationDays,
          activationUnit
        } = item || {}

        const resolvedClaudeRate = resolveClaudeRate(claude_rate, rate)
        const normalizedMemberUids = normalizeMemberUids(memberUids)

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
          throw new Error('name is required and must be a non-empty string')
        }

        if (name.length > 100) {
          throw new Error('name must be less than 100 characters')
        }

        if (!externalUid || typeof externalUid !== 'string' || externalUid.trim().length === 0) {
          throw new Error('externalUid is required')
        }

        if (
          totalCostLimit !== undefined &&
          totalCostLimit !== null &&
          totalCostLimit !== '' &&
          (Number.isNaN(Number(totalCostLimit)) || Number(totalCostLimit) < 0)
        ) {
          throw new Error('totalCostLimit must be a non-negative number')
        }

        if (
          dailyCostLimit !== undefined &&
          dailyCostLimit !== null &&
          dailyCostLimit !== '' &&
          (Number.isNaN(Number(dailyCostLimit)) || Number(dailyCostLimit) < 0)
        ) {
          throw new Error('dailyCostLimit must be a non-negative number')
        }

        if (expirationMode && !['fixed', 'activation'].includes(expirationMode)) {
          throw new Error('expirationMode must be either "fixed" or "activation"')
        }

        if (expirationMode === 'activation') {
          if (!activationUnit || !['hours', 'days'].includes(activationUnit)) {
            throw new Error(
              'activationUnit must be either "hours" or "days" when using activation mode'
            )
          }

          if (
            !activationDays ||
            !Number.isInteger(Number(activationDays)) ||
            Number(activationDays) < 1
          ) {
            const unitText = activationUnit === 'hours' ? 'hours' : 'days'
            throw new Error(
              `activation ${unitText} must be a positive integer when using activation mode`
            )
          }

          if (expiresAt) {
            throw new Error('cannot set fixed expiration date when using activation mode')
          }
        }

        if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
          throw new Error('invalid expiration date format')
        }

        const claudeRateError = validateRate(resolvedClaudeRate, 'claude_rate')
        if (claudeRateError) {
          throw new Error(claudeRateError)
        }

        const openaiRateError = validateRate(openai_rate, 'openai_rate')
        if (openaiRateError) {
          throw new Error(openaiRateError)
        }

        const deepseekRateError = validateRate(deepseek_rate, 'deepseek_rate')
        if (deepseekRateError) {
          throw new Error(deepseekRateError)
        }

        const minimaxRateError = validateRate(minimax_rate, 'minimax_rate')
        if (minimaxRateError) {
          throw new Error(minimaxRateError)
        }

        const glmRateError = validateRate(glm_rate, 'glm_rate')
        if (glmRateError) {
          throw new Error(glmRateError)
        }

        const kimiRateError = validateRate(kimi_rate, 'kimi_rate')
        if (kimiRateError) {
          throw new Error(kimiRateError)
        }

        if (rateLimits !== undefined && rateLimits !== null && rateLimits !== '') {
          if (!Array.isArray(rateLimits)) {
            throw new Error('rateLimits must be an array')
          }

          for (let rateLimitIndex = 0; rateLimitIndex < rateLimits.length; rateLimitIndex++) {
            const rule = rateLimits[rateLimitIndex]
            if (!rule || typeof rule !== 'object') {
              throw new Error(`rateLimits[${rateLimitIndex}] must be an object`)
            }
            if (!Number.isInteger(rule.window) || rule.window <= 0) {
              throw new Error(
                `rateLimits[${rateLimitIndex}].window must be a positive integer (minutes)`
              )
            }
            if (rule.requests === undefined && rule.cost === undefined) {
              throw new Error(
                `rateLimits[${rateLimitIndex}] must have at least one of: requests, cost`
              )
            }
            if (
              rule.requests !== undefined &&
              (!Number.isInteger(rule.requests) || rule.requests <= 0)
            ) {
              throw new Error(`rateLimits[${rateLimitIndex}].requests must be a positive integer`)
            }
            if (
              rule.cost !== undefined &&
              (Number.isNaN(Number(rule.cost)) || Number(rule.cost) < 0)
            ) {
              throw new Error(`rateLimits[${rateLimitIndex}].cost must be a non-negative number`)
            }
          }
        }

        const targetAccountId = claude_account_id || config.partnerApi.defaultClaudeAccountId
        if (!targetAccountId) {
          throw new Error(
            'Partner default Claude account ID not configured. Please set PARTNER_DEFAULT_CLAUDE_ACCOUNT_ID environment variable.'
          )
        }

        const claudeBindingFields = await resolveClaudeBindingFields(targetAccountId)

        if (openai_account_id && !(await validateOpenAIBinding(openai_account_id))) {
          throw new Error('OpenAI account not found or inactive')
        }

        let deepseekBinding = null
        if (deepseek_account_id) {
          deepseekBinding = await resolveDeepSeekBinding(deepseek_account_id)
        }

        let minimaxBinding = null
        if (minimax_account_id) {
          minimaxBinding = await resolveMiniMaxBinding(minimax_account_id)
        }

        let glmBinding = null
        if (glm_account_id) {
          glmBinding = await resolveGlmBinding(glm_account_id)
        }

        let kimiBinding = null
        if (kimi_account_id) {
          kimiBinding = await resolveKimiBinding(kimi_account_id)
        }

        const createServiceRates = buildServiceRates(
          {},
          resolvedClaudeRate,
          openai_rate,
          deepseek_rate,
          minimax_rate,
          glm_rate,
          kimi_rate
        )

        const permissions = ['claude']
        if (openai_account_id) {
          permissions.push('openai')
        }
        if (deepseek_account_id) {
          permissions.push('deepseek')
        }
        if (minimax_account_id) {
          permissions.push('minimax')
        }
        if (glm_account_id) {
          permissions.push('glm')
        }
        if (kimi_account_id) {
          permissions.push('kimi')
        }

        const createParams = {
          name: name.trim(),
          description: 'Created by partner enterprise API',
          tags: ['uni-agent'],
          totalCostLimit: totalCostLimit ? Number(totalCostLimit) : 0,
          dailyCostLimit: dailyCostLimit ? Number(dailyCostLimit) : 0,
          ...claudeBindingFields,
          permissions,
          isActive: true,
          externalUid: externalUid.trim(),
          packMode: 'enterprise',
          memberUids: normalizedMemberUids
        }

        if (openai_account_id) {
          createParams.openaiAccountId = openai_account_id
        }

        if (deepseekBinding || minimaxBinding || glmBinding || kimiBinding) {
          createParams.accountBindings = buildAccountBindings(
            {},
            deepseekBinding,
            minimaxBinding,
            glmBinding,
            kimiBinding
          )
        }

        if (Object.keys(createServiceRates).length > 0) {
          createParams.serviceRates = createServiceRates
        }

        if (rateLimits && rateLimits.length > 0) {
          createParams.rateLimits = rateLimits
        }

        if (expiresAt) {
          createParams.expiresAt = new Date(expiresAt).toISOString()
        }

        if (expirationMode) {
          createParams.expirationMode = expirationMode
        }

        if (activationDays !== undefined && activationDays !== null && activationDays !== '') {
          createParams.activationDays = Number(activationDays)
        }

        if (activationUnit) {
          createParams.activationUnit = activationUnit
        }

        const newKey = await apiKeyService.generateApiKey(createParams)

        results.push({
          keyId: newKey.id,
          keyName: newKey.name,
          apiKey: newKey.apiKey,
          memberUids: normalizedMemberUids
        })
      } catch (error) {
        errors.push({
          index,
          name: item?.name || '',
          msg: error.message || 'Unknown error'
        })
      }
    }

    return res.json({
      code: 0,
      msg: 'success',
      data: {
        total: keys.length,
        created: results.length,
        failed: errors.length,
        keys: results,
        errors
      }
    })
  } catch (error) {
    logger.error('❌ Partner enterprise batch create error:', error)
    return res.status(500).json({
      code: 1003,
      msg: error.message || 'Internal server error',
      data: null
    })
  }
})

router.post('/enterprise/key/members/set', authenticatePartner, async (req, res) => {
  try {
    const { keyId, memberUids } = req.body

    if (!keyId || typeof keyId !== 'string') {
      return res.status(400).json({
        code: 1001,
        msg: 'keyId is required',
        data: null
      })
    }

    if (!Array.isArray(memberUids)) {
      return res.status(400).json({
        code: 1001,
        msg: 'memberUids is required and must be an array',
        data: null
      })
    }

    const keyData = await findApiKey(keyId, null)
    if (!keyData) {
      return res.status(404).json({
        code: 1003,
        msg: 'Key not found',
        data: null
      })
    }

    if ((keyData.packMode || 'personal') !== 'enterprise') {
      return res.status(400).json({
        code: 1004,
        msg: 'Key is not enterprise edition',
        data: null
      })
    }

    const normalizedMemberUids = normalizeMemberUids(memberUids)
    await apiKeyService.updateApiKey(keyId, { memberUids: normalizedMemberUids })

    return res.json({
      code: 0,
      msg: 'success',
      data: {
        keyId,
        memberUids: normalizedMemberUids
      }
    })
  } catch (error) {
    logger.error('❌ Partner enterprise set members error:', error)
    return res.status(500).json({
      code: 1003,
      msg: error.message || 'Internal server error',
      data: null
    })
  }
})

// 🔄 更新 API Key
router.post('/api-key/:keyId/update', authenticatePartner, async (req, res) => {
  try {
    const { keyId } = req.params
    const {
      name,
      totalCostLimit,
      claude_account_id,
      openai_account_id,
      deepseek_account_id,
      minimax_account_id,
      glm_account_id,
      kimi_account_id,
      claude_rate,
      openai_rate,
      deepseek_rate,
      minimax_rate,
      glm_rate,
      kimi_rate,
      rate,
      rateLimits,
      expiresAt,
      expirationMode,
      activationDays,
      activationUnit,
      user_id,
      pack_consent,
      reset_window
    } = req.body

    const keyData = await findApiKey(keyId, null)
    if (!keyData) {
      return res.status(404).json({
        code: 1004,
        msg: 'API Key not found',
        data: null
      })
    }

    const resolvedClaudeRate = resolveClaudeRate(claude_rate, rate)

    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      return res.status(400).json({
        code: 1001,
        msg: 'name must be a non-empty string',
        data: null
      })
    }

    if (name && name.length > 100) {
      return res.status(400).json({
        code: 1001,
        msg: 'name must be less than 100 characters',
        data: null
      })
    }

    if (
      totalCostLimit !== undefined &&
      totalCostLimit !== null &&
      totalCostLimit !== '' &&
      (Number.isNaN(Number(totalCostLimit)) || Number(totalCostLimit) < 0)
    ) {
      return res.status(400).json({
        code: 1001,
        msg: 'totalCostLimit must be a non-negative number',
        data: null
      })
    }

    if (expirationMode && !['fixed', 'activation'].includes(expirationMode)) {
      return res.status(400).json({
        code: 1001,
        msg: 'expirationMode must be either "fixed" or "activation"',
        data: null
      })
    }

    if (expirationMode === 'activation') {
      if (!activationUnit || !['hours', 'days'].includes(activationUnit)) {
        return res.status(400).json({
          code: 1001,
          msg: 'activationUnit must be either "hours" or "days" when using activation mode',
          data: null
        })
      }

      if (
        !activationDays ||
        !Number.isInteger(Number(activationDays)) ||
        Number(activationDays) < 1
      ) {
        const unitText = activationUnit === 'hours' ? 'hours' : 'days'
        return res.status(400).json({
          code: 1001,
          msg: `activation ${unitText} must be a positive integer when using activation mode`,
          data: null
        })
      }

      if (expiresAt) {
        return res.status(400).json({
          code: 1001,
          msg: 'cannot set fixed expiration date when using activation mode',
          data: null
        })
      }
    }

    if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
      return res.status(400).json({
        code: 1001,
        msg: 'invalid expiration date format',
        data: null
      })
    }

    const claudeRateError = validateRate(resolvedClaudeRate, 'claude_rate')
    if (claudeRateError) {
      return res.status(400).json({
        code: 1001,
        msg: claudeRateError,
        data: null
      })
    }

    const openaiRateError = validateRate(openai_rate, 'openai_rate')
    if (openaiRateError) {
      return res.status(400).json({
        code: 1001,
        msg: openaiRateError,
        data: null
      })
    }

    const deepseekRateError = validateRate(deepseek_rate, 'deepseek_rate')
    if (deepseekRateError) {
      return res.status(400).json({
        code: 1001,
        msg: deepseekRateError,
        data: null
      })
    }

    if (rateLimits !== undefined && rateLimits !== null && rateLimits !== '') {
      if (!Array.isArray(rateLimits)) {
        return res.status(400).json({
          code: 1001,
          msg: 'rateLimits must be an array',
          data: null
        })
      }
      for (let i = 0; i < rateLimits.length; i++) {
        const rule = rateLimits[i]
        if (!rule || typeof rule !== 'object') {
          return res.status(400).json({
            code: 1001,
            msg: `rateLimits[${i}] must be an object`,
            data: null
          })
        }
        if (!Number.isInteger(rule.window) || rule.window <= 0) {
          return res.status(400).json({
            code: 1001,
            msg: `rateLimits[${i}].window must be a positive integer (minutes)`,
            data: null
          })
        }
        if (rule.requests === undefined && rule.cost === undefined) {
          return res.status(400).json({
            code: 1001,
            msg: `rateLimits[${i}] must have at least one of: requests, cost`,
            data: null
          })
        }
        if (
          rule.requests !== undefined &&
          (!Number.isInteger(rule.requests) || rule.requests <= 0)
        ) {
          return res.status(400).json({
            code: 1001,
            msg: `rateLimits[${i}].requests must be a positive integer`,
            data: null
          })
        }
        if (rule.cost !== undefined && (Number.isNaN(Number(rule.cost)) || Number(rule.cost) < 0)) {
          return res.status(400).json({
            code: 1001,
            msg: `rateLimits[${i}].cost must be a non-negative number`,
            data: null
          })
        }
      }
    }

    const minimaxRateError = validateRate(minimax_rate, 'minimax_rate')
    if (minimaxRateError) {
      return res.status(400).json({
        code: 1001,
        msg: minimaxRateError,
        data: null
      })
    }

    const glmRateError = validateRate(glm_rate, 'glm_rate')
    if (glmRateError) {
      return res.status(400).json({
        code: 1001,
        msg: glmRateError,
        data: null
      })
    }

    const kimiRateError = validateRate(kimi_rate, 'kimi_rate')
    if (kimiRateError) {
      return res.status(400).json({
        code: 1001,
        msg: kimiRateError,
        data: null
      })
    }

    logger.info(`🔄 Partner updating API Key: ${keyId} (${keyData.name})`)

    const updates = {}

    if (name !== undefined) {
      updates.name = name.trim()
    }

    if (totalCostLimit !== undefined && totalCostLimit !== null && totalCostLimit !== '') {
      updates.totalCostLimit = Number(totalCostLimit)
    }

    if (claude_account_id) {
      try {
        const claudeBindingFields = await resolveClaudeBindingFields(claude_account_id)
        Object.assign(updates, claudeBindingFields)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    if (openai_account_id && !(await validateOpenAIBinding(openai_account_id))) {
      return res.status(400).json({
        code: 1001,
        msg: 'OpenAI account not found or inactive',
        data: null
      })
    }

    if (openai_account_id) {
      updates.openaiAccountId = openai_account_id
    }

    let deepseekBinding = null
    if (deepseek_account_id) {
      try {
        deepseekBinding = await resolveDeepSeekBinding(deepseek_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    let minimaxBinding = null
    if (minimax_account_id) {
      try {
        minimaxBinding = await resolveMiniMaxBinding(minimax_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    let glmBinding = null
    if (glm_account_id) {
      try {
        glmBinding = await resolveGlmBinding(glm_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    let kimiBinding = null
    if (kimi_account_id) {
      try {
        kimiBinding = await resolveKimiBinding(kimi_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    if (deepseekBinding || minimaxBinding || glmBinding || kimiBinding) {
      updates.accountBindings = buildAccountBindings(
        keyData.accountBindings || {},
        deepseekBinding,
        minimaxBinding,
        glmBinding,
        kimiBinding
      )
    }

    if (
      resolvedClaudeRate !== undefined ||
      openai_rate !== undefined ||
      deepseek_rate !== undefined ||
      minimax_rate !== undefined ||
      glm_rate !== undefined ||
      kimi_rate !== undefined
    ) {
      const serviceRates = buildServiceRates(
        keyData.serviceRates || {},
        resolvedClaudeRate,
        openai_rate,
        deepseek_rate,
        minimax_rate,
        glm_rate,
        kimi_rate
      )
      if (Object.keys(serviceRates).length > 0) {
        updates.serviceRates = serviceRates
      }
    }

    if (
      claude_account_id ||
      openai_account_id ||
      deepseek_account_id ||
      minimax_account_id ||
      glm_account_id ||
      kimi_account_id
    ) {
      const permissions = new Set(normalizePermissionList(keyData.permissions))
      permissions.add('claude')
      if (openai_account_id) {
        permissions.add('openai')
      }
      if (deepseek_account_id) {
        permissions.add('deepseek')
      }
      if (minimax_account_id) {
        permissions.add('minimax')
      }
      if (glm_account_id) {
        permissions.add('glm')
      }
      if (kimi_account_id) {
        permissions.add('kimi')
      }
      updates.permissions = Array.from(permissions)
    }

    if (rateLimits !== undefined && rateLimits !== null && rateLimits !== '') {
      updates.rateLimits = rateLimits
    }

    if (expiresAt !== undefined) {
      if (expiresAt) {
        updates.expiresAt = new Date(expiresAt).toISOString()
        updates.isActive = new Date(expiresAt) > new Date()
        if (keyData.isActivated !== 'true') {
          updates.isActivated = 'true'
          updates.activatedAt = new Date().toISOString()
        }
      } else {
        updates.expiresAt = ''
      }
    }

    if (expirationMode !== undefined) {
      updates.expirationMode = expirationMode
    }

    if (activationDays !== undefined && activationDays !== null && activationDays !== '') {
      updates.activationDays = Number(activationDays)
    }

    if (activationUnit !== undefined) {
      updates.activationUnit = activationUnit
    }

    if (user_id !== undefined) {
      updates.externalUid = user_id || ''
    }

    if (pack_consent !== undefined) {
      const currentTags = keyData.tags ? JSON.parse(keyData.tags) : []
      const hasPackConsent = currentTags.includes('pack_consent')

      if (pack_consent && !hasPackConsent) {
        currentTags.push('pack_consent')
        updates.tags = JSON.stringify(currentTags)
      } else if (!pack_consent && hasPackConsent) {
        const index = currentTags.indexOf('pack_consent')
        currentTags.splice(index, 1)
        updates.tags = JSON.stringify(currentTags)
      }
    }

    if (reset_window !== undefined && reset_window !== 1 && reset_window !== 2) {
      return res.status(400).json({
        code: 1001,
        msg: 'reset_window must be 1 (reset) or 2 (no reset)',
        data: null
      })
    }

    const hasResetWindow = reset_window === 1

    if (Object.keys(updates).length === 0 && !hasResetWindow) {
      return res.status(400).json({
        code: 1001,
        msg: 'No valid updates provided',
        data: null
      })
    }

    if (Object.keys(updates).length > 0) {
      await apiKeyService.updateApiKey(keyId, updates)
    }

    if (hasResetWindow) {
      const effectiveRateLimits = parseRateLimits(
        updates.rateLimits !== undefined ? updates.rateLimits : keyData.rateLimits
      )
      if (effectiveRateLimits.length > 0) {
        await apiKeyService.initializeRateLimitWindows(keyId, effectiveRateLimits)
      }
      logger.info(`🔄 Reset window limits for API Key: ${keyId}`)
    }

    logger.success(`✅ Partner updated API Key: ${keyId} (${keyData.name})`)

    return res.json({
      code: 0,
      msg: 'success',
      data: {
        keyId,
        keyName: updates.name || keyData.name
      }
    })
  } catch (error) {
    logger.error('❌ Partner update API Key error:', error)
    return res.status(500).json({
      code: 1003,
      msg: error.message || 'Internal server error',
      data: null
    })
  }
})

// ⏰ 更新 API Key 过期时间（支持手动激活）
router.post('/api-key/:keyId/expiration', authenticatePartner, async (req, res) => {
  try {
    const { keyId } = req.params
    const { expiresAt, activateNow } = req.body

    const keyData = await findApiKey(keyId, null)
    if (!keyData) {
      return res.status(404).json({
        code: 1004,
        msg: 'API Key not found',
        data: null
      })
    }

    const updates = {}

    if (activateNow === true) {
      if (keyData.expirationMode === 'activation' && keyData.isActivated !== 'true') {
        const now = new Date()
        const activationDays = parseInt(keyData.activationDays || 30)
        const newExpiresAt = new Date(now.getTime() + activationDays * 24 * 60 * 60 * 1000)

        updates.isActivated = 'true'
        updates.activatedAt = now.toISOString()
        updates.expiresAt = newExpiresAt.toISOString()

        logger.success(
          `🔓 API key manually activated by partner: ${keyId} (${keyData.name}), expires at ${newExpiresAt.toISOString()}`
        )
      } else {
        return res.status(400).json({
          code: 1001,
          msg: 'Key is either already activated or not in activation mode',
          data: null
        })
      }
    }

    if (expiresAt !== undefined && activateNow !== true) {
      if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
        return res.status(400).json({
          code: 1001,
          msg: 'invalid expiration date format',
          data: null
        })
      }

      if (expiresAt) {
        updates.expiresAt = new Date(expiresAt).toISOString()
        if (keyData.isActivated !== 'true') {
          updates.isActivated = 'true'
          updates.activatedAt = new Date().toISOString()
        }
      } else {
        updates.expiresAt = ''
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        code: 1001,
        msg: 'No valid updates provided',
        data: null
      })
    }

    await apiKeyService.updateApiKey(keyId, updates)

    logger.success(`📝 Partner updated API key expiration: ${keyId} (${keyData.name})`)
    return res.json({
      code: 0,
      msg: 'success',
      data: {
        keyId,
        keyName: keyData.name
      }
    })
  } catch (error) {
    logger.error('❌ Partner update API key expiration error:', error)
    return res.status(500).json({
      code: 1003,
      msg: error.message || 'Internal server error',
      data: null
    })
  }
})

// 🔧 批量更新 API Key 配置
router.post('/api-key/update-config', authenticatePartner, async (req, res) => {
  try {
    const {
      configs,
      claude_account_id,
      openai_account_id,
      deepseek_account_id,
      minimax_account_id,
      glm_account_id,
      kimi_account_id
    } = req.body

    // 参数验证
    if (!configs || !Array.isArray(configs)) {
      return res.status(400).json({
        code: 1001,
        msg: 'configs is required and must be an array',
        data: null
      })
    }

    if (configs.length === 0 || configs.length > 100) {
      return res.status(400).json({
        code: 1001,
        msg: 'configs length must be between 1 and 100',
        data: null
      })
    }

    for (const [index, keyConfig] of configs.entries()) {
      if (!keyConfig.key_id || typeof keyConfig.key_id !== 'string') {
        return res.status(400).json({
          code: 1001,
          msg: `configs[${index}].key_id is required`,
          data: null
        })
      }

      const resolvedClaudeRate = resolveClaudeRate(keyConfig.claude_rate, keyConfig.rate)

      const claudeRateError = validateRate(resolvedClaudeRate, `configs[${index}].claude_rate`)
      if (claudeRateError) {
        return res.status(400).json({
          code: 1001,
          msg: claudeRateError,
          data: null
        })
      }

      const openaiRateError = validateRate(keyConfig.openai_rate, `configs[${index}].openai_rate`)
      if (openaiRateError) {
        return res.status(400).json({
          code: 1001,
          msg: openaiRateError,
          data: null
        })
      }

      const deepseekRateError = validateRate(
        keyConfig.deepseek_rate,
        `configs[${index}].deepseek_rate`
      )
      if (deepseekRateError) {
        return res.status(400).json({
          code: 1001,
          msg: deepseekRateError,
          data: null
        })
      }

      const minimaxRateError = validateRate(
        keyConfig.minimax_rate,
        `configs[${index}].minimax_rate`
      )
      if (minimaxRateError) {
        return res.status(400).json({
          code: 1001,
          msg: minimaxRateError,
          data: null
        })
      }

      const glmRateError = validateRate(keyConfig.glm_rate, `configs[${index}].glm_rate`)
      if (glmRateError) {
        return res.status(400).json({
          code: 1001,
          msg: glmRateError,
          data: null
        })
      }

      const kimiRateError = validateRate(keyConfig.kimi_rate, `configs[${index}].kimi_rate`)
      if (kimiRateError) {
        return res.status(400).json({
          code: 1001,
          msg: kimiRateError,
          data: null
        })
      }
    }

    let claudeBindingUpdates = null
    if (claude_account_id) {
      try {
        claudeBindingUpdates = await resolveClaudeBindingFields(claude_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    if (openai_account_id && !(await validateOpenAIBinding(openai_account_id))) {
      return res.status(400).json({
        code: 1001,
        msg: 'OpenAI account not found or inactive',
        data: null
      })
    }

    let deepseekBinding = null
    if (deepseek_account_id) {
      try {
        deepseekBinding = await resolveDeepSeekBinding(deepseek_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    let minimaxBinding = null
    if (minimax_account_id) {
      try {
        minimaxBinding = await resolveMiniMaxBinding(minimax_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    let glmBinding = null
    if (glm_account_id) {
      try {
        glmBinding = await resolveGlmBinding(glm_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    let kimiBinding = null
    if (kimi_account_id) {
      try {
        kimiBinding = await resolveKimiBinding(kimi_account_id)
      } catch (error) {
        return res.status(400).json({
          code: 1001,
          msg: error.message,
          data: null
        })
      }
    }

    logger.info(`🔧 Partner updating API Key configs: count=${configs.length}`)

    const failed = []
    let successCount = 0

    // 逐个更新配置
    for (const keyConfig of configs) {
      try {
        const apiKey = await findApiKey(keyConfig.key_id, null)

        if (!apiKey) {
          failed.push({
            key_id: keyConfig.key_id,
            reason: 'API Key not found'
          })
          continue
        }

        const resolvedClaudeRate = resolveClaudeRate(keyConfig.claude_rate, keyConfig.rate)

        // 准备更新数据
        const updates = {}
        const serviceRates = buildServiceRates(
          apiKey.serviceRates || {},
          resolvedClaudeRate,
          keyConfig.openai_rate,
          keyConfig.deepseek_rate,
          keyConfig.minimax_rate,
          keyConfig.glm_rate,
          keyConfig.kimi_rate
        )

        if (Object.keys(serviceRates).length > 0) {
          updates.serviceRates = serviceRates
        }

        if (claudeBindingUpdates) {
          Object.assign(updates, claudeBindingUpdates)
        }

        if (openai_account_id) {
          updates.openaiAccountId = openai_account_id
        }

        if (deepseekBinding || minimaxBinding || glmBinding || kimiBinding) {
          updates.accountBindings = buildAccountBindings(
            apiKey.accountBindings || {},
            deepseekBinding,
            minimaxBinding,
            glmBinding,
            kimiBinding
          )
        }

        if (
          claudeBindingUpdates ||
          openai_account_id ||
          deepseekBinding ||
          minimaxBinding ||
          glmBinding ||
          kimiBinding
        ) {
          const permissions = new Set(normalizePermissionList(apiKey.permissions))
          permissions.add('claude')
          if (openai_account_id) {
            permissions.add('openai')
          }
          if (deepseekBinding) {
            permissions.add('deepseek')
          }
          if (minimaxBinding) {
            permissions.add('minimax')
          }
          if (glmBinding) {
            permissions.add('glm')
          }
          if (kimiBinding) {
            permissions.add('kimi')
          }
          updates.permissions = Array.from(permissions)
        }

        // 使用 apiKeyService 更新
        await apiKeyService.updateApiKey(keyConfig.key_id, updates)

        successCount++
        logger.info(
          `✅ Updated API Key config: ${keyConfig.key_id}, claude_rate=${resolvedClaudeRate ?? '-'}, openai_rate=${keyConfig.openai_rate ?? '-'}, deepseek_rate=${keyConfig.deepseek_rate ?? '-'}${claude_account_id ? `, claude_account=${claude_account_id}` : ''}${openai_account_id ? `, openai_account=${openai_account_id}` : ''}${deepseek_account_id ? `, deepseek_account=${deepseek_account_id}` : ''}`
        )
      } catch (error) {
        logger.error(`❌ Failed to update API Key ${keyConfig.key_id}:`, error)
        failed.push({
          key_id: keyConfig.key_id,
          reason: error.message || 'Unknown error'
        })
      }
    }

    return res.json({
      code: 0,
      msg: 'success',
      data: {
        total: configs.length,
        success: successCount,
        failed: failed.length,
        failedDetails: failed
      }
    })
  } catch (error) {
    logger.error('❌ Partner update config error:', error)
    return res.status(500).json({
      code: 1003,
      msg: error.message || 'Internal server error',
      data: null
    })
  }
})

module.exports = router
