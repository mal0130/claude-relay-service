# 多 Key 自动切换方案

## 需求背景

用户在服务商处创建了多个 API Key（key1, key2, key3...），每个 Key 都有独立的额度限制。
当某个 Key 验证失败（任何原因：过期/限额/禁用等）时，系统自动切换到该用户的其他可用 Key，实现无缝使用。

## 核心问题

1. **API Key 已哈希存储**：系统中不保留明文 Key，无法在服务端直接替换
2. **用户关联**：需要知道哪些 Key 属于同一个用户
3. **查询性能**：如何快速找到同一用户的其他可用 Key

## 解决方案

### 方案架构

```
客户端配置多个 Key → 请求失败 → 服务端返回切换提示 → 客户端自动切换重试
```

### 数据结构设计

#### 1. API Key 新增字段

```javascript
{
  id: 'uuid',
  name: 'My Key',
  externalUid: 'your_uid_123',     // 新增字段：外部用户ID（对应你的库）
  // ... 其他字段
}
```

**说明**：
- `externalUid`：新增，专门用于关联你自己库的用户，支持多 Key 切换

#### 2. Redis 索引结构（新增）

```
Key: uid_keys:{externalUid}
Type: Set
Value: [keyId1, keyId2, keyId3, ...]
```

**示例**：
```
uid_keys:user_123 -> Set["key-uuid-1", "key-uuid-2", "key-uuid-3"]
```

**维护时机**：
- 创建 Key 时：`SADD uid_keys:{externalUid} {keyId}`
- 删除 Key 时：`SREM uid_keys:{externalUid} {keyId}`
- 恢复 Key 时：`SADD uid_keys:{externalUid} {keyId}`

### 验证流程改造

#### 现有流程分析

```
客户端传入 api-key (明文 cr_xxx)
    ↓
auth.js: authenticateApiKey() 中间件
    ↓
478行: apiKeyService.validateApiKey(apiKey) → 基础验证（过期、禁用、哈希匹配）
    ↓
489行: 检查客户端限制
    ↓
524行: 检查 Claude Code 限制
    ↓
569行: 检查并发限制（含排队逻辑）
    ↓
1062行: 检查时间窗口限流
    ↓
1194行: 检查每日费用限制
    ↓
1228行: 检查总费用限制
    ↓
1258行: 检查 Claude 周费用限制
    ↓
1303行: 设置 req.apiKey，继续处理请求
```

**关键发现**：
- `validateApiKey()` 只做**基础验证**（过期、禁用等）
- **费用和限流检查**在 auth.js 中间件里单独执行（1062-1301行）
- 如果在 478 行切换，会切换到可能费用超限的 Key ❌

#### 改造方案：封装完整验证函数

**在 auth.js 中新增 `validateApiKeyWithAllChecks()` 函数**，包含所有验证逻辑：

```javascript
/**
 * 完整的 API Key 验证（包含所有限制检查）
 * @param {string} apiKey - API Key 明文
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 * @returns {Promise<Object>} { valid: boolean, keyData?: Object, error?: string, statusCode?: number }
 */
async function validateApiKeyWithAllChecks(apiKey, req, res) {
  // 1. 基础验证（复用现有逻辑）
  const validation = await apiKeyService.validateApiKey(apiKey)
  if (!validation.valid) {
    return { valid: false, error: validation.error, statusCode: 401 }
  }

  const keyData = validation.keyData
  const skipKeyRestrictions = isTokenCountRequest(req)

  // 2. 检查客户端限制（489-520行逻辑）
  if (!skipKeyRestrictions && keyData.enableClientRestriction && keyData.allowedClients?.length > 0) {
    const validationResult = ClientValidator.validateRequest(keyData.allowedClients, req)
    if (!validationResult.allowed) {
      return { valid: false, error: 'Client not allowed', statusCode: 403 }
    }
  }

  // 3. 检查 Claude Code 限制（524-567行逻辑）
  // ... 省略具体实现

  // 4. 检查时间窗口限流（1062-1192行逻辑）
  const rateLimits = keyData.rateLimits || []
  if (rateLimits.length > 0) {
    // 检查每个限流规则
    for (const rule of rateLimits) {
      // ... 检查逻辑
      if (超限) {
        return { valid: false, error: 'Rate limit exceeded', statusCode: 429 }
      }
    }
  }

  // 5. 检查每日费用限制（1194-1225行逻辑）
  const dailyCostLimit = keyData.dailyCostLimit || 0
  if (dailyCostLimit > 0 && keyData.dailyCost >= dailyCostLimit) {
    return { valid: false, error: 'Daily cost limit exceeded', statusCode: 402 }
  }

  // 6. 检查总费用限制（1228-1256行逻辑）
  const totalCostLimit = keyData.totalCostLimit || 0
  if (totalCostLimit > 0 && keyData.totalCost >= totalCostLimit) {
    return { valid: false, error: 'Total cost limit exceeded', statusCode: 402 }
  }

  // 7. 检查 Claude 周费用限制（1258-1301行逻辑）
  const weeklyOpusCostLimit = keyData.weeklyOpusCostLimit || 0
  if (weeklyOpusCostLimit > 0) {
    const model = req.body?.model || ''
    if (isClaudeFamilyModel(model) && keyData.weeklyOpusCost >= weeklyOpusCostLimit) {
      return { valid: false, error: 'Weekly Claude cost limit exceeded', statusCode: 402 }
    }
  }

  // 所有检查通过
  return { valid: true, keyData }
}
```

