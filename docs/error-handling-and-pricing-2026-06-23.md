# 错误处理、计费修正与定价抓取 — 详细技术文档（2026-06-23）

> 本文档面向「在其他项目中重写这些功能」的场景，每个模块都给出设计思路、数据结构、核心伪代码和注意事项。
> 源码位置标注在每节末尾，方便对照。

---

## 目录

1. [错误码白名单体系（errorSanitizer）](#1-错误码白名单体系errorsanitizer)
2. [上游错误处理与账户临时不可用管理（upstreamErrorHelper）](#2-上游错误处理与账户临时不可用管理upstreamerrorhelper)
3. [计费类错误检测（isRelayBillingError）](#3-计费类错误检测isrelaybillingerror)
4. [Relay 错误响应统一清洗（sanitizeRelayErrorResponse）](#4-relay-错误响应统一清洗sanitizerelayerrorresponse)
5. [OpenAI 路由流式错误体解析与清洗](#5-openai-路由流式错误体解析与清洗)
6. [server_is_overloaded 流式替换实现](#6-server_is_overloaded-流式替换实现)
7. [计费模型修正（requestedModel 作为计费模型）](#7-计费模型修正requestedmodel-作为计费模型)
8. [GLM 定价抓取（HTML 表格解析 + 分层定价）](#8-glm-定价抓取html-表格解析--分层定价)
9. [多平台价格镜像生成脚本](#9-多平台价格镜像生成脚本)
10. [各 Relay 服务的统一错误处理模式](#10-各-relay-服务的统一错误处理模式)
11. [近期补充：过载限流、额度耗尽与安全清洗](#11-近期补充过载限流额度耗尽与安全清洗)

---

## 1. 错误码白名单体系（errorSanitizer）

### 设计思路

所有上游返回的原始错误消息**不直接暴露给客户端**，而是通过白名单错误码制度映射到预定义的标准错误码。原始消息只写日志，不返回前端。

### 数据结构

```
ERROR_CODES = {
  E001: { message: 'Service temporarily unavailable', status: 503 },
  E002: { message: 'Network connection failed',       status: 502 },
  E003: { message: 'Authentication failed',            status: 401 },
  E004: { message: 'Rate limit exceeded',              status: 429 },
  E005: { message: 'Invalid request',                  status: 400 },
  E006: { message: 'Model not available',              status: 503 },
  E007: { message: 'Upstream service error',           status: 502 },
  E008: { message: 'Request timeout',                  status: 504 },
  E009: { message: 'Permission denied',                status: 403 },
  E010: { message: 'Resource not found',               status: 404 },
  E011: { message: 'Account temporarily unavailable',  status: 503 },
  E012: { message: 'Server overloaded',                status: 529 },
  E013: { message: 'Invalid API key',                  status: 401 },
  E014: { message: 'Quota exceeded',                   status: 429 },
  E015: { message: 'Internal server error',            status: 500 },
  E016: { message: 'Prompt is too long',               status: 413 }  // ← 新增
}
```

### 三层匹配逻辑

错误匹配按优先级执行，后面的层可以覆盖前面的结果：

```
第一层：HTTP 状态码快速匹配
  401 → E003, 403 → E009, 404 → E010, 429 → E004,
  502 → E007, 503 → E001, 504 → E008, 529 → E012

第二层：消息内容正则匹配（ERROR_MATCHERS 数组，按顺序匹配）
  - 网络层: ENOTFOUND/ECONNREFUSED/ECONNRESET → E002, ETIMEDOUT → E008
  - 认证: unauthorized/invalid.*token → E003, invalid.*api.*key → E013
  - 权限: forbidden/permission.*denied → E009
  - 限流: rate.*limit/too many requests → E004, quota.*exceeded → E014
  - 过载: overloaded/529/capacity → E012
  - 账户: account.*disabled → E011, subscription.*expired → E011
  - 计费: 余额不足/欠费/充值/insufficient_balance → E011
  - 模型: model.*not.*found/unsupported.*model → E006
  - 上下文超长: prompt is too long/too many tokens/exceeds.*token.*limit → E016  // ← 新增
  - 请求: bad.*request/invalid.*argument → E005, not.*found/404 → E010
  - 上游: upstream/502/bad.*gateway → E007, 503/service.*unavailable → E001

第三层：错误 code 字段匹配（网络错误码）
  ENOTFOUND/EAI_AGAIN → E002
  ECONNREFUSED/ECONNRESET → E002
  ETIMEDOUT/ESOCKETTIMEDOUT → E008
  ECONNABORTED → E002
```

### 核心函数签名

```javascript
// 主匹配函数
mapToErrorCode(error, { context, logOriginal }) → { code, message, status }

// 提取原始错误消息（支持多种格式）
extractOriginalMessage(error) → string
  // 支持的格式: string / Error.message / error.error.message /
  //             error.response.data.error.message / error.response.data.message

// 输出格式
createSafeErrorResponse(error, options) → { error: { code, message }, status }
createSafeSSEError(error, options) → "event: error\ndata: {...}\n\n"
getSafeMessage(error, options) → string  // 仅返回安全消息字符串

// 账户禁用检测（特殊：检查 400 状态码）
isAccountDisabledError(statusCode, body) → boolean
  // 检测: organization/account disabled, subscription expired,
  //       too many active sessions, invalid account
```

### 账户不可用模式检测

两个关键正则：

```
ACCOUNT_TEMP_UNAVAILABLE_PATTERN（账户临时不可用）:
  /chatgpt account|codex with a chatgpt account|
   subscription.*expired|expired.*subscription|
   plan.*expired|expired.*plan|
   account.*expired|expired.*account|
   workspace.*expired|expired.*workspace/i

ACCOUNT_BILLING_UNAVAILABLE_PATTERN（账户计费不可用，中英双语）:
  /余额不足|账户余额不足|可用额度不足|余额已用尽|免费额度已用尽|
   欠费|请充值|充值后|
   insufficient(?:\s+\w+){0,2}\s+(?:balance|credit)|
   out of(?:\s+\w+){0,2}\s+credit|
   credit(?:\s+\w+){0,2}\s+exhausted|
   no[_\s-]*free[_\s-]*package|
   free[_\s-]*quota[_\s-]*exhausted|
   billing[_\s-]*isolated|recharge/i
```

> 源码: `src/utils/errorSanitizer.js`

---

## 2. 上游错误处理与账户临时不可用管理（upstreamErrorHelper）

### 设计思路

当上游 API 返回错误时，系统需要：
1. 判断错误类型
2. 按错误类型决定账户暂停时长
3. 记录错误历史
4. 在暂停期内跳过该账户

### 错误分类与默认 TTL

```
classifyError(statusCode, responseBody) → errorType

  529           → 'overload'            (TTL: 600s = 10分钟)
  503           → 'service_unavailable' (TTL: 60s  = 1分钟)
  504           → 'timeout'             (TTL: 300s = 5分钟)
  401/403       → 'auth_error'          (TTL: 1800s = 30分钟)
  429           → 'rate_limit'          (TTL: 300s = 5分钟，优先用响应头解析值)
  >= 500        → 'server_error'        (TTL: 300s = 5分钟)
  计费类错误     → 'service_unavailable' (走 503 的 TTL)

  其他          → null (不暂停)
```

### Redis 数据结构

```
# 临时不可用状态
key:   temp_unavailable:{accountType}:{accountId}
value: JSON.stringify({
  statusCode, errorType, markedAt, ttlSeconds,
  cooldownSeconds, expiresAt
})
TTL:   按错误类型设置

# 错误历史
key:   error_history:{accountType}:{accountId}
type:  Redis List
max:   5000 条
TTL:   3 天
value: JSON.stringify({ time, status, errorType, context: { errorBody: 截断2000字符 } })
```

### 账号级策略覆盖

账户可以配置以下字段来覆盖默认 TTL：

```
disableTempUnavailable: true   → 完全禁用临时暂停
ttl503Seconds: 120             → 503 错误的 TTL 覆盖为 120s（设为 0 或负数 = 禁用 503 暂停）
ttl5xxSeconds: 600             → 5xx 错误的 TTL 覆盖为 600s（设为 0 或负数 = 禁用 5xx 暂停）
```

策略解析逻辑：

```javascript
resolveAccountTtlOverride({ policy, statusCode, errorType }) → { skip, ttlOverrideSeconds, reason }

if (policy.disableTempUnavailable) → skip = true
if (statusCode === 503 && policy.ttl503Seconds !== null):
  if (ttl503Seconds <= 0) → skip = true
  else → ttlOverrideSeconds = ttl503Seconds
if (errorType === 'server_error' && policy.ttl5xxSeconds !== null):
  if (ttl5xxSeconds <= 0) → skip = true
  else → ttlOverrideSeconds = ttl5xxSeconds
```

### markTempUnavailable 完整流程

```
1. classifyError(statusCode, context.response) → errorType
   如果 errorType 为 null → 直接返回 { success: false, reason: 'not_a_pausable_error' }

2. 读取账号级策略 getAccountTempUnavailablePolicy(accountId, accountType)
   → 如果 disableTempUnavailable → 删除现有 key，返回 { skipped: true }

3. 计算 TTL:
   - 优先使用 customTtl（如 429 的 resets_in_seconds）
   - 其次使用账号级 override
   - 最后使用默认 TTL

4. 写入 Redis: SETEX key ttl JSON.stringify({...})

5. 异步记录错误历史: LPUSH + LTRIM + EXPIRE

6. 返回 { success: true, ttlSeconds, errorType, expiresAt }
```

### isTempUnavailable 自愈机制

```
TTL = -2 → key 不存在 → 返回 false
TTL = -1 → key 存在但无 TTL（异常状态）→ 自动 DEL，返回 false
TTL > 0  → 返回 true
```

### getAllTempUnavailable 批量查询

用于前端展示所有暂停中的账户。遍历 `temp_unavailable:*`，对每个 key 执行 GET + TTL，同时自愈清理无 TTL 的异常键。

### 429 重置时间解析

```javascript
parseRetryAfter(headers) → seconds | null

// 支持三种格式：
1. 标准 Retry-After 头（秒数或 HTTP 日期）
2. Anthropic: anthropic-ratelimit-unified-reset（ISO 时间）
3. OpenAI/Codex: x-ratelimit-reset-requests / x-codex-ratelimit-reset（秒数）
```

### 账号额度耗尽保护

部分上游会用 `429` 表达“账号额度耗尽”，这和普通短期限流不是同一类问题。当前实现用
`isAccountQuotaExceededError()` 单独识别：

- 状态码必须是 `429`
- 错误码匹配 `AccountQuotaExceeded`
- 或错误消息匹配 `exceeded ... usage quota`

命中后应调用 `markAccountQuotaExceededWithService()`：

1. 如果账号开启 `disableAutoProtection`，只记录错误历史，不停用账号
2. 否则更新账号为 `status: 'quotaExceeded'`、`schedulable: 'false'`
3. 写入 `quotaStoppedAt` 和可解析到的 `providerQuotaResetAt`
4. 清空普通限流字段：`rateLimitedAt`、`rateLimitStatus`、`rateLimitResetAt`
5. 记录 `error_history:{accountType}:{accountId}`，类型为 `quota_exceeded`

调度器下次检查账号时会调用 `checkAndClearQuotaExceededWithService()`。如果
`providerQuotaResetAt` 已到期，账号会恢复为 `active` 且重新允许调度；未到期则继续跳过。

### 全局配置项

全局 TTL 在 `config.upstreamError` 中配置，也可用环境变量覆盖：

| 配置 | 环境变量 | 默认值 |
| ---- | -------- | ------ |
| `serviceUnavailableTtlSeconds` | `UPSTREAM_ERROR_503_TTL_SECONDS` | `60` |
| `serverErrorTtlSeconds` | `UPSTREAM_ERROR_5XX_TTL_SECONDS` | `300` |
| `overloadTtlSeconds` | `UPSTREAM_ERROR_OVERLOAD_TTL_SECONDS` | `600` |
| `authErrorTtlSeconds` | `UPSTREAM_ERROR_AUTH_TTL_SECONDS` | `1800` |
| `timeoutTtlSeconds` | `UPSTREAM_ERROR_TIMEOUT_TTL_SECONDS` | `300` |

> 源码: `src/utils/upstreamErrorHelper.js`

---

## 3. 计费类错误检测（isRelayBillingError）

### 背景

第三方平台（DeepSeek/GLM/Kimi/MiniMax）在账户余额不足时会返回各种格式的错误，需要统一检测，触发账户自动暂停。

### 检测逻辑

```javascript
isRelayBillingError(status, errorData, fallbackError = null) → boolean

// 第一层：HTTP 402 直接判定为计费错误
if (status === 402) return true

// 第二层：递归遍历错误对象，提取所有文本 token
const tokens = [
  ...collectRelayErrorTokens(errorData),
  ...collectRelayErrorTokens(fallbackError)
]

// 第三层：对每个 token 做两种正则匹配
return tokens.some(token =>
  RELAY_BILLING_ERROR_CODE_PATTERN.test(token) ||
  RELAY_BILLING_ERROR_MESSAGE_PATTERN.test(token)
)
```

### 递归 Token 提取

```javascript
collectRelayErrorTokens(errorData) → string[]

// 递归遍历对象/数组，提取以下字段的文本值：
// message, detail, code, type, error, errors
// 防止循环引用（使用 visited Set）
```

### 匹配正则

```
错误码匹配（精确匹配）:
  /^(401007|401008|403004|
     insufficient_balance|insufficient_credit|credit_exhausted|
     billing_isolated|no_free_package|free_quota_exhausted)$/i

消息匹配（模糊匹配，中英双语）:
  /余额不足|账户余额不足|可用额度不足|余额已用尽|免费额度已用尽|
   欠费|请充值|充值后|
   insufficient(?:\s+\w+){0,2}\s+(?:balance|credit)|
   out of(?:\s+\w+){0,2}\s+credit|
   credit(?:\s+\w+){0,2}\s+exhausted|
   no[_\s-]*free[_\s-]*package|
   free[_\s-]*quota[_\s-]*exhausted|
   billing[_\s-]*isolated|recharge/i
```

### 检测到计费错误后的动作

```javascript
// 在 relay 服务的 _handleUpstreamStatus 中：
if (isRelayBillingError(status, responseBody)) {
  // 1. 标记账户临时不可用（走 service_unavailable 的 TTL = 60s）
  await markTempUnavailable(accountId, accountType, status, null, {
    response: responseBody
  })
  // 2. 清除粘性会话映射，让下次请求选其他账户
  await scheduler.clearSessionMapping(sessionHash)
  return
}
```

> 源码: `src/utils/upstreamErrorHelper.js:76-209`, `src/services/relay/deepseekRelayService.js:1048-1087`

---

## 4. Relay 错误响应统一清洗（sanitizeRelayErrorResponse）

### 设计思路

各平台 relay 服务返回给客户端的错误响应，统一经过清洗：
- 计费类错误 → 使用固定安全消息（"Account temporarily unavailable"）
- 非计费类错误 → 根据状态码和消息内容匹配安全消息
- 原始错误消息不暴露给客户端

### 处理流程

```
sanitizeRelayErrorResponse(status, errorData, fallbackError) → { error: { message, ... } }

1. 确定 source = errorData || fallbackError || { error: { message: getSafeMessage(...) } }

2. 检测是否计费类错误: billingRelated = isRelayBillingError(status, source, fallbackError)

3. 清洗错误数据: sanitized = sanitizeErrorForClient(source)
   - 去除内部路由标识（如 [codex/codex]）
   - 将所有消息替换为安全消息（通过 getSafeMessage）
   - 兼容 FastAPI detail 字段 → 转成 { error: { message } }

4. 确定安全消息:
   if (billingRelated) → RELAY_BILLING_SAFE_MESSAGE = "Account temporarily unavailable"
   else → getSafeMessage(source)  // 走 errorSanitizer 的三层匹配

5. 特殊处理：如果非计费类且消息是默认的 E015 "Internal server error"，
   但状态码能匹配到更具体的消息 → 使用状态码匹配的消息

6. ensureRelayErrorShape(sanitized, safeMessage)
   确保返回值有标准 { error: { message } } 结构
```

### sanitizeErrorForClient 细节

```javascript
// 输入可能是：string / Error / object
// 处理步骤：
1. 如果是 string → { error: { message: getSafeMessage(string) } }
2. 如果是 object:
   a. JSON.stringify → 正则去除 [xxx/xxx] 内部路由标识
   b. JSON.parse 回来
   c. 如果 error 是 string → 转成 { error: { message } }
   d. 如果 error.message 存在 → 替换为 getSafeMessage(error.message)
   e. 如果 message 存在 → 替换为 getSafeMessage(message)
   f. 如果只有 detail 字段（FastAPI 风格）→ 转成 { error: { message } }
```

### ensureRelayErrorShape

```javascript
// 确保返回值始终有 { error: { message } } 结构
// 处理各种异常输入：
// - null/undefined/Buffer → { error: { message: safeMessage } }
// - error 是 string → { ...rest, error: { message: safeMessage } }
// - error 是 object → { ...rest, error: { ...error, message: safeMessage } }
// - 只有 message 字段 → { ...rest, error: { message: safeMessage } }
// - 其他 → { ...rest, error: { message: safeMessage } }
```

> 源码: `src/utils/upstreamErrorHelper.js:554-687`

---

## 5. OpenAI 路由流式错误体解析与清洗

### 问题背景

当客户端发起流式请求（stream: true），上游返回 4xx/5xx 错误时，响应体是一个 **stream**（而不是 JSON）。之前代码直接丢弃了这个错误流，导致客户端收到空错误。

### 解决方案

新增两个函数：

#### parseUpstreamErrorPayload

```javascript
function parseUpstreamErrorPayload(rawBody = '') {
  // 尝试从 SSE 格式中提取 JSON
  if (rawBody.includes('data: ')) {
    for (const line of rawBody.split('\n')) {
      if (!line.startsWith('data: ')) continue
      const jsonStr = line.slice(6).trim()
      if (!jsonStr || jsonStr === '[DONE]') continue
      try { return JSON.parse(jsonStr) } catch { continue }
    }
  }
  // 尝试直接 JSON.parse
  try { return JSON.parse(rawBody) } catch { return rawBody }
}
```

#### resolveStreamErrorPayload

```javascript
async function resolveStreamErrorPayload(stream, timeoutMs = 5000) {
  // 收集 stream 的所有 chunk（带超时保护）
  const chunks = []
  await new Promise((resolve) => {
    let settled = false
    const finish = () => { if (!settled) { settled = true; ...; resolve() } }
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('end', finish)
    stream.on('error', finish)
    setTimeout(finish, timeoutMs)  // 超时保护
  })

  const rawBody = Buffer.concat(chunks).toString()
  return { rawBody, parsedBody: parseUpstreamErrorPayload(rawBody) }
}
```

### 在路由中的使用

```javascript
// openaiRoutes.js handleResponses 中
if (isStream && upstream.status >= 400 && upstream.data?.on) {
  const { rawBody, parsedBody } = await resolveStreamErrorPayload(upstream.data)
  resolvedStreamErrorRawBody = rawBody
  resolvedStreamErrorPayload = parsedBody
}

// 然后根据状态码分支处理：
// - 429: 解析 resets_in_seconds，标记限流，返回清洗后的错误
// - 401/402: 标记 unauthorized，返回清洗后的错误
// - 其他 4xx/5xx: 返回清洗后的错误
```

### sanitizeOpenAIErrorResponse

在通用清洗基础上，对 401/402 额外补充：

```javascript
function sanitizeOpenAIErrorResponse(status, errorData, fallbackError) {
  const sanitized = sanitizeErrorForClient(source)

  // 如果清洗后没有有效消息 → 用 fallbackError 或 detail 字段
  if (!hasSanitizedMessage) {
    return { error: { message: getSafeMessage(safeMessageSource) } }
  }

  // 401/402 额外处理
  if (status === 401 || status === 402) {
    if (message 是 'Internal server error') → 替换为状态码匹配的安全消息
    补充 error.type = 'unauthorized' | 'payment_required'
    补充 error.code = 'unauthorized' | 'payment_required'
  }

  return sanitized
}
```

### sendSanitizedStreamErrorResponse

```javascript
function sendSanitizedStreamErrorResponse(res, status, errorPayload, headers) {
  res.status(status)
  const contentType = headers['content-type'] || 'application/json'
  const shouldUseSse = contentType.includes('text/event-stream')

  if (shouldUseSse) {
    // 上游是 SSE → 也用 SSE 返回
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.write(`data: ${JSON.stringify(errorPayload)}\n\n`)
    res.end()
  } else {
    // 上游是 JSON → 用 JSON 返回
    res.setHeader('Content-Type', 'application/json')
    res.json(errorPayload)
  }
}
```

> 源码: `src/routes/openaiRoutes.js:128-288, 694-881`

---

## 6. server_is_overloaded 流式替换实现

### 问题背景

OpenAI Codex 上游在服务过载时，会在 SSE 流中返回 `error.code === 'server_is_overloaded'`。原始错误消息对用户不友好，需要替换为中文提示。

### 实现细节

在流式响应的 `data` 事件处理中：

```javascript
upstream.data.on('data', (chunk) => {
  try {
    // 1. 先用 SSE parser 解析 chunk
    const events = sseParser.feed(chunk.toString())
    let overloaded = false

    for (const event of events) {
      if (event.type === 'data' && event.data) {
        processSSEEvent(event.data)  // 正常处理（捕获 usage 等）
        // 2. 检测过载错误
        if (event.data?.error?.code === 'server_is_overloaded') {
          overloaded = true
        }
      }
    }

    // 3. 如果检测到过载 → 替换为友好提示，终止流
    if (!res.destroyed) {
      if (overloaded) {
        const friendly = {
          type: 'error',
          sequence_number: 0,
          error: {
            message:
              '由于 AI 模型厂商（上游服务商）目前的算力受限，导致本次请求未能成功。' +
              '建议按如下方案尝试解决：1. 点击"重试"或开启新会话；' +
              '2. 切换成聚合中转或DeepSeek等模型重试。' +
              '切换模型参考文档：https://uniapp.dcloud.net.cn/ai/uni-agent.html#intelligencelevel',
            type: 'server_error',
            code: 'server_is_overloaded',
            param: null
          }
        }
        logger.warn('⚠️ OpenAI server_is_overloaded raw chunk...', { raw: chunk.toString() })
        res.write(`data: ${JSON.stringify(friendly)}\n\n`)
        streamEnded = true
        res.end()
        upstream.data.destroy()  // 终止上游流
        return
      } else {
        // 4. 正常情况 → 透传 chunk
        res.write(chunk)
      }
    }
  } catch (error) {
    logger.error('Error processing OpenAI stream chunk:', error)
  }
})
```

### 关键设计点

1. **先解析再透传**：每个 chunk 先经过 SSE parser 解析，检测是否包含过载错误，再决定透传还是替换
2. **替换后立即终止**：检测到过载后，写入友好提示，立即 `res.end()` + `upstream.data.destroy()`，不再透传后续数据
3. **保留原始日志**：过载时的原始 chunk 会写入 warn 日志，便于排查
4. **processSSEEvent 中的补充检测**：在事件处理函数中也会记录过载日志，但不做替换（替换在 data 事件中统一处理）

### 过载后的账号临时限流

2026-06-30 之后，OpenAI/Codex 流式响应命中 `server_is_overloaded` 时，不只是替换友好错误，
还会把当前 OpenAI 账号临时限流一段时间：

```javascript
unifiedOpenAIScheduler.markAccountRateLimited(
  accountId,
  'openai',
  sessionHash,
  (config.openai?.serverOverloadRateLimitMinutes || 3) * 60
)
```

关键行为：

- 默认限流 `3` 分钟，可通过 `OPENAI_SERVER_OVERLOAD_RATE_LIMIT_MINUTES` 配置
- 复用 OpenAI 429 的 `markAccountRateLimited()` 逻辑，避免新建一套状态
- 传入 `sessionHash`，所以会清理当前粘性会话映射，下一次请求可重新选账号
- 这里是 best-effort 异步操作；Redis 写失败只打错误日志，不影响已经写给客户端的友好 SSE 错误
- 设置动作发生在 `res.write(friendly)` / `res.end()` 之前发起，但代码不等待 Redis 完成

迁移到其他项目时，只需要在流式过载检测分支复用已有 429 限流方法，并把限流时长做成独立配置。

### 非流式场景

非流式场景中不涉及 `server_is_overloaded`（过载错误只在流中出现），非流式错误走统一的 `sanitizeOpenAIErrorResponse` 清洗。

> 源码: `src/routes/openaiRoutes.js:1108-1159`

---

## 7. 计费模型修正（requestedModel 作为计费模型）

### 问题背景

用户请求中传入的模型名（如 `glm-4.6`）经过账户级模型映射后，发给上游的可能是另一个模型名（如 `glm-4`）。上游返回的 `response.model` 也可能是免费模型名（如 `deepseek-chat`），导致计费时价格查不到或费用为 0。

### 解决方案

所有 relay 服务的 `_recordUsage` 方法统一使用 `billingModel = requestedModel || model` 作为计费模型：

```javascript
// glmRelayService.js _recordUsage
async _recordUsage(req, options) {
  const { usage, body, model, accountId, sessionHash, stream,
          statusCode, protocol, assistantContent, requestedModel } = options

  // ★ 关键：计费使用请求模型（用户配置的），避免上游返回免费模型导致费用为0
  const billingModel = requestedModel || model

  logger.info(
    `💰 GLM billing decision requestedModel=${requestedModel} ` +
    `actualModel=${model} billingModel=${billingModel} stream=${stream}`
  )

  const costs = await apiKeyService.recordUsageWithDetails(
    req.apiKey.id,
    normalizedUsage,
    billingModel,    // ★ 使用 billingModel 而非 model
    accountId,
    'glm',
    usageExtra,
    createRequestDetailMeta(req, { requestBody: body, stream, statusCode })
  )

  await updateRateLimitCounters(
    req.rateLimitInfo,
    { inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens },
    billingModel,    // ★ 限流计数也使用 billingModel
    req.apiKey.id,
    'glm',
    costs
  )
}
```

### 四个平台的统一模式

| 平台 | requestedModel 来源 | 计费字段 |
|------|-------------------|---------|
| DeepSeek | `this._normalizeRequestModel(req.body?.model)` | `model`（DeepSeek 没有单独的 billingModel，直接用 requestedModel） |
| GLM | 同上 | `billingModel = requestedModel || model` |
| Kimi | 同上 | `billingModel = requestedModel || model` |
| MiniMax | 同上 | `billingModel = requestedModel || model` |

### GLM 额外日志

GLM 在两个位置记录模型对应关系日志：

```javascript
// 非流式完成后
logger.info(
  `🧾 GLM completion models requestedModel=${requestedModel} ` +
  `actualModel=${model} billingModel=${requestedModel || model} ` +
  `accountId=${accountId}`
)

// _recordUsage 中
logger.info(
  `💰 GLM billing decision requestedModel=${requestedModel} ` +
  `actualModel=${model} billingModel=${billingModel} stream=${stream}`
)
```

> 源码: `src/services/relay/glmRelayService.js:987-1058`, 其他 relay 服务同理

---

## 8. GLM 定价抓取（HTML 表格解析 + 分层定价）

### 整体架构

```
GLM 定价来源优先级:
  1. 从官方文档 HTML 抓取（parseGlmPricingHtml）
  2. 内置兜底价格（getGlmFallbackPricing）
  3. headless 浏览器渲染兜底（当 HTML 不含表格时）
```

### 远程模型映射（精简后只抓最新模型）

```javascript
const GLM_REMOTE_MODEL_MAPPINGS = [
  { label: 'GLM-5.2',    key: 'glm-5.2' },
  { label: 'GLM-5.1',    key: 'glm-5.1' },
  { label: 'GLM-5-Turbo', key: 'glm-5-turbo' },
  { label: 'GLM-5',      key: 'glm-5' },
  { label: 'GLM-4.7',    key: 'glm-4.7' }
]
```

### HTML 表格解析（处理 rowspan/colspan）

`_extractGlmTableRows` 是核心，处理 HTML 表格中复杂的合并单元格：

```javascript
_extractGlmTableRows(html) → string[][]

// 算法：
// 1. 用正则匹配所有 <tr>...</tr>
// 2. 对每行，用正则匹配所有 <td>/<th>（带属性）
// 3. 维护一个 carryCells 数组，记录跨行单元格的剩余行数
// 4. 对每个单元格：
//    a. 先填充 carryCells 中剩余 > 0 的位置（跨行继承）
//    b. 解析 rowspan 和 colspan
//    c. 填充 colspan 个位置
//    d. 如果 rowspan > 1，在 carryCells 中记录
// 5. 返回二维数组，每个元素是单元格的 HTML 内容
```

### 价格行提取

```javascript
_extractGlmPriceRows(html, modelLabel) → string[][]

// 从所有表格行中，筛选出第一列匹配 modelLabel 的行
// 匹配规则: labelCell.toUpperCase() === targetLabel
//          || labelCell.startsWith(targetLabel + ' ')
```

### 价格单元格解析

```javascript
_parseGlmPriceCell(cellHtml) → number | null

// 1. 如果包含 "free" 或 "免费" → 返回 0
// 2. 尝试提取 USD 价格（extractUsdPrices）
// 3. 尝试提取数字
```

### 分层条件规范化

`_canonicalizeGlmTierCondition` 将中文/英文的各种写法统一为标准条件字符串：

```
输入输出条件映射:
  "输入长度[0,32) && 输出长度[0,0.2)"  →  "input < 32k && output < 0.2k"
  "输入长度[0,32) && 输出长度[0.2,+∞)" →  "input < 32k && output >= 0.2k"
  "输入长度[32,200)"                    →  "32k <= input < 200k"
  "输入长度[32,128)"                    →  "32k <= input < 128k"
  "输入长度[32,64)"                     →  "32k <= input < 64k"
  "输入长度[32,+∞)"                     →  "input >= 32k"
  "输入长度[0,32)"                      →  "input < 32k"

处理步骤:
  1. 去 HTML 标签 + 规范化空白
  2. 转小写
  3. 中文标点 → 英文: （→( 】→) ，→, 并且/且 → &&
  4. 去空白后与已知模式匹配
```

### 分层条件匹配

`_matchesGlmTierCondition(condition, usageContext)` 在计费时判断当前请求匹配哪个 tier：

```javascript
// 条件格式: "32k <= input < 200k" 或 "input < 32k && output < 0.2k"
// usageContext: { totalInputTokens, outputTokens }

// 算法：
// 1. 将 input → totalInputTokens/1000, output → outputTokens/1000
// 2. 将 "k" 后缀去掉: "32k" → "32"
// 3. 按 && 分割为多个子条件
// 4. 每个子条件支持：
//    - 链式: 32 <= input < 200 → 两个比较的 AND
//    - 简单: input < 32 → 一个比较
// 5. 所有子条件都满足 → 匹配成功
```

### 分层定价数据结构

```javascript
// 每个模型的定价条目
{
  input_cost_per_token: 0.000000xxx,       // 第一档价格（USD/token）
  output_cost_per_token: 0.000000xxx,
  cache_read_input_token_cost: 0.000000xxx,
  pricing_source: 'glm_official_docs' | 'glm_builtin_fallback',
  pricing_updated_at: '2026-06-23T...',
  litellm_provider: 'glm',
  provider_specific_entry: {
    pricing_in_cny: {
      exchange_rate: 7,                     // CNY → USD 汇率
      tiers: [                              // 分层定价
        {
          condition: 'input < 32k && output < 0.2k',
          input: 0.5,                       // CNY/百万token
          output: 2,
          cacheRead: 0,
          input_usd_per_million: 0.0714,    // 自动换算
          output_usd_per_million: 0.2857,
          cache_read_usd_per_million: 0
        },
        {
          condition: 'input < 32k && output >= 0.2k',
          input: 0.5,
          output: 8,
          ...
        },
        {
          condition: '32k <= input < 200k',
          input: 2,
          output: 8,
          ...
        }
      ]
    }
  }
}
```

### 计费时的分层定价解析

在 `calculateCost` 中：

```javascript
// 1. 判断是否 GLM 模型
const isGlmProvider = pricing?.litellm_provider?.toLowerCase() === 'glm'

// 2. 解析分层定价
const glmTieredPricing = isGlmProvider
  ? this._resolveGlmTieredPricing(pricing, {
      totalInputTokens,
      outputTokens: usage.output_tokens || 0
    })
  : null

// 3. 使用分层价格（优先于其他定价逻辑）
let actualInputPrice = glmTieredPricing
  ? glmTieredPricing.input        // ← 使用分层价格
  : useLongContextPricing ? ...   // ← 其他定价逻辑
    : baseInputPrice

let actualOutputPrice = glmTieredPricing
  ? glmTieredPricing.output
  : ...
```

### 价格保留策略

`_preserveGlmPricingUpdatedAt`：当价格字段未变化时，保留原有的 `pricing_updated_at` 时间戳，避免误更新：

```javascript
// 比较字段: cache_read_input_token_cost, input_cost_per_token,
//           output_cost_per_token, pricing_source
// 如果完全一致 → 保留原 pricing_updated_at
```

### CNY → USD 换算

```javascript
const GLM_CNY_PER_USD = 7
const glmCnyPerMillionToUsdPerMillion = (cny) => cny / 7
const usdPerMillionToUsdPerToken = (usd) => usd / 1_000_000
```

> 源码: `src/services/pricingService.js:488-1108, 2788-2897`

---

## 9. 多平台价格镜像生成脚本

### 两种模式

```
默认模式（本地更新）:
  从价格镜像分支下载 → 注入 DeepSeek 内置价格 → 保存到 data/

--mirror 模式（镜像生成）:
  从上游 LiteLLM 仓库下载原始价格 →
  合并已有镜像中四平台 provider entries →
  依次从四平台官方文档远程抓取最新价格 →
  生成价格文件 + SHA256 哈希文件
```

### mergeExistingMirrorProviderEntries

```javascript
function mergeExistingMirrorProviderEntries(baseData) {
  // 读取已有的镜像文件
  const existingData = JSON.parse(fs.readFileSync(mirrorPricingFile, 'utf8'))

  // 提取四平台的定价条目
  const existingProviderEntries = Object.fromEntries(
    Object.entries(existingData).filter(([modelName]) => {
      const normalized = modelName.toLowerCase()
      return normalized.includes('deepseek') ||
             normalized.startsWith('glm-') ||
             normalized.startsWith('minimax-') ||
             normalized.startsWith('kimi-') ||
             normalized.startsWith('moonshot-')
    })
  )

  // 合并：已有 provider entries 优先（因为上游仓库没有这些平台的数据）
  return { ...existingProviderEntries, ...baseData }
}
```

### 镜像生成流程

```javascript
async function generatePriceMirror() {
  // 1. 下载上游原始价格
  const rawData = await downloadText(config.upstreamPricingUrl)
  const upstreamData = JSON.parse(rawData)

  // 2. 合并已有 provider entries
  const dataWithExistingProviders = mergeExistingMirrorProviderEntries(upstreamData)

  // 3. 依次远程抓取四平台价格（allowRemote: true）
  let enrichedData = await pricingService.enrichPricingDataWithDeepSeek(dataWithExistingProviders, { allowRemote: true })
  enrichedData = await pricingService.enrichPricingDataWithMiniMax(enrichedData, { allowRemote: true })
  enrichedData = await pricingService.enrichPricingDataWithGlm(enrichedData, { allowRemote: true })
  enrichedData = await pricingService.enrichPricingDataWithKimi(enrichedData, { allowRemote: true })

  // 4. 生成价格文件 + 哈希文件
  const formattedJson = JSON.stringify(enrichedData, null, 2)
  const hash = crypto.createHash('sha256').update(formattedJson).digest('hex')
  fs.writeFileSync(config.mirrorPricingFile, formattedJson)
  fs.writeFileSync(config.mirrorHashFile, `${hash}\n`)

  // 5. 输出统计
  log.success(`Generated price mirror for ${modelCount} models`)
  log.info(`DeepSeek models: ${deepseekModels}`)
  log.info(`GLM models: ${glmModels}`)
  log.info(`MiniMax models: ${minimaxModels}`)
  log.info(`Kimi models: ${kimiModels}`)
}
```

### 命令行参数

```bash
# 本地更新模式
node scripts/update-model-pricing.js

# 镜像生成模式
node scripts/update-model-pricing.js --mirror
node scripts/update-model-pricing.js --mirror --output-dir=/path/to/output

# 环境变量
MODEL_PRICING_UPSTREAM_URL=https://raw.githubusercontent.com/.../model_prices_and_context_window.json
PRICE_MIRROR_OUTPUT_DIR=/path/to/output
```

> 源码: `scripts/update-model-pricing.js`

---

## 10. 各 Relay 服务的统一错误处理模式

### 统一的 _handleUpstreamStatus 模式

四个 relay 服务（DeepSeek/GLM/Kimi/MiniMax）的 `_handleUpstreamStatus` 方法结构完全一致：

```javascript
async _handleUpstreamStatus(status, responseBody, accountId, sessionHash) {
  if (!accountId) return

  // 1. 计费类错误 → 标记临时不可用 + 清除会话映射
  if (upstreamErrorHelper.isRelayBillingError(status, responseBody)) {
    await upstreamErrorHelper.markTempUnavailable(accountId, platform, status, null, {
      response: responseBody
    })
    if (sessionHash) await scheduler.clearSessionMapping(sessionHash)
    return
  }

  // 2. 401/403 → 标记 unauthorized + 清除会话映射
  if (status === 401 || status === 403) {
    await scheduler.markAccountUnauthorized(accountId, `${platform} upstream auth failed (${status})`)
    if (sessionHash) await scheduler.clearSessionMapping(sessionHash)
    return
  }

  // 3. 429 → 标记限流（不清除会话映射）
  if (status === 429) {
    await scheduler.markAccountRateLimited(accountId, sessionHash)
    return
  }

  // 4. 5xx/529 → 标记临时不可用 + 清除会话映射
  if (status >= 500 || status === 529) {
    await upstreamErrorHelper.markTempUnavailable(accountId, platform, status, null, {
      response: responseBody
    })
    if (sessionHash) await scheduler.clearSessionMapping(sessionHash)
  }
}
```

### 统一的错误响应返回模式

所有错误返回路径都经过 `sanitizeRelayErrorResponse` 清洗：

```javascript
// 非流式错误
if (upstreamResponse.status >= 400) {
  await this._handleUpstreamStatus(status, responseData, accountId, sessionHash)
  return res.status(status).json(
    upstreamErrorHelper.sanitizeRelayErrorResponse(status, responseData)
  )
}

// 流式错误（先读取 stream 内容再清洗）
if (upstreamResponse.status >= 400) {
  const errorBody = await this._readStreamToString(upstreamResponse.data)
  const parsed = this._parseJsonSafe(errorBody) || { error: { message: errorBody } }
  await this._handleUpstreamStatus(status, parsed, accountId, sessionHash)
  return res.status(status).json(
    upstreamErrorHelper.sanitizeRelayErrorResponse(status, parsed, errorBody)
  )
}

// 请求异常（网络错误等）
async _handleRequestError(req, res, error, accountId, sessionHash) {
  if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
    return res.status(499).json({ error: { message: 'Client closed request' } })
  }
  const status = error.response?.status || 500
  const responseBody = error.response?.data || { error: { message: error.message } }
  await this._handleUpstreamStatus(status, responseBody, accountId, sessionHash)
  return res.status(status).json(
    upstreamErrorHelper.sanitizeRelayErrorResponse(status, responseBody, error.message)
  )
}
```

### 流式响应中的 SSE 错误读取

```javascript
_readStreamToString(stream) → Promise<string>
// 收集 stream 所有 chunk，拼接成字符串
// stream 结束或出错时 resolve

_parseJsonSafe(text) → object | null
// 安全的 JSON.parse，失败返回 null
```

> 源码: `src/services/relay/deepseekRelayService.js:1048-1127`, 其他 relay 服务同理

---

## 11. 近期补充：过载限流、额度耗尽与安全清洗

这部分是 2026-06-23 之后合入的补充点，迁移时建议和前面 1-10 节一起处理。

### OpenAI upstream connect error 屏蔽

`errorSanitizer` 已把 Envoy/网关类连接错误纳入白名单映射：

```text
upstream connect error
disconnect/reset before headers
reset reason: connection termination
```

这些错误统一映射为 `E001 Service temporarily unavailable`，避免把上游网关内部信息直接暴露给客户端。

### Relay 计费类错误扩展

`isRelayBillingError()` 同时识别错误码和错误文本，覆盖余额不足、欠费、免费额度耗尽、充值提示、
`insufficient_balance`、`credit_exhausted`、`billing_isolated`、`free_quota_exhausted` 等常见表达。

命中后不会按普通 400/403 透传，而是标记账号临时不可用并返回清洗后的标准错误。

### 迁移检查点

- OpenAI `server_is_overloaded`：返回友好 SSE 错误，并临时限流当前账号
- 上游连接错误：只返回标准错误码，不返回原始网关错误
- 余额/欠费：标记账号临时不可用，不暴露原始充值文案
- 账号额度耗尽：使用 `quotaExceeded` 状态，等待上游 reset 时间后恢复
- 所有平台 Relay：错误响应都经过 `sanitizeRelayErrorResponse()` 或 OpenAI 专用清洗逻辑

---

## 附录：文件索引

| 模块 | 文件路径 |
|------|---------|
| 错误码白名单 | `src/utils/errorSanitizer.js` |
| 上游错误处理 | `src/utils/upstreamErrorHelper.js` |
| 临时暂停策略 | `src/utils/tempUnavailablePolicy.js` |
| OpenAI 路由 | `src/routes/openaiRoutes.js` |
| DeepSeek Relay | `src/services/relay/deepseekRelayService.js` |
| GLM Relay | `src/services/relay/glmRelayService.js` |
| Kimi Relay | `src/services/relay/kimiRelayService.js` |
| MiniMax Relay | `src/services/relay/minimaxRelayService.js` |
| 定价服务 | `src/services/pricingService.js` |
| 价格更新脚本 | `scripts/update-model-pricing.js` |
| 错误清洗测试 | `tests/errorSanitizer.test.js` |
| OpenAI 错误清洗测试 | `tests/openaiResponsesRelayService.errorSanitize.test.js` |
| 定价服务测试 | `tests/pricingService.test.js` |
