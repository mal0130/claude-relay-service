/**
 * 合作伙伴 API 简单测试脚本（不使用测试框架）
 * 基于 docs/partner-api.md 文档示例
 *
 * 前置条件：
 * - 必须存在一个名为 "FoxCode" 的 Claude 账户且状态为 active
 * - 可通过 Web 管理界面添加 Claude 账户并命名为 "FoxCode"
 *
 * 使用方法：
 * 1. 确保服务已启动：npm start
 * 2. 配置环境变量：export PARTNER_API_SECRET=test-secret-key-12345
 * 3. 添加 FoxCode 账户（如果还没有）
 * 4. 可选：配置 PARTNER_TEST_DEEPSEEK_ACCOUNT_ID 测试 DeepSeek 账号绑定
 * 5. 运行脚本：node scripts/test-partner-api-simple.js
 */

const crypto = require('crypto')
const axios = require('axios')

// ==================== 配置 ====================
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000'
const SECRET_KEY = process.env.PARTNER_API_SECRET || 'test-secret-key-12345'
const DEEPSEEK_ACCOUNT_ID =
  process.env.PARTNER_TEST_DEEPSEEK_ACCOUNT_ID || process.env.DEEPSEEK_ACCOUNT_ID || ''

// 测试统计
let totalTests = 0
let passedTests = 0
let failedTests = 0

// ==================== 工具函数 ====================

/**
 * 生成签名（与文档示例一致）
 */
function generateSignature(params, secretKey = SECRET_KEY) {
  // 1. 移除 sign 参数（如果存在）
  const cleanParams = { ...params }
  delete cleanParams.sign

  // 2. 按 key 排序
  const sortedKeys = Object.keys(cleanParams).sort()

  // 3. 拼接参数
  let signStr = ''
  for (const key of sortedKeys) {
    const value = cleanParams[key]

    // 对象或数组使用 JSON.stringify
    if (typeof value === 'object' && value !== null) {
      signStr += `${key}=${JSON.stringify(value)}`
    } else {
      signStr += `${key}=${value}`
    }
    signStr += '&'
  }

  // 4. 移除末尾的 &
  signStr = signStr.slice(0, -1)

  // 5. 追加密钥
  signStr += secretKey

  // 6. SHA256 哈希并转大写
  return crypto.createHash('sha256').update(signStr).digest('hex').toUpperCase()
}

/**
 * 测试断言
 */
function assert(condition, message) {
  totalTests++
  if (condition) {
    passedTests++
    console.log(`  ✓ ${message}`)
  } else {
    failedTests++
    console.error(`  ✗ ${message}`)
    throw new Error(`Assertion failed: ${message}`)
  }
}

/**
 * 测试用例包装器
 */
async function test(name, fn) {
  console.log(`\n${name}`)
  try {
    await fn()
  } catch (error) {
    if (!error.message?.startsWith('Assertion failed:')) {
      totalTests++
      failedTests++
    }
    console.error(`  Error: ${error.message}`)
  }
}

// ==================== 测试用例 ====================

let createdApiKeyId = null
let createdApiKeyName = null
let createdApiKey = null
let createdEnterpriseKeyId = null
let createdEnterpriseApiKey = null

/**
 * 测试 1: 创建 API Key
 */