#### 改造后流程（新增自动切换逻辑）

```
客户端传入 api-key (明文 cr_xxx)
    ↓
auth.js: authenticateApiKey() 中间件
    ↓
调用 validateApiKeyWithAllChecks(apiKey, req, res) → 完整验证
    ├─ 验证成功 → 继续处理请求（跳过并发检查，直接到 569 行）
    └─ 验证失败 → 【新增】检查是否有 externalUid
                  ├─ 无 externalUid → 返回错误（401/402/429）
                  └─ 有 externalUid → 【新增】查询该用户的其他可用 Key
                                     ↓
                                  逐个调用 validateApiKeyWithAllChecks() 验证
                                     ├─ 找到可用 Key → 切换成功，继续处理请求
                                     └─ 无可用 Key → 返回原始错误
```

**切换逻辑伪代码**：

```javascript
// 在 authenticateApiKey() 中（478 行位置）
const fullValidation = await validateApiKeyWithAllChecks(apiKey, req, res)

if (!fullValidation.valid) {
  const keyData = fullValidation.keyData || (await getKeyDataByApiKey(apiKey))

  if (keyData?.externalUid) {
    logger.api(`🔄 Validation failed, trying alternative keys for uid: ${keyData.externalUid}`)

    // 查找备用 Key
    const alternativeKey = await apiKeyService.findAlternativeKey(
      keyData.externalUid,
      [keyData.id],
      req,
      res
    )

    if (alternativeKey) {
      logger.api(`✅ Switched to alternative key: ${alternativeKey.id}`)
      // 用备用 Key 继续后续流程
      req.apiKey = { ...alternativeKey, ... }
      return next()
    }
  }

  // 无备用 Key，返回错误
  return res.status(fullValidation.statusCode).json({
    error: fullValidation.error,
    message: fullValidation.message
  })
}

// 验证成功，继续后续流程（569 行并发检查）
```

**关键改动点**：
1. ✅ 封装 `validateApiKeyWithAllChecks()` 包含所有验证逻辑
2. ✅ 验证失败时，如果有 `externalUid`，自动查找备用 Key
3. ✅ 备用 Key 也要经过 `validateApiKeyWithAllChecks()` 完整验证
4. ✅ 找到可用 Key 后，直接跳到并发检查（569 行），避免重复验证
5. ✅ 响应格式保持不变，客户端无需改动

### API 响应格式

**保持不变**：无论是否切换 Key，响应格式都与现有系统一致。

#### 验证失败响应（统一格式）

```json
{
  "error": "Invalid API key",
  "message": "API key has expired"
}
```

**说明**：
- ✅ 客户端无需改动，响应格式完全兼容
- ✅ 自动切换对客户端透明，无感知
- ✅ 如果切换成功，请求正常处理；如果切换失败，返回 401 错误

## 客户端实现

### 无需改动

**关键优势**：客户端完全无需改动，自动切换对客户端透明。

```javascript
// 客户端代码保持不变
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'cr_key1_xxxxxxxxxx' // 只需配置一个 key
  },
  body: JSON.stringify(body)
})

// 如果 key1 失效，服务端自动切换到同 externalUid 的其他可用 key
// 客户端无感知，请求正常返回
```


**说明**：
- 服务端自动切换是第一层保护
- 两层保护可以同时存在，互不影响

## 优势分析

### 1. 安全性
- ✅ 不存储明文 Key
- ✅ 不在响应中返回明文 Key
- ✅ 切换过程完全在服务端，客户端无感知

### 2. 性能
- ✅ Redis Set 查询 O(1) 复杂度
- ✅ 逐个检查 Key，找到第一个可用的就返回（避免批量查询）
- ✅ 只在验证失败时才查询备用 Key

### 3. 兼容性
- ✅ 不影响现有 `userId` 字段
- ✅ `externalUid` 为空时，行为与现在完全一致
- ✅ 客户端无需改动，响应格式保持不变
- ✅ 向后兼容，现有 Key 不受影响

### 4. 可维护性
- ✅ 改动集中在 `apiKeyService.js` 和 `auth.js`
- ✅ Redis 索引自动维护
- ✅ 代码量小，逻辑清晰
- ✅ 日志记录切换行为，便于追踪

## 数据迁移

### 现有 Key 的处理

现有 Key 的 `externalUid` 为空，不影响使用。如需启用多 Key 切换：

1. 通过管理后台或 API 更新 Key 的 `externalUid`
2. 系统自动维护 Redis 索引


## 注意事项
1. **Key 的顺序**：应按优先级配置 Key（如按创建时间）
2. **索引一致性**：删除/恢复 Key 时必须同步更新索引

