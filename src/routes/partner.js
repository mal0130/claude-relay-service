const express = require('express')
const router = express.Router()
const { authenticatePartner } = require('../middleware/partnerAuth')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const CostCalculator = require('../utils/costCalculator')
const pricingService = require('../services/pricingService')
const config = require('../../config/config')

router.post('/api-key/usage', authenticatePartner, async (req, res) => {
  try {
    const { key_id, key_name } = req.body

    // 参数验证：key_id 和 key_name 至少提供一个
    if (!key_id && !key_name) {
      return res.status(400).json({
        code: 1001,
        msg: 'key_id or key_name is required',
        data: null
      })
    }

    logger.info(`📊 Partner usage query: ${key_id ? `key_id=${key_id}` : `key_name=${key_name}`}`)

    // 1. 查找API Key（优先使用 key_id）
    const client = redis.getClientSafe()
    let targetKey = null

    if (key_id) {
      // 优先通过 key_id 直接查找
      targetKey = await redis.getApiKey(key_id)
      if (!targetKey || targetKey.deleted) {
        logger.warn(`❌ API Key not found: key_id=${key_id}`)
        return res.status(404).json({
          code: 1002,
          msg: `No active API Key found with id: ${key_id}`,
          data: null
        })
      }
    } else {
      // 通过 key_name 查找
      const allKeyIds = await client.smembers('apikey:set:active')

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
    }

    const keyId = targetKey.id

    // 2. 获取总费用
    const totalCostKey = `usage:cost:total:${keyId}`
    const totalCost = parseFloat((await client.get(totalCostKey)) || '0')

    // 3. 构建响应数据（精简版）
    const responseData = {
      keyId: targetKey.id,
      keyName: targetKey.name,
      totalCost: parseFloat(totalCost.toFixed(4)),
      totalCostLimit: parseFloat(targetKey.totalCostLimit || 0)
    }

    logger.info(`✅ Partner usage query success: key_name=${key_name}, totalCost=${totalCost}`)

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
    const { key_id, key_name } = req.body

    // 参数验证：key_id 和 key_name 至少提供一个
    if (!key_id && !key_name) {
      return res.status(400).json({
        code: 1001,
        msg: 'key_id or key_name is required',
        data: null
      })
    }

    logger.info(
      `📊 Partner usage details query: ${key_id ? `key_id=${key_id}` : `key_name=${key_name}`}`
    )

    // 1. 查找API Key（优先使用 key_id）
    const client = redis.getClientSafe()
    let targetKey = null

    if (key_id) {
      // 优先通过 key_id 直接查找
      targetKey = await redis.getApiKey(key_id)
      if (!targetKey || targetKey.deleted) {
        logger.warn(`❌ API Key not found: key_id=${key_id}`)
        return res.status(404).json({
          code: 1002,
          msg: `No active API Key found with id: ${key_id}`,
          data: null
        })
      }
    } else {
      // 通过 key_name 查找
      const allKeyIds = await client.smembers('apikey:set:active')

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
    }

    const keyId = targetKey.id

    // 2. 生成最近30天的日期列表
    const tzDate = redis.getDateInTimezone()
    const dateStrings = []
    for (let i = 0; i < 30; i++) {
      const d = new Date(tzDate)
      d.setDate(d.getDate() - i)
      dateStrings.push(redis.getDateStringInTimezone(d))
    }

    // 3. 发现该 Key 使用过的所有模型（通过 alltime 索引）
    const modelSet = new Set()
    const alltimeKeys = await redis.scanKeys(`usage:${keyId}:model:alltime:*`)
    alltimeKeys.forEach((k) => {
      const parts = k.split(':')
      if (parts.length >= 5) {
        // usage:{keyId}:model:alltime:{model}
        modelSet.add(parts.slice(4).join(':'))
      }
    })
    const models = Array.from(modelSet)

    // 4. 使用 pipeline 批量查询（与 getAggregatedUsageStats 一致）
    const pipeline = client.pipeline()
    const queryMap = []

    for (const dateStr of dateStrings) {
      // A. 每日汇总用量
      pipeline.hgetall(`usage:daily:${keyId}:${dateStr}`)
      queryMap.push({ type: 'daily', date: dateStr })

      // B. 每日费用
      pipeline.get(`usage:cost:daily:${keyId}:${dateStr}`)
      queryMap.push({ type: 'cost', date: dateStr })

      // C. 每日各模型用量
      for (const model of models) {
        pipeline.hgetall(`usage:${keyId}:model:daily:${model}:${dateStr}`)
        queryMap.push({ type: 'model', date: dateStr, model })
      }
    }

    const results = await pipeline.exec()

    // 5. 聚合数据
    const dailyMap = {}
    const modelStatsMap = {}
    const dailyModelMap = {} // date -> model -> stats

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
      if (err || !data) return
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

          // 累加到模型总计
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

          // 累加到当天模型明细
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

    // 计算每日 totalTokens
    for (const day of Object.values(dailyMap)) {
      day.totalTokens =
        day.inputTokens + day.outputTokens + day.cacheCreateTokens + day.cacheReadTokens
    }

    // 6. 构建 dailyUsage（按日期倒序，只返回有数据的日期）
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

    // 7. 构建 modelStats（按请求数倒序）
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

    // 8. 计算总计
    const totalStats = {
      requests: dailyUsage.reduce((sum, day) => sum + day.requests, 0),
      inputTokens: dailyUsage.reduce((sum, day) => sum + day.inputTokens, 0),
      outputTokens: dailyUsage.reduce((sum, day) => sum + day.outputTokens, 0),
      cacheCreateTokens: dailyUsage.reduce((sum, day) => sum + day.cacheCreateTokens, 0),
      cacheReadTokens: dailyUsage.reduce((sum, day) => sum + day.cacheReadTokens, 0),
      totalTokens: dailyUsage.reduce((sum, day) => sum + day.totalTokens, 0),
      cost: parseFloat(dailyUsage.reduce((sum, day) => sum + day.cost, 0).toFixed(6))
    }

    // 9. 构建响应数据
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

    // 从环境变量获取默认 Claude 账户 ID
    const foxCodeAccountId = config.partnerApi.defaultClaudeAccountId

    if (!foxCodeAccountId) {
      logger.warn('❌ Partner default Claude account ID not configured')
      return res.status(500).json({
        code: 1003,
        msg: 'Partner default Claude account ID not configured. Please set PARTNER_DEFAULT_CLAUDE_ACCOUNT_ID environment variable.',
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