async function testCreateApiKey() {
  await test('测试 1: 创建 API Key', async () => {
    const params = {
      name: `TestApp_${Date.now()}`,
      totalCostLimit: 100.0,
      claude_rate: 2.1,
      deepseek_rate: 1.2
    }

    if (DEEPSEEK_ACCOUNT_ID) {
      params.deepseek_account_id = DEEPSEEK_ACCOUNT_ID
    }

    const signature = generateSignature(params)

    try {
      const response = await axios.post(
        `${API_BASE_URL}/partner/api-key/create`,
        { ...params, sign: signature },
        { headers: { 'Content-Type': 'application/json' } }
      )

      assert(response.status === 200, 'HTTP 状态码应为 200')
      assert(response.data.code === 0, '响应 code 应为 0')
      assert(response.data.msg === 'success', '响应 msg 应为 success')
      assert(response.data.data.keyId, '应返回 keyId')
      assert(response.data.data.keyName === params.name, 'keyName 应匹配')
      assert(response.data.data.apiKey, '应返回 apiKey')
      assert(response.data.data.apiKey.startsWith('cr_'), 'apiKey 应以 cr_ 开头')

      // 保存用于后续测试
      createdApiKeyId = response.data.data.keyId
      createdApiKeyName = response.data.data.keyName
      createdApiKey = response.data.data.apiKey

      console.log(`  创建的 API Key: ${createdApiKey}`)
      if (DEEPSEEK_ACCOUNT_ID) {
        console.log(`  已绑定 DeepSeek 账户: ${DEEPSEEK_ACCOUNT_ID}`)
      } else {
        console.log(`  未配置 PARTNER_TEST_DEEPSEEK_ACCOUNT_ID，跳过 DeepSeek 绑定创建`)
      }
    } catch (error) {
      if (error.response?.data?.code === 1002) {
        console.log(`  ⚠️  跳过：缺少 FoxCode 账户（${error.response.data.msg}）`)
        console.log(`  提示：请通过 Web 管理界面添加名为 "FoxCode" 的 Claude 账户`)
        return
      }
      throw error
    }
  })
}

/**
 * 测试 1.5: 创建 API Key - DeepSeek 倍率格式错误
 */
async function testCreateApiKeyInvalidDeepSeekRate() {
  await test('测试 1.5: 创建 API Key - DeepSeek 倍率格式错误', async () => {
    const params = {
      name: `TestApp_InvalidDeepSeekRate_${Date.now()}`,
      deepseek_rate: 1.23
    }
    const signature = generateSignature(params)

    try {
      await axios.post(
        `${API_BASE_URL}/partner/api-key/create`,
        { ...params, sign: signature },
        { headers: { 'Content-Type': 'application/json' } }
      )
      assert(false, '应该抛出错误')
    } catch (error) {
      assert(error.response.status === 400, 'HTTP 状态码应为 400')
      assert(error.response.data.code === 1001, '错误码应为 1001')
      assert(error.response.data.msg.includes('deepseek_rate'), '错误信息应包含 deepseek_rate')
    }
  })
}

/**
 * 测试 2: 创建 API Key - 缺少必需参数
 */
async function testCreateApiKeyMissingName() {
  await test('测试 2: 创建 API Key - 缺少 name 参数', async () => {
    const params = { totalCostLimit: 100.0 }
    const signature = generateSignature(params)

    try {
      await axios.post(
        `${API_BASE_URL}/partner/api-key/create`,
        { ...params, sign: signature },
        { headers: { 'Content-Type': 'application/json' } }
      )
      assert(false, '应该抛出错误')
    } catch (error) {
      assert(error.response.status === 400, 'HTTP 状态码应为 400')
      assert(error.response.data.code === 1001, '错误码应为 1001')
      assert(
        error.response.data.msg.includes('name is required'),
        '错误信息应包含 name is required'
      )
    }
  })
}

/**
 * 测试 3: 创建 API Key - 签名验证失败
 */
async function testCreateApiKeyInvalidSignature() {
  await test('测试 3: 创建 API Key - 签名验证失败', async () => {
    const params = {
      name: `TestApp_${Date.now()}`,
      totalCostLimit: 100.0
    }

    try {
      await axios.post(
        `${API_BASE_URL}/partner/api-key/create`,
        { ...params, sign: 'INVALID_SIGNATURE' },
        { headers: { 'Content-Type': 'application/json' } }
      )
      assert(false, '应该抛出错误')
    } catch (error) {
      assert(error.response.status === 401, 'HTTP 状态码应为 401')
      const msg = error.response.data.message || error.response.data.msg
      assert(
        msg.includes('Signature verification failed') || msg.includes('Invalid signature'),
        '错误信息应包含签名验证失败'
      )
    }
  })
}

/**
 * 测试 4: 查询 API Key 用量汇总（使用 key_ids）
 */
