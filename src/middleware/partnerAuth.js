const crypto = require('crypto')
const config = require('../../config/config')
const logger = require('../utils/logger')

/**
 * 生成签名（PHP 风格算法）
 *
 * 算法步骤：
 * 1. 参数按 key 排序（ksort）
 * 2. 拼接为 key1=value1&key2=value2 格式
 * 3. 对象/数组使用 JSON.stringify
 * 4. 末尾追加密钥
 * 5. SHA256 哈希
 * 6. 转大写
 *
 * @param {Object} params - 请求参数
 * @param {string} secretKey - API 密钥
 * @returns {string} 大写的 SHA256 签名
 */
function generateSignature(params, secretKey) {
  // 1. 按 key 排序
  const sortedKeys = Object.keys(params).sort()

  // 2. 拼接参数
  let signStr = ''
  for (const key of sortedKeys) {
    const value = params[key]

    // 对象或数组使用 JSON.stringify（不带空格）
    if (typeof value === 'object' && value !== null) {
      signStr += `${key}=${JSON.stringify(value)}`
    } else {
      signStr += `${key}=${value}`
    }
    signStr += '&'
  }

  // 3. 移除末尾的 &
  signStr = signStr.slice(0, -1)

  // 4. 追加密钥
  signStr += secretKey

  // 5. SHA256 哈希并转大写
  const hash = crypto.createHash('sha256').update(signStr).digest('hex')
  return hash.toUpperCase()
}

/**
 * 合作伙伴系统验签中间件
 *
 * 验签规则：
 * 1. 参数中需包含：sign
 * 2. 签名算法：SHA256
 * 3. 签名内容：参数按key排序 -> key=value拼接 -> 末尾追加密钥 -> SHA256哈希 -> 转大写
 * 4. 参数处理：对象/数组使用JSON.stringify，字符串直接拼接
 * 5. 示例：key1=value1&key2=value2&API_PRIVATE_KEY -> SHA256 -> 大写
 */
async function authenticatePartner(req, res, next) {
  try {
    // 1. 获取请求参数（合并 query 和 body）
    const params = { ...req.query, ...req.body }

    // 2. 检查必需的 sign 参数
    const signature = params.sign
    if (!signature) {
      logger.warn('❌ Partner auth failed: Missing sign parameter')
      return res.status(401).json({
        code: 401,
        msg: 'Missing authentication parameter: sign',
        data: null
      })
    }

    // 3. 移除 sign 参数（不参与签名计算）
    delete params.sign

    // 4. 计算签名
    const secretKey = config.partnerApi?.secret || config.security?.jwtSecret || config.jwtSecret
    const expectedSignature = generateSignature(params, secretKey)

    // 5. 验证签名（不区分大小写）
    if (signature.toUpperCase() !== expectedSignature.toUpperCase()) {
      logger.warn('❌ Partner auth failed: Invalid signature')
      return res.status(401).json({
        code: 401,
        msg: 'Invalid signature',
        data: null
      })
    }

    logger.info(`✅ Partner auth success`)
    next()
  } catch (error) {
    logger.error('❌ Partner auth error:', error)
    return res.status(500).json({
      code: 500,
      msg: error.message || 'Authentication error',
      data: null
    })
  }
}

module.exports = {
  authenticatePartner
}