## 总结

此方案通过新增 `externalUid` 字段和 Redis 索引 `uid_keys:{externalUid}`，实现了服务端自动切换 Key 的功能。

### 核心特点

1. **服务端自动切换**：验证失败时，自动查找同 `externalUid` 的其他可用 Key 并切换
2. **客户端无感知**：响应格式保持不变，客户端无需改动
3. **完整限制检查**：包括过期、费用限制、窗口限制等所有验证逻辑
4. **性能优化**：逐个检查，找到第一个可用的就返回
5. **向后兼容**：`externalUid` 为空时，行为与现有系统完全一致

### 实现要点

#### 1. 数据层改动（redis.js）

```javascript
// 新增 externalUid 字段到 API Key 数据结构
// 新增 Redis 索引维护方法
async addKeyToUidIndex(externalUid, keyId)
async removeKeyFromUidIndex(externalUid, keyId)
async getKeysByUid(externalUid) // 返回 Set[keyId1, keyId2...]
```

#### 2. 业务逻辑层改动（apiKeyService.js）

```javascript
// 修改现有方法，维护索引
createApiKey() // 创建时：SADD uid_keys:{externalUid} {keyId}
deleteApiKey() // 删除时：SREM uid_keys:{externalUid} {keyId}
restoreApiKey() // 恢复时：SADD uid_keys:{externalUid} {keyId}
updateApiKey() // 更新 externalUid 时：先 SREM 旧索引，再 SADD 新索引

// 新增方法
async findAlternativeKey(externalUid, excludeKeyIds, req, res) {
  // 1. 获取该 uid 的所有 Key ID
  const keyIds = await redis.getKeysByUid(externalUid)

  // 2. 逐个检查（排除已尝试的）
  for (const keyId of keyIds) {
    if (excludeKeyIds.includes(keyId)) continue

    const keyData = await redis.getApiKey(keyId)

    // 3. 调用 auth.js 的 validateApiKeyWithAllChecks() 完整验证
    const validation = await validateApiKeyWithAllChecks(keyData.hash, req, res)

    // 4. 找到第一个可用的就返回
    if (validation.valid) {
      return validation.keyData
    }
  }

  return null
}
```

#### 3. 认证层改动（auth.js）

```javascript
// 新增完整验证函数
async function validateApiKeyWithAllChecks(apiKey, req, res) {
  // 包含所有验证逻辑：
  // - 基础验证（过期、禁用）
  // - 客户端限制
  // - Claude Code 限制
  // - 时间窗口限流
  // - 每日费用限制
  // - 总费用限制
  // - Claude 周费用限制

  return { valid: boolean, keyData?: Object, error?: string, statusCode?: number }
}

// 修改 authenticateApiKey() 中间件
async function authenticateApiKey(req, res, next) {
  const apiKey = extractApiKey(req)

  // 完整验证
  const validation = await validateApiKeyWithAllChecks(apiKey, req, res)

  if (!validation.valid) {
    // 尝试切换
    const keyData = await getKeyDataByApiKey(apiKey)

    if (keyData?.externalUid) {
      const altKey = await apiKeyService.findAlternativeKey(
        keyData.externalUid,
        [keyData.id],
        req,
        res
      )

      if (altKey) {
        // 切换成功，继续处理
        req.apiKey = altKey
        return next()
      }
    }

    // 切换失败，返回错误
    return res.status(validation.statusCode).json({ error: validation.error })
  }

  // 验证成功，继续并发检查（569 行）
  req.apiKey = validation.keyData
  // ... 并发检查逻辑
}
```

#### 4. 管理接口改动（admin/apiKeys.js）

```javascript
// 创建/更新接口支持 externalUid 字段
POST /admin/api-keys
PUT /admin/api-keys/:id

// 请求体新增字段
{
  "externalUid": "user_123" // 可选
}
```

#### 5. 前端界面改动（ApiKeys.vue）

```vue
<!-- 新增 externalUid 输入框 -->
<el-form-item label="外部用户ID">
  <el-input v-model="form.externalUid" placeholder="用于多Key切换" />
</el-form-item>

<!-- 表格新增列 -->
<el-table-column prop="externalUid" label="外部用户ID" />
```

#### 改动文件清单

| 文件 | 改动内容 | 复杂度 |
|------|---------|--------|
| `src/models/redis.js` | 新增 3 个索引维护方法 | 低 |
| `src/services/apiKeyService.js` | 修改 4 个方法 + 新增 1 个方法 | 中 |
| `src/middleware/auth.js` | 新增 1 个函数 + 修改 1 个中间件 | 高 |
| `src/routes/admin/apiKeys.js` | 修改 2 个路由支持新字段 | 低 |
| `web/admin-spa/src/views/ApiKeys.vue` | 新增字段展示和编辑 | 低 |

**总计**：5 个文件

### 使用场景

适用于需要为同一用户配置多个 Key，当某个 Key 失效时自动切换到备用 Key，实现无缝体验。