async function testQueryUsage() {
  await test('测试 4: 查询 API Key 用量汇总（使用 key_ids）', async () => {
    if (!createdApiKeyId) {
      console.log('  跳过：需要先创建 API Key')
      return
    }

    const params = { key_ids: [createdApiKeyId] }
    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/api-key/usage`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.msg === 'success', '响应 msg 应为 success')
    assert(typeof response.data.data === 'object', 'data 应为对象')
    assert(response.data.data[createdApiKeyId], '应包含对应 keyId 的数据')

    const keyData = response.data.data[createdApiKeyId]
    assert(keyData.keyId === createdApiKeyId, 'keyId 应匹配')
    assert(keyData.keyName === createdApiKeyName, 'keyName 应匹配')
    assert(typeof keyData.totalCost === 'number', 'totalCost 应为数字')
    assert(typeof keyData.totalCostLimit === 'number', 'totalCostLimit 应为数字')

    console.log(`  总费用: $${keyData.totalCost}`)
    console.log(`  费用限制: $${keyData.totalCostLimit}`)
  })
}

/**
 * 测试 4.5: 查询 API Key 用量汇总（多个 key_ids）
 */
async function testQueryUsageByKeyId() {
  await test('测试 4.5: 查询 API Key 用量汇总（多个 key_ids）', async () => {
    if (!createdApiKeyId) {
      console.log('  跳过：需要先创建 API Key')
      return
    }

    const fakeId = 'non-existent-id-12345'
    const params = { key_ids: [createdApiKeyId, fakeId] }
    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/api-key/usage`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.data[createdApiKeyId], '应包含存在的 keyId 数据')
    assert(!response.data.data[fakeId], '不存在的 keyId 不应出现在结果中')

    console.log(`  多 key_ids 查询成功，返回 ${Object.keys(response.data.data).length} 条结果`)
  })
}

/**
 * 测试 5: 查询用量 - API Key 不存在
 */
async function testQueryUsageNotFound() {
  await test('测试 5: 查询用量 - API Key 不存在', async () => {
    const params = { key_ids: ['non-existent-id-999999'] }
    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/api-key/usage`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(Object.keys(response.data.data).length === 0, '不存在的 key 应返回空对象')
  })
}

/**
 * 测试 5.5: 查询用量 - 缺少 key_ids 参数
 */
async function testQueryUsageMissingParams() {
  await test('测试 5.5: 查询用量 - 缺少 key_ids 参数', async () => {
    const params = {}
    const signature = generateSignature(params)

    try {
      await axios.post(
        `${API_BASE_URL}/partner/api-key/usage`,
        { ...params, sign: signature },
        { headers: { 'Content-Type': 'application/json' } }
      )
      assert(false, '应该抛出错误')
    } catch (error) {
      assert(error.response.status === 400, 'HTTP 状态码应为 400')
      assert(error.response.data.code === 1001, '错误码应为 1001')
      assert(
        error.response.data.msg.includes('key_ids is required'),
        '错误信息应包含 key_ids is required'
      )
    }
  })
}

/**
 * 测试 6: 查询 API Key 用量明细（使用 key_ids）
 */
async function testQueryUsageDetails() {
  await test('测试 6: 查询 API Key 用量明细（使用 key_ids）', async () => {
    if (!createdApiKeyId) {
      console.log('  跳过：需要先创建 API Key')
      return
    }

    const params = { key_ids: [createdApiKeyId] }
    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/api-key/usage-details`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.msg === 'success', '响应 msg 应为 success')
    assert(response.data.data.keyId === 'aggregated', 'keyId 应为 aggregated')
    assert(response.data.data.period === 'last_30_days', 'period 应为 last_30_days')
    assert(response.data.data.totalStats, '应包含 totalStats')
    assert(Array.isArray(response.data.data.dailyUsage), 'dailyUsage 应为数组')
    assert(Array.isArray(response.data.data.modelStats), 'modelStats 应为数组')

    const { totalStats, dailyUsage, modelStats } = response.data.data

    console.log(`\n  === 总计统计 ===`)
    console.log(`  总请求数: ${totalStats.requests}`)
    console.log(`  总Token数: ${totalStats.totalTokens}`)
    console.log(`  总费用: $${totalStats.cost}`)

    if (dailyUsage.length > 0) {
      console.log(`\n  === 每日用量（最近3天）===`)
      dailyUsage.slice(0, 3).forEach((day) => {
        console.log(`  ${day.date}: ${day.requests}次请求, ${day.totalTokens} tokens, $${day.cost}`)
      })
    }

    if (modelStats.length > 0) {
      console.log(`\n  === 模型统计（Top 3）===`)
      modelStats.slice(0, 3).forEach((model) => {
        console.log(`  ${model.model}: ${model.requests}次请求, $${model.cost}`)
      })
    }
  })
}

