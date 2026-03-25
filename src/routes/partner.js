const express = require('express')
const router = express.Router()
const { authenticatePartner } = require('../middleware/partnerAuth')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const apiKeyService = require('../services/apiKeyService')
const accountGroupService = require('../services/accountGroupService')
const openaiResponsesAccountService = require('../services/account/openaiResponsesAccountService')
const config = require('../../config/config')

// Helper: Find API Key by ID or Name
async function findApiKey(keyId, keyName) {
  const client = redis.getClientSafe()

  if (keyId) {
    const targetKey = await redis.getApiKey(keyId)
    if (!targetKey || targetKey.deleted) {
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

// Helper: Get usage summary for a key
async function getUsageSummary(apiKey) {
  const client = redis.getClientSafe()
  const keyId = apiKey.id
  const totalCostKey = `usage:cost:total:${keyId}`
  const totalCost = parseFloat((await client.get(totalCostKey)) || '0')

  return {
    keyId: apiKey.id,
    keyName: apiKey.name,
    totalCost: parseFloat(totalCost.toFixed(4)),
    totalCostLimit: parseFloat(apiKey.totalCostLimit || 0)
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

  if (!account || !account.isActive) {
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
    return !!account && account.isActive === 'true'
  }

  const account = await openaiAccountService.getAccount(openaiAccountId)
  return !!account && account.isActive === 'true'
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

function buildServiceRates(currentRates = {}, claudeRate, openaiRate) {
  const serviceRates = { ...normalizeServiceRates(currentRates) }

  if (claudeRate !== undefined && claudeRate !== null && claudeRate !== '') {
    serviceRates.claude = Number(claudeRate)
  }

  if (openaiRate !== undefined && openaiRate !== null && openaiRate !== '') {
    serviceRates.codex = Number(openaiRate)
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

// 🔑 创建 API Key
router.post('/api-key/create', authenticatePartner, async (req, res) => {
  try {
    const {
      name,
      totalCostLimit,
      claude_account_id,
      openai_account_id,
      claude_rate,
      openai_rate,
      rate,
      rateLimits
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

    const createServiceRates = buildServiceRates({}, resolvedClaudeRate, openai_rate)

    const permissions = ['claude']
    if (openai_account_id) {
      permissions.push('openai')
    }

    // 准备创建参数
    const createParams = {
      name: name.trim(),
      description: 'Created by partner API',
      tags: ['uni-agent'],
      totalCostLimit: totalCostLimit ? Number(totalCostLimit) : 0,
      ...claudeBindingFields,
      permissions,
      isActive: true
    }

    if (openai_account_id) {
      createParams.openaiAccountId = openai_account_id
    }

    if (Object.keys(createServiceRates).length > 0) {
      createParams.serviceRates = createServiceRates
    }

    if (rateLimits && rateLimits.length > 0) {
      createParams.rateLimits = rateLimits
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

// 🔧 批量更新 API Key 配置
router.post('/api-key/update-config', authenticatePartner, async (req, res) => {
  try {
    const { configs, claude_account_id, openai_account_id } = req.body

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
          keyConfig.openai_rate
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

        if (claudeBindingUpdates || openai_account_id) {
          const permissions = new Set(normalizePermissionList(apiKey.permissions))
          permissions.add('claude')
          if (openai_account_id) {
            permissions.add('openai')
          }
          updates.permissions = Array.from(permissions)
        }

        // 使用 apiKeyService 更新
        await apiKeyService.updateApiKey(keyConfig.key_id, updates)

        successCount++
        logger.info(
          `✅ Updated API Key config: ${keyConfig.key_id}, claude_rate=${resolvedClaudeRate ?? '-'}, openai_rate=${keyConfig.openai_rate ?? '-'}${claude_account_id ? `, claude_account=${claude_account_id}` : ''}${openai_account_id ? `, openai_account=${openai_account_id}` : ''}`
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
