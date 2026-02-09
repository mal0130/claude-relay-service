const express = require('express')
const router = express.Router()
const { authenticatePartner } = require('../middleware/partnerAuth')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const CostCalculator = require('../utils/costCalculator')
const pricingService = require('../services/pricingService')

router.post('/api-key/usage', authenticatePartner, async (req, res) => {
  try {
    const { key_name } = req.body

    // 参数验证
    if (!key_name) {
      return res.status(400).json({
        code: 1001,
        msg: 'key_name is required',
        data: null
      })
    }

    logger.info(`📊 Partner usage query: key_name=${key_name}`)

    // 1. 通过key_name查找API Key
    const client = redis.getClientSafe()
    const allKeyIds = await client.smembers('apikey:set:active')

    let targetKey = null
    for (const keyId of allKeyIds) {
      const apiKey = await redis.getApiKey(keyId)
      if (apiKey && apiKey.name === key_name && !apiKey.deleted) {
        targetKey = apiKey
        break
      }
    }

    if (!targetKey) {
      logger.warn(`❌ API Key not found: key_name=${key_name}`)
      return res.status(404).json({
        code: 1002,
        msg: `No active API Key found with name: ${key_name}`,
        data: null
      })
    }

    const keyId = targetKey.id

    // 2. 获取总费用
    const totalCostKey = `usage:cost:total:${keyId}`
    const totalCost = parseFloat((await client.get(totalCostKey)) || '0')

    // 3. 获取每日费用
    const dailyCost = await redis.getDailyCost(keyId)

    // 4. 获取用量统计（最近30天的数据）
    const tzDate = redis.getDateInTimezone()
    const searchPatterns = []

    // 查询最近30天
    for (let i = 0; i < 30; i++) {
      const d = new Date(tzDate)
      d.setDate(d.getDate() - i)
      const dateStr = redis.getDateStringInTimezone(d)
      searchPatterns.push(`usage:${keyId}:model:daily:*:${dateStr}`)
    }

    // 收集所有匹配的keys
    const allKeys = []
    for (const pattern of searchPatterns) {
      let cursor = '0'
      do {
        const [newCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        cursor = newCursor
        allKeys.push(...keys)
      } while (cursor !== '0')
    }

    // 聚合统计数据
    let totalRequests = 0
    let totalTokens = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheCreateTokens = 0
    let totalCacheReadTokens = 0

    if (allKeys.length > 0) {
      const usageDataList = await client.mget(allKeys)
      for (const data of usageDataList) {
        if (!data) continue
        try {
          const usage = JSON.parse(data)
          totalRequests += usage.requests || 0
          totalTokens += usage.tokens || 0
          totalInputTokens += usage.inputTokens || 0
          totalOutputTokens += usage.outputTokens || 0
          totalCacheCreateTokens += usage.cacheCreateTokens || 0
          totalCacheReadTokens += usage.cacheReadTokens || 0
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    // 5. 构建响应数据（精简版）
    const responseData = {
      keyId: targetKey.id,
      keyName: targetKey.name,
      totalCost: parseFloat(totalCost.toFixed(4)),
      totalCostLimit: parseFloat(targetKey.totalCostLimit || 0)
    }

    logger.info(
      `✅ Partner usage query success: key_name=${key_name}, totalCost=${totalCost}`
    )

    return res.json({
      code: 0,
      msg: 'success',
      data: responseData
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
    const { key_name } = req.body

    // 参数验证
    if (!key_name) {
      return res.status(400).json({
        code: 1001,
        msg: 'key_name is required',
        data: null
      })
    }

    logger.info(`📊 Partner usage details query: key_name=${key_name}`)

    // 1. 通过key_name查找API Key
    const client = redis.getClientSafe()
    const allKeyIds = await client.smembers('apikey:set:active')

    let targetKey = null
    for (const keyId of allKeyIds) {
      const apiKey = await redis.getApiKey(keyId)
      if (apiKey && apiKey.name === key_name && !apiKey.deleted) {
        targetKey = apiKey
        break
      }
    }

    if (!targetKey) {
      logger.warn(`❌ API Key not found: key_name=${key_name}`)
      return res.status(404).json({
        code: 1002,
        msg: `No active API Key found with name: ${key_name}`,
        data: null
      })
    }

    const keyId = targetKey.id

    // 2. 查询最近30天的用量数据
    const tzDate = redis.getDateInTimezone()
    const dailyUsageMap = new Map()
    const modelStatsMap = new Map()
    const dailyModelStatsMap = new Map() // 按天+模型维度的统计

    // 生成最近30天的日期列表
    for (let i = 0; i < 30; i++) {
      const d = new Date(tzDate)
      d.setDate(d.getDate() - i)
      const dateStr = redis.getDateStringInTimezone(d)

      // 初始化当天数据
      dailyUsageMap.set(dateStr, {
        date: dateStr,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        cost: 0,
        models: [] // 当天的模型明细
      })

      // 查询该日期的所有模型用量
      const pattern = `usage:${keyId}:model:daily:*:${dateStr}`
      let cursor = '0'
      const keys = []

      do {
        const [newCursor, matchedKeys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        cursor = newCursor
        keys.push(...matchedKeys)
      } while (cursor !== '0')

      // 聚合该日期的数据
      if (keys.length > 0) {
        const usageDataList = await client.mget(keys)

        for (let j = 0; j < keys.length; j++) {
          const key = keys[j]
          const data = usageDataList[j]

          if (!data) continue

          try {
            const usage = JSON.parse(data)

            // 提取模型名称
            const modelMatch = key.match(/usage:[^:]+:model:daily:(.+):\d{4}-\d{2}-\d{2}$/)
            const modelName = modelMatch ? modelMatch[1] : 'unknown'

            // 累加到当天总计
            const dayData = dailyUsageMap.get(dateStr)
            dayData.requests += usage.requests || 0
            dayData.inputTokens += usage.inputTokens || 0
            dayData.outputTokens += usage.outputTokens || 0
            dayData.cacheCreateTokens += usage.cacheCreateTokens || 0
            dayData.cacheReadTokens += usage.cacheReadTokens || 0
            dayData.totalTokens += usage.tokens || 0
            dayData.cost += usage.cost || 0

            // 累加到当天的模型明细
            const dayModelKey = `${dateStr}:${modelName}`
            if (!dailyModelStatsMap.has(dayModelKey)) {
              dailyModelStatsMap.set(dayModelKey, {
                model: modelName,
                requests: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreateTokens: 0,
                cacheReadTokens: 0,
                totalTokens: 0,
                cost: 0
              })
            }

            const dayModelStats = dailyModelStatsMap.get(dayModelKey)
            dayModelStats.requests += usage.requests || 0
            dayModelStats.inputTokens += usage.inputTokens || 0
            dayModelStats.outputTokens += usage.outputTokens || 0
            dayModelStats.cacheCreateTokens += usage.cacheCreateTokens || 0
            dayModelStats.cacheReadTokens += usage.cacheReadTokens || 0
            dayModelStats.totalTokens += usage.tokens || 0
            dayModelStats.cost += usage.cost || 0

            // 累加到模型统计
            if (!modelStatsMap.has(modelName)) {
              modelStatsMap.set(modelName, {
                model: modelName,
                requests: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreateTokens: 0,
                cacheReadTokens: 0,
                totalTokens: 0,
                cost: 0
              })
            }

            const modelStats = modelStatsMap.get(modelName)
            modelStats.requests += usage.requests || 0
            modelStats.inputTokens += usage.inputTokens || 0
            modelStats.outputTokens += usage.outputTokens || 0
            modelStats.cacheCreateTokens += usage.cacheCreateTokens || 0
            modelStats.cacheReadTokens += usage.cacheReadTokens || 0
            modelStats.totalTokens += usage.tokens || 0
            modelStats.cost += usage.cost || 0
          } catch (e) {
            logger.debug(`⚠️ Failed to parse usage data for key ${key}:`, e)
          }
        }
      }
    }

    // 3. 转换为数组并排序（按日期倒序）
    const dailyUsage = Array.from(dailyUsageMap.values())
      .filter((day) => day.requests > 0) // 只返回有数据的日期
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((day) => {
        // 获取当天的模型明细
        const dayModels = []
        for (const [key, modelData] of dailyModelStatsMap.entries()) {
          if (key.startsWith(`${day.date}:`)) {
            dayModels.push({
              model: modelData.model,
              requests: modelData.requests,
              inputTokens: modelData.inputTokens,
              outputTokens: modelData.outputTokens,
              cacheCreateTokens: modelData.cacheCreateTokens,
              cacheReadTokens: modelData.cacheReadTokens,
              totalTokens: modelData.totalTokens,
              cost: parseFloat(modelData.cost.toFixed(6))
            })
          }
        }
        // 按请求数倒序排序
        dayModels.sort((a, b) => b.requests - a.requests)

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

    // 4. 转换模型统计为数组并排序（按请求数倒序）
    const modelStats = Array.from(modelStatsMap.values())
      .sort((a, b) => b.requests - a.requests)
      .map((model) => ({
        model: model.model,
        requests: model.requests,
        inputTokens: model.inputTokens,
        outputTokens: model.outputTokens,
        cacheCreateTokens: model.cacheCreateTokens,
        cacheReadTokens: model.cacheReadTokens,
        totalTokens: model.totalTokens,
        cost: parseFloat(model.cost.toFixed(6))
      }))

    // 5. 计算总计
    const totalStats = {
      requests: dailyUsage.reduce((sum, day) => sum + day.requests, 0),
      inputTokens: dailyUsage.reduce((sum, day) => sum + day.inputTokens, 0),
      outputTokens: dailyUsage.reduce((sum, day) => sum + day.outputTokens, 0),
      cacheCreateTokens: dailyUsage.reduce((sum, day) => sum + day.cacheCreateTokens, 0),
      cacheReadTokens: dailyUsage.reduce((sum, day) => sum + day.cacheReadTokens, 0),
      totalTokens: dailyUsage.reduce((sum, day) => sum + day.totalTokens, 0),
      cost: parseFloat(dailyUsage.reduce((sum, day) => sum + day.cost, 0).toFixed(6))
    }

    // 6. 构建响应数据
    const responseData = {
      keyId: targetKey.id,
      keyName: targetKey.name,
      period: 'last_30_days',
      totalStats,
      dailyUsage,
      modelStats
    }

    logger.info(
      `✅ Partner usage details query success: key_name=${key_name}, days=${dailyUsage.length}, models=${modelStats.length}`
    )

    return res.json({
      code: 0,
      msg: 'success',
      data: responseData
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
    const { name, totalCostLimit } = req.body

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

    logger.info(`🔑 Partner creating API Key: name=${name}`)

    // 查找名为 "FoxCode" 的 Claude 账户（支持 Official 和 Console 类型）
    const client = redis.getClientSafe()

    let foxCodeAccountId = null

    // 1. 先查找 Claude Official 账户
    const claudeOfficialIds = await client.smembers('claude_accounts')
    for (const accountId of claudeOfficialIds) {
      const account = await client.hgetall(`claude:account:${accountId}`)
      if (account && account.name === 'FoxCode' && account.status === 'active') {
        foxCodeAccountId = accountId
        break
      }
    }

    // 2. 如果没找到，查找 Claude Console 账户
    if (!foxCodeAccountId) {
      const claudeConsoleIds = await client.smembers('claude_console_accounts')
      for (const accountId of claudeConsoleIds) {
        const account = await client.hgetall(`claude_console_account:${accountId}`)
        if (account && account.name === 'FoxCode' && account.status === 'active') {
          foxCodeAccountId = accountId
          break
        }
      }
    }

    if (!foxCodeAccountId) {
      logger.warn('❌ FoxCode account not found or inactive')
      return res.status(404).json({
        code: 1002,
        msg: 'FoxCode account not found or inactive',
        data: null
      })
    }

    // 调用 apiKeyService 创建 API Key
    const apiKeyService = require('../services/apiKeyService')
    const newKey = await apiKeyService.generateApiKey({
      name: name.trim(),
      description: 'Created by partner API',
      tags: ['uni-agent'],
      totalCostLimit: totalCostLimit ? Number(totalCostLimit) : 0,
      claudeAccountId: foxCodeAccountId,
      permissions: ['claude'], // 只允许访问 Claude 服务
      isActive: true
    })

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

module.exports = router