/**
 * 测试 6.5: 查询 API Key 用量明细（多个 key_ids）
 */
async function testQueryUsageDetailsByKeyId() {
  await test('测试 6.5: 查询 API Key 用量明细（多个 key_ids）', async () => {
    if (!createdApiKeyId) {
      console.log('  跳过：需要先创建 API Key')
      return
    }

    const fakeId = 'non-existent-id-12345'
    const params = { key_ids: [createdApiKeyId, fakeId] }
    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/api-key/usage-details`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.data.keyId === 'aggregated', 'keyId 应为 aggregated')
    assert(response.data.data.period === 'last_30_days', 'period 应为 last_30_days')

    console.log(`  多 key_ids 查询明细成功`)
  })
}

/**
 * 测试 7: 查询用量明细 - 缺少 key_ids 参数
 */
async function testQueryUsageDetailsMissingParam() {
  await test('测试 7: 查询用量明细 - 缺少 key_ids 参数', async () => {
    const params = {}
    const signature = generateSignature(params)

    try {
      await axios.post(
        `${API_BASE_URL}/partner/api-key/usage-details`,
        { ...params, sign: signature },
        { headers: { 'Content-Type': 'application/json' } }
      )
      assert(false, '应该抛出错误')
    } catch (error) {
      assert(error.response.status === 400, 'HTTP 状态码应为 400')
      assert(error.response.data.code === 1001, '错误码应为 1001')
      assert(
        error.response.data.msg.includes('key_ids is required'),
        '错误信息应包含 key_ids is required'
      )
    }
  })
}

/**
 * 测试 7.2: 查询 API Key 详情
 */
async function testQueryApiKeyDetail() {
  await test('测试 7.2: 查询 API Key 详情', async () => {
    if (!createdApiKeyId) {
      console.log('  跳过：需要先创建 API Key')
      return
    }

    const params = { key_ids: [createdApiKeyId] }
    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/api-key/detail`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.msg === 'success', '响应 msg 应为 success')
    assert(typeof response.data.data === 'object', 'data 应为对象')
    assert(response.data.data[createdApiKeyId], '应包含对应 keyId 的详情')

    const keyData = response.data.data[createdApiKeyId]
    assert(keyData.keyId === createdApiKeyId, 'keyId 应匹配')
    assert(keyData.keyName === createdApiKeyName, 'keyName 应匹配')
    assert(Array.isArray(keyData.permissions), 'permissions 应为数组')
    assert(Array.isArray(keyData.rateLimits), 'rateLimits 应为数组')
    assert(Array.isArray(keyData.tags), 'tags 应为数组')
    assert(typeof keyData.serviceRates === 'object', 'serviceRates 应为对象')
    assert(keyData.packMode === 'personal', 'packMode 应为 personal')
  })
}

/**
 * 测试 7.3: 更新 API Key 过期时间
 */
