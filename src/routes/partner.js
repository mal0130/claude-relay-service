const express = require('express')
const router = express.Router()
const { authenticatePartner } = require('../middleware/partnerAuth')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const CostCalculator = require('../utils/costCalculator')

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
    const allKeyIds = await client.smembers('api_keys')

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

module.exports = router