async function testUpdateApiKeyExpiration() {
  await test('测试 7.3: 更新 API Key 过期时间', async () => {
    if (!createdApiKeyId) {
      console.log('  跳过：需要先创建 API Key')
      return
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const params = { expiresAt }
    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/api-key/${createdApiKeyId}/expiration`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.msg === 'success', '响应 msg 应为 success')
    assert(response.data.data.keyId === createdApiKeyId, 'keyId 应匹配')
    assert(response.data.data.keyName === createdApiKeyName, 'keyName 应匹配')

    const detailParams = { key_ids: [createdApiKeyId] }
    const detailSignature = generateSignature(detailParams)
    const detailResponse = await axios.post(
      `${API_BASE_URL}/partner/api-key/detail`,
      { ...detailParams, sign: detailSignature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    const detail = detailResponse.data.data[createdApiKeyId]
    assert(detail.expiresAt === expiresAt, 'expiresAt 应更新为指定值')
    assert(detail.isActivated === true, '更新过期时间后应标记为已激活')
  })
}

/**
 * 测试 7.5: 更新 API Key - DeepSeek 倍率与账号绑定
 */
async function testUpdateApiKeyDeepSeekConfig() {
  await test('测试 7.5: 更新 API Key - DeepSeek 倍率与账号绑定', async () => {
    if (!createdApiKeyId) {
      console.log('  跳过：需要先创建 API Key')
      return
    }

    const params = {
      deepseek_rate: 1.3
    }

    if (DEEPSEEK_ACCOUNT_ID) {
      params.deepseek_account_id = DEEPSEEK_ACCOUNT_ID
    }

    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/api-key/${createdApiKeyId}/update`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.msg === 'success', '响应 msg 应为 success')
    assert(response.data.data.keyId === createdApiKeyId, 'keyId 应匹配')

    console.log(`  DeepSeek 倍率更新为: ${params.deepseek_rate}`)
    if (DEEPSEEK_ACCOUNT_ID) {
      console.log(`  DeepSeek 绑定更新为: ${DEEPSEEK_ACCOUNT_ID}`)
    } else {
      console.log(`  未配置 PARTNER_TEST_DEEPSEEK_ACCOUNT_ID，仅测试 DeepSeek 倍率更新`)
    }
  })
}

/**
 * 测试 7.6: 更新 API Key - DeepSeek 账号不存在
 */
async function testUpdateApiKeyInvalidDeepSeekAccount() {
  await test('测试 7.6: 更新 API Key - DeepSeek 账号不存在', async () => {
    if (!createdApiKeyId) {
      console.log('  跳过：需要先创建 API Key')
      return
    }

    const params = {
      deepseek_account_id: 'non-existent-deepseek-account-id'
    }
    const signature = generateSignature(params)

    try {
      await axios.post(
        `${API_BASE_URL}/partner/api-key/${createdApiKeyId}/update`,
        { ...params, sign: signature },
        { headers: { 'Content-Type': 'application/json' } }
      )
      assert(false, '应该抛出错误')
    } catch (error) {
      assert(error.response.status === 400, 'HTTP 状态码应为 400')
      assert(error.response.data.code === 1001, '错误码应为 1001')
      assert(
        error.response.data.msg.includes('DeepSeek account'),
        '错误信息应包含 DeepSeek account'
      )
    }
  })
}

/**
 * 测试 7.7: 批量更新 API Key 配置 - DeepSeek 倍率与账号绑定
 */
async function testBatchUpdateConfigDeepSeekConfig() {
  await test('测试 7.7: 批量更新 API Key 配置 - DeepSeek 倍率与账号绑定', async () => {
    if (!createdApiKeyId) {
      console.log('  跳过：需要先创建 API Key')
      return
    }

    const params = {
      configs: [
        {
          key_id: createdApiKeyId,
          deepseek_rate: 1.4
        }
      ]
    }

    if (DEEPSEEK_ACCOUNT_ID) {
      params.deepseek_account_id = DEEPSEEK_ACCOUNT_ID
    }

    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/api-key/update-config`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.msg === 'success', '响应 msg 应为 success')
    assert(response.data.data.total === 1, '处理总数应为 1')
    assert(response.data.data.success === 1, '成功数应为 1')
    assert(response.data.data.failed === 0, '失败数应为 0')

    console.log(`  批量更新 DeepSeek 倍率为: ${params.configs[0].deepseek_rate}`)
    if (DEEPSEEK_ACCOUNT_ID) {
      console.log(`  批量更新 DeepSeek 绑定为: ${DEEPSEEK_ACCOUNT_ID}`)
    } else {
      console.log(`  未配置 PARTNER_TEST_DEEPSEEK_ACCOUNT_ID，仅测试批量 DeepSeek 倍率更新`)
    }
  })
}

/**
 * 测试 9: 批量创建企业 API Key
 */
async function testEnterpriseBatchCreate() {
  await test('测试 9: 批量创建企业 API Key', async () => {
    const enterpriseName = `EnterprisePack_${Date.now()}`
    const params = {
      keys: [
        {
          name: enterpriseName,
          externalUid: `owner_${Date.now()}`,
          memberUids: ['member_a', ' member_b ', 'member_a'],
          totalCostLimit: 500,
          dailyCostLimit: 50,
          claude_rate: 2.1
        }
      ]
    }

    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/enterprise/key/batch-create`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.msg === 'success', '响应 msg 应为 success')
    assert(response.data.data.total === 1, 'total 应为 1')
    assert(response.data.data.created === 1, 'created 应为 1')
    assert(response.data.data.failed === 0, 'failed 应为 0')
    assert(Array.isArray(response.data.data.keys), 'keys 应为数组')
    assert(response.data.data.keys.length === 1, 'keys 应返回 1 条')
    assert(Array.isArray(response.data.data.errors), 'errors 应为数组')
    assert(response.data.data.errors.length === 0, 'errors 应为空')

    const createdKey = response.data.data.keys[0]
    assert(createdKey.keyId, '应返回企业 keyId')
    assert(createdKey.keyName === enterpriseName, '企业 keyName 应匹配')
    assert(createdKey.apiKey, '应返回企业 apiKey')
    assert(createdKey.apiKey.startsWith('cr_'), '企业 apiKey 应以 cr_ 开头')
    assert(
      JSON.stringify(createdKey.memberUids) === JSON.stringify(['member_a', 'member_b']),
      'memberUids 应去重并 trim'
    )

    createdEnterpriseKeyId = createdKey.keyId
    createdEnterpriseApiKey = createdKey.apiKey

    console.log(`  创建的企业 API Key: ${createdEnterpriseApiKey}`)
  })
}

/**
 * 测试 10: 批量创建企业 API Key - 部分失败
 */
async function testEnterpriseBatchCreatePartialFailure() {
  await test('测试 10: 批量创建企业 API Key - 部分失败', async () => {
    const params = {
      keys: [
        {
          name: `EnterprisePack_Ok_${Date.now()}`,
          externalUid: `owner_ok_${Date.now()}`,
          memberUids: ['member_ok_1'],
          totalCostLimit: 100,
          claude_rate: 2.1
        },
        {
          name: `EnterprisePack_Bad_${Date.now()}`,
          externalUid: `owner_bad_${Date.now()}`,
          memberUids: [],
          totalCostLimit: 100,
          claude_rate: 2.1
        }
      ]
    }

    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/enterprise/key/batch-create`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.data.total === 2, 'total 应为 2')
    assert(response.data.data.created === 1, 'created 应为 1')
    assert(response.data.data.failed === 1, 'failed 应为 1')
    assert(response.data.data.keys.length === 1, '成功 keys 应为 1 条')
    assert(response.data.data.errors.length === 1, 'errors 应为 1 条')
    assert(response.data.data.errors[0].index === 1, '失败项 index 应为 1')
    assert(response.data.data.errors[0].name === params.keys[1].name, '失败项 name 应匹配')
    assert(
      response.data.data.errors[0].msg.includes('memberUids is required'),
      '失败原因应包含 memberUids is required'
    )
  })
}

/**
 * 测试 11: 设置企业成员（全量覆盖）
 */
async function testEnterpriseSetMembers() {
  await test('测试 11: 设置企业成员（全量覆盖）', async () => {
    if (!createdEnterpriseKeyId) {
      console.log('  跳过：需要先创建企业 API Key')
      return
    }

    const params = {
      keyId: createdEnterpriseKeyId,
      memberUids: ['member_x', ' member_y ', 'member_x']
    }

    const signature = generateSignature(params)

    const response = await axios.post(
      `${API_BASE_URL}/partner/enterprise/key/members/set`,
      { ...params, sign: signature },
      { headers: { 'Content-Type': 'application/json' } }
    )

    assert(response.status === 200, 'HTTP 状态码应为 200')
    assert(response.data.code === 0, '响应 code 应为 0')
    assert(response.data.msg === 'success', '响应 msg 应为 success')
    assert(response.data.data.keyId === createdEnterpriseKeyId, 'keyId 应匹配')
    assert(
      JSON.stringify(response.data.data.memberUids) === JSON.stringify(['member_x', 'member_y']),
      'memberUids 应全量覆盖并标准化'
    )
  })
}

/**
 * 测试 12: 设置企业成员 - 个人版 Key 不允许
 */
async function testEnterpriseSetMembersRejectPersonalKey() {
  await test('测试 12: 设置企业成员 - 个人版 Key 不允许', async () => {
    if (!createdApiKeyId) {
      console.log('  跳过：需要先创建个人 API Key')
      return
    }

    const params = {
      keyId: createdApiKeyId,
      memberUids: ['member_personal_test']
    }

    const signature = generateSignature(params)

    try {
      await axios.post(
        `${API_BASE_URL}/partner/enterprise/key/members/set`,
        { ...params, sign: signature },
        { headers: { 'Content-Type': 'application/json' } }
      )
      assert(false, '应该抛出错误')
    } catch (error) {
      assert(error.response.status === 400, 'HTTP 状态码应为 400')
      assert(error.response.data.code === 1004, '错误码应为 1004')
      assert(error.response.data.msg.includes('not enterprise edition'), '错误信息应说明不是企业版')
    }
  })
}

// ==================== 主函数 ====================

async function main() {
  console.log('='.repeat(60))
  console.log('合作伙伴 API 测试')
  console.log('='.repeat(60))
  console.log(`API 地址: ${API_BASE_URL}`)
  console.log(`密钥: ${SECRET_KEY.substring(0, 10)}...`)
  console.log(`DeepSeek 测试账户: ${DEEPSEEK_ACCOUNT_ID || '未配置，仅测试倍率和错误分支'}`)
  console.log('='.repeat(60))

  try {
    // 执行所有测试
    await testCreateApiKey()
    await testCreateApiKeyInvalidDeepSeekRate()
    await testCreateApiKeyMissingName()
    await testCreateApiKeyInvalidSignature()
    await testQueryUsage()
    await testQueryUsageByKeyId()
    await testQueryUsageNotFound()
    await testQueryUsageMissingParams()
    await testQueryUsageDetails()
    await testQueryUsageDetailsByKeyId()
    await testQueryUsageDetailsMissingParam()
    await testQueryApiKeyDetail()
    await testUpdateApiKeyExpiration()
    await testUpdateApiKeyDeepSeekConfig()
    await testUpdateApiKeyInvalidDeepSeekAccount()
    await testBatchUpdateConfigDeepSeekConfig()
    await testEnterpriseBatchCreate()
    await testEnterpriseBatchCreatePartialFailure()
    await testEnterpriseSetMembers()
    await testEnterpriseSetMembersRejectPersonalKey()

    // 输出测试结果
    console.log(`\n${'='.repeat(60)}`)
    console.log('测试结果')
    console.log('='.repeat(60))
    console.log(`总测试数: ${totalTests}`)
    console.log(`通过: ${passedTests}`)
    console.log(`失败: ${failedTests}`)
    console.log('='.repeat(60))

    if (failedTests === 0) {
      console.log('✓ 所有测试通过！')
      process.exit(0)
    } else {
      console.log('✗ 部分测试失败')
      process.exit(1)
    }
  } catch (error) {
    console.error('\n测试执行出错:', error.message)
    process.exit(1)
  }
}

// 运行测试
if (require.main === module) {
  main()
}

module.exports = {
  generateSignature,
  assert,
  test
}
