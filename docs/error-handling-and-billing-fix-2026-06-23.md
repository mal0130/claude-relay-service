# 错误处理与计费修正技术详解（2026-06-23）

本文详细记录了最近一批提交中引入的错误处理体系、计费模型修正、定价抓取优化等功能点的完整实现逻辑。
目标读者：需要在其他项目中重写这些功能的工程师。

---

## 目录

1. [错误清洗体系（errorSanitizer + upstreamErrorHelper）](#1-错误清洗体系)
2. [计费类错误检测与自动停调](#2-计费类错误检测与自动停调)
3. [Relay 错误响应统一清洗](#3-relay-错误响应统一清洗)
4. [OpenAI 路由流式错误体解析与清洗](#4-openai-路由流式错误体解析与清洗)
5. [server_is_overloaded 友好提示替换](#5-server_is_overloaded-友好提示替换)
6. [计费模型修正（requestedModel 作为 billingModel）](#6-计费模型修正)
7. [GLM 分层定价体系](#7-glm-分层定价体系)
8. [GLM 价格抓取（HTML 表格解析）](#8-glm-价格抓取)
9. [多平台价格镜像生成脚本](#9-多平台价格镜像生成脚本)

---

## 1. 错误清洗体系

### 1.1 设计目标

上游 AI 服务返回的错误消息可能包含敏感信息（内部路由标识、账户 ID、真实错误详情等）。
系统采用**白名单错误码制度**：所有错误映射到 16 个预定义标准错误码，原始消息只记日志不返回客户端。

### 1.2 标准错误码定义

文件：`src/utils/errorSanitizer.js`

```js
const ERROR_CODES = {
  E001: { message: 'Service temporarily unavailable', status: 503 },
  E002: { message: 'Network connection failed', status: 502 },
  E003: { message: 'Authentication failed', status: 401 },
  E004: { message: 'Rate limit exceeded', status: 429 },
  E005: { message: 'Invalid request', status: 400 },
  E006: { message: 'Model not available', status: 503 },
  E007: { message: 'Upstream service error', status: 502 },
  E008: { message: 'Request timeout', status: 504 },
  E009: { message: 'Permission denied', status: 403 },
  E010: { message: 'Resource not found', status: 404 },
  E011: { message: 'Account temporarily unavailable', status: 503 },
  E012: { message: 'Server overloaded', status: 529 },
  E013: { message: 'Invalid API key', status: 401 },
  E014: { message: 'Quota exceeded', status: 429 },
  E015: { message: 'Internal server error', status: 500 },
  E016: { message: 'Prompt is too long', status: 413 }  // 新增
}
```

### 1.3 三层错误匹配逻辑

`mapToErrorCode(error, options)` 函数按三层优先级匹配：

**第一层：HTTP 状态码快速匹配**

```
401 → E003    403 → E009    404 → E010    429 → E004
502 → E007    503 → E001    504 → E008    529 → E012
```

**第二层：消息内容正则匹配（可覆盖第一层）**

按优先级排序的 `ERROR_MATCHERS` 数组，逐条 `test()`，命中即停：

```js
const ERROR_MATCHERS = [
  // 网络层
  { pattern: /ENOTFOUND|DNS|getaddrinfo/i, code: 'E002' },
  { pattern: /ECONNREFUSED|ECONNRESET|connection refused/i, code: 'E002' },
  { pattern: /ETIMEDOUT|timeout/i, code: 'E008' },
  { pattern: /ECONNABORTED|aborted/i, code: 'E002' },
  // 认证
  { pattern: /unauthorized|invalid.*token|token.*invalid|invalid.*key/i, code: 'E003' },
  { pattern: /invalid.*api.*key|api.*key.*invalid/i, code: 'E013' },
  // 权限
  { pattern: /forbidden|permission.*denied|access.*denied/i, code: 'E009' },
  // 限流
  { pattern: /rate.*limit|too many requests|429/i, code: 'E004' },
  { pattern: /quota.*exceeded|usage.*limit/i, code: 'E014' },
  // 过载
  { pattern: /overloaded|529|capacity/i, code: 'E012' },
  // 账户不可用
  { pattern: /account.*disabled|organization.*disabled/i, code: 'E011' },
  { pattern: /too many active sessions/i, code: 'E011' },
  { pattern: ACCOUNT_TEMP_UNAVAILABLE_PATTERN, code: 'E011' },
  { pattern: ACCOUNT_BILLING_UNAVAILABLE_PATTERN, code: 'E011' },
  // 模型
  { pattern: /model.*not.*found|model.*unavailable|unsupported.*model/i, code: 'E006' },
  // 上下文超长（新增）
  { pattern: /prompt is too long|too many tokens|context.*too long|exceeds.*token.*limit/i, code: 'E016' },
  // 请求错误
  { pattern: /bad.*request|invalid.*request|invalid.*argument|malformed/i, code: 'E005' },
  { pattern: /not.*found|404/i, code: 'E010' },
  // 上游
  { pattern: /upstream|502|bad.*gateway/i, code: 'E007' },
  { pattern: /503|service.*unavailable/i, code: 'E001' }
]
```

**第三层：错误 code 字段匹配（网络错误码）**

```
ENOTFOUND / EAI_AGAIN     → E002
ECONNREFUSED / ECONNRESET → E002
ETIMEDOUT / ESOCKETTIMEDOUT → E008
ECONNABORTED              → E002
```

### 1.4 原始错误消息提取

`extractOriginalMessage(error)` 按以下顺序尝试提取：

```
error (string) → error.message → error.error.message
→ error.response.data.error.message → error.response.data.error
→ error.response.data.message → ''
```

### 1.5 账户不可用模式检测

两个专用正则用于检测账户级别的不可用：

```js
// 账户过期/失效模式
const ACCOUNT_TEMP_UNAVAILABLE_PATTERN =
  /chatgpt account|codex with a chatgpt account|subscription.*expired|expired.*subscription|plan.*expired|expired.*plan|account.*expired|expired.*account|workspace.*expired|expired.*workspace/i

// 账户计费不可用模式（中英双语）
const ACCOUNT_BILLING_UNAVAILABLE_PATTERN =
  /余额不足|账户余额不足|可用额度不足|余额已用尽|免费额度已用尽|欠费|请充值|充值后|insufficient(?:\s+\w+){0,2}\s+(?:balance|credit)|out of(?:\s+\w+){0,2}\s+credit|credit(?:\s+\w+){0,2}\s+exhausted|no[_\s-]*free[_\s-]*package|free[_\s-]*quota[_\s-]*exhausted|billing[_\s-]*isolated|recharge/i
```

### 1.6 输出函数

| 函数 | 用途 | 返回格式 |
|------|------|----------|
| `getSafeMessage(error)` | 仅返回安全消息字符串 | `string` |
| `createSafeErrorResponse(error)` | 标准 JSON 响应 | `{ error: { code, message }, status }` |
| `createSafeSSEError(error)` | SSE 错误事件 | `event: error\ndata: {...}\n\n` |
| `sanitizeErrorMessage(msg)` | 兼容旧接口 | `string` |
| `isAccountDisabledError(status, body)` | 检测 400 下的账户禁用 | `boolean` |

---

## 2. 计费类错误检测与自动停调

### 2.1 问题背景

DeepSeek/GLM/Kimi/MiniMax 等平台返回余额不足、欠费等错误时，状态码不统一（可能是 402、403、400 等），
需要递归遍历错误对象才能准确识别计费类错误，识别后自动标记账户临时不可用。

### 2.2 计费错误码模式

文件：`src/utils/upstreamErrorHelper.js`

```js
// 错误码匹配（精确匹配）
const RELAY_BILLING_ERROR_CODE_PATTERN =
  /^(401007|401008|403004|insufficient_balance|insufficient_credit|credit_exhausted|billing_isolated|no_free_package|free_quota_exhausted)$/i

// 错误消息匹配（模糊匹配，中英双语）
const RELAY_BILLING_ERROR_MESSAGE_PATTERN =
  /余额不足|账户余额不足|可用额度不足|余额已用尽|免费额度已用尽|欠费|请充值|充值后|insufficient(?:\s+\w+){0,2}\s+(?:balance|credit)|out of(?:\s+\w+){0,2}\s+credit|credit(?:\s+\w+){0,2}\s+exhausted|no[_\s-]*free[_\s-]*package|free[_\s-]*quota[_\s-]*exhausted|billing[_\s-]*isolated|recharge/i
```

### 2.3 递归遍历错误对象

`collectRelayErrorTokens(errorData)` 递归遍历错误对象，提取所有字符串/数字 token：

```js
const collectRelayErrorTokens = (errorData) => {
  const tokens = []
  const visited = new Set()

  const visit = (value) => {
    if (value === null || value === undefined) return
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim()
      if (text) tokens.push(text)
      return
    }
    if (typeof value !== 'object') return
    if (visited.has(value)) return  // 防循环引用
    visited.add(value)

    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }

    // 递归遍历常见错误字段
    visit(value.message)
    visit(value.detail)     // FastAPI 风格
    visit(value.code)
    visit(value.type)
    visit(value.error)
    visit(value.errors)
  }

  visit(errorData)
  return tokens
}
```

### 2.4 判定函数

```js
const isRelayBillingError = (status, errorData, fallbackError = null) => {
  // 402 状态码直接判定
  if (status === 402) return true

  // 收集所有 token，逐个匹配
  const candidates = [
    ...collectRelayErrorTokens(errorData),
    ...collectRelayErrorTokens(fallbackError)
  ]

  return candidates.some(
    (candidate) =>
      RELAY_BILLING_ERROR_CODE_PATTERN.test(candidate) ||
      RELAY_BILLING_ERROR_MESSAGE_PATTERN.test(candidate)
  )
}
```

### 2.5 在 Relay 服务中的调用

以 DeepSeek 为例（`deepseekRelayService.js:1048`），所有四个平台 relay 服务的 `_handleUpstreamStatus` 方法中，计费类错误检测排在最前面：

```js
async _handleUpstreamStatus(status, responseBody, accountId, sessionHash) {
  if (!accountId) return

  // 1️⃣ 计费类错误检测（最高优先级）
  if (upstreamErrorHelper.isRelayBillingError(status, responseBody)) {
    await upstreamErrorHelper.markTempUnavailable(accountId, 'deepseek', status, null, {
      response: responseBody
    })
    if (sessionHash) {
      await unifiedDeepSeekScheduler.clearSessionMapping(sessionHash)
    }
    return
  }

  // 2️⃣ 认证失败
  if (status === 401 || status === 403) {
    await unifiedDeepSeekScheduler.markAccountUnauthorized(accountId, `auth failed (${status})`)
    if (sessionHash) await unifiedDeepSeekScheduler.clearSessionMapping(sessionHash)
    return
  }

  // 3️⃣ 限流
  if (status === 429) {
    await unifiedDeepSeekScheduler.markAccountRateLimited(accountId, sessionHash)
    return
  }

  // 4️⃣ 服务端错误 / 过载
  if (status >= 500 || status === 529) {
    await upstreamErrorHelper.markTempUnavailable(accountId, 'deepseek', status, null, {
      response: responseBody
    })
    if (sessionHash) await unifiedDeepSeekScheduler.clearSessionMapping(sessionHash)
  }
}
```

### 2.6 临时不可用管理

`markTempUnavailable(accountId, accountType, statusCode, customTtl, context)` 的完整流程：

```
1. classifyError(statusCode, context.response) → 确定错误类型
2. 读取账户级策略（disableTempUnavailable / ttl503Seconds / ttl5xxSeconds）
3. 如果策略禁用了临时暂停 → 删除现有 key，跳过
4. 确定TTL：
   - 优先用 customTtl
   - 其次用账户级覆盖（ttl503Seconds / ttl5xxSeconds）
   最后用默认 TTL
5. 写入 Redis: SETEX temp_unavailable:{type}:{id} {ttl} {json}
6. 异步记录错误历史
```

默认 TTL 表：

| 错误类型 | 状态码 | TTL |
|----------|--------|-----|
| `server_error` | 5xx | 5 分钟 |
| `service_unavailable` | 503 | 1 分钟 |
| `overload` | 529 | 10 分钟 |
| `auth_error` | 401/403 | 30 分钟 |
| `timeout` | 504 | 5 分钟 |
| `rate_limit` | 429 | 5 分钟（优先用响应头解析值） |

计费类错误会被 `classifyError` 归类为 `service_unavailable`，默认 TTL 1 分钟。

### 2.7 自愈机制

`isTempUnavailable` 和 `getAllTempUnavailable` 都会自动清理无 TTL 的异常 key（`ttl === -1`），避免账户被永久阻塞。

---

## 3. Relay 错误响应统一清洗

### 3.1 设计目标

四个平台 relay 服务返回给客户端的错误响应需要统一格式和脱敏，但不能丢失结构信息（如 `error.type`、`error.code` 等）。

### 3.2 sanitizeRelayErrorResponse

文件：`src/utils/upstreamErrorHelper.js:659`

```js
const sanitizeRelayErrorResponse = (status, errorData, fallbackError = null) => {
  // 1. 确定错误来源
  const source = errorData || fallbackError || {
    error: { message: getSafeMessage({ response: { status } }) }
  }

  // 2. 检测是否计费类错误
  const billingRelated = isRelayBillingError(status, source, fallbackError)

  // 3. 清洗（去除内部路由标识）
  const sanitized = sanitizeErrorForClient(source)

  // 4. 确定安全消息
  const directSafeMessage = billingRelated
    ? RELAY_BILLING_SAFE_MESSAGE  // 'Account temporarily unavailable'
    : getSafeMessage(hasMessageTokens ? source : { response: { status, data: source } })

  // 5. 回退逻辑：如果 directSafeMessage 是 E015（Internal server error），
  //    但状态码能匹配到更具体的消息，用状态码的
  const statusSafeMessage = getSafeMessage({ response: { status, data: source } })
  const safeMessage =
    !billingRelated &&
    directSafeMessage === ERROR_CODES.E015.message &&
    statusSafeMessage !== ERROR_CODES.E015.message
      ? statusSafeMessage
      : directSafeMessage

  // 6. 确保标准 { error: { message } } 结构
  return ensureRelayErrorShape(sanitized, safeMessage)
}
```

### 3.3 ensureRelayErrorShape

处理上游返回的多种错误格式，统一为 `{ error: { message, ... } }` 结构：

```js
const ensureRelayErrorShape = (errorData, safeMessage) => {
  // null/undefined/Buffer → { error: { message: safeMessage } }
  // error 是 string → 保留其他字段，error 改为 { message: safeMessage }
  // error 是 object → 保留其他字段，error.message 改为 safeMessage
  // 有 message 字段无 error → 新增 error: { message: safeMessage }
  // 都没有 → 新增 error: { message: safeMessage }
}
```

### 3.4 sanitizeErrorForClient

去除内部路由标识（如 `[codex/codex]`），并将所有消息替换为安全消息：

```js
const sanitizeErrorForClient = (errorData) => {
  // 1. 字符串 → { error: { message: getSafeMessage(原始) } }
  // 2. 对象 → JSON.stringify → 正则去除 / \[[^\]/]+\/[^\]]+\]/g → JSON.parse
  // 3. 替换 error.message / message 为安全消息
  // 4. FastAPI detail 字段 → { error: { message: safeMsg } }
}
```

### 3.5 在 Relay 服务中的使用

所有错误响应路径都统一使用 `sanitizeRelayErrorResponse`：

**非流式错误**：
```js
return res
  .status(upstreamResponse.status)
  .json(upstreamErrorHelper.sanitizeRelayErrorResponse(upstreamResponse.status, responseData))
```

**流式错误**（上游返回 4xx/5xx 但 Content-Type 是 stream）：
```js
const errorBody = await this._readStreamToString(upstreamResponse.data)
const parsed = this._parseJsonSafe(errorBody) || { error: { message: errorBody } }
await this._handleUpstreamStatus(upstreamResponse.status, parsed, accountId, sessionHash)
return res
  .status(upstreamResponse.status)
  .json(upstreamErrorHelper.sanitizeRelayErrorResponse(upstreamResponse.status, parsed, errorBody))
```

**请求异常（axios catch）**：
```js
const responseBody = error.response?.data || { error: { message: error.message } }
await this._handleUpstreamStatus(status, responseBody, accountId, sessionHash)
return res
  .status(status)
  .json(upstreamErrorHelper.sanitizeRelayErrorResponse(status, responseBody, error.message))
```

---

## 4. OpenAI 路由流式错误体解析与清洗

### 4.1 问题背景

OpenAI Codex 上游返回 4xx/5xx 错误时，如果请求是 `stream: true`，响应体是一个 SSE 流（而非 JSON）。
之前直接丢弃了这个流，导致错误信息丢失。现在需要读取并解析流中的错误 JSON。

### 4.2 parseUpstreamErrorPayload

文件：`src/routes/openaiRoutes.js:128`

解析原始响应体，支持 SSE 和 JSON 两种格式：

```js
function parseUpstreamErrorPayload(rawBody = '') {
  const trimmed = rawBody.trim()
  if (!trimmed) return rawBody

  // 如果包含 SSE 格式（data: 行），逐行解析
  if (trimmed.includes('data: ')) {
    const lines = trimmed.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const jsonStr = line.slice(6).trim()
      if (!jsonStr || jsonStr === '[DONE]') continue
      try {
        return JSON.parse(jsonStr)  // 返回第一个成功解析的 JSON
      } catch (_) {
        // 继续尝试下一行
      }
    }
  }

  // 尝试直接 JSON.parse
  try {
    return JSON.parse(trimmed)
  } catch (_) {
    return trimmed  // 都失败则返回原始字符串
  }
}
```

### 4.3 resolveStreamErrorPayload

文件：`src/routes/openaiRoutes.js:161`

从 Readable Stream 中读取全部内容（带超时保护），然后解析：

```js
async function resolveStreamErrorPayload(stream, timeoutMs = 5000) {
  if (!stream || typeof stream.on !== 'function') {
    return { rawBody: '', parsedBody: '' }
  }

  const chunks = []

  // 带超时地收集所有 chunk
  await new Promise((resolve) => {
    let settled = false
    let timer = null

    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      stream.removeListener('data', onData)
      stream.removeListener('end', onDone)
      stream.removeListener('error', onDone)
      resolve()
    }

    const onData = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }

    const onDone = () => finish()

    stream.on('data', onData)
    stream.on('end', onDone)
    stream.on('error', onDone)
    timer = setTimeout(finish, timeoutMs)  // 5 秒超时保护
  })

  const rawBody = Buffer.concat(chunks).toString()
  return {
    rawBody,
    parsedBody: parseUpstreamErrorPayload(rawBody)
  }
}
```

### 4.4 sanitizeOpenAIErrorResponse

文件：`src/routes/openaiRoutes.js:221`

OpenAI 路由专用的错误响应清洗，比 relay 的多了一步：对 401/402 补充 error type 和 code。

```js
function sanitizeOpenAIErrorResponse(status, errorData, fallbackError = null) {
  const source = errorData || fallbackError || {
    error: { message: getSafeMessage({ response: { status } }) }
  }

  const sanitized = sanitizeErrorForClient(source)

  // 如果清洗后没有消息，用 fallbackError 或 source 的 detail 字段兜底
  const hasSanitizedMessage =
    typeof sanitized?.error === 'string' ||
    typeof sanitized?.error?.message === 'string' ||
    typeof sanitized?.message === 'string'

  if (!hasSanitizedMessage) {
    const safeMessageSource =
      typeof fallbackError === 'string' && fallbackError.trim()
        ? fallbackError
        : typeof source?.detail === 'string' && source.detail.trim()
          ? source.detail  // FastAPI detail 字段
          : source

    return { error: { message: getSafeMessage(safeMessageSource) } }
  }

  // 对 401/402 补充 error type 和 code
  if (status === 401 || status === 402) {
    if (!sanitized.error || typeof sanitized.error !== 'object') {
      sanitized.error = {}
    }
    if (!sanitized.error.message || sanitized.error.message === 'Internal server error') {
      sanitized.error.message = getSafeMessage({ response: { status, data: source } })
    }
    const errorType = status === 402 ? 'payment_required' : 'unauthorized'
    if (!sanitized.error.type) sanitized.error.type = errorType
    if (!sanitized.error.code) sanitized.error.code = errorType
  }

  return sanitized
}
```

### 4.5 sendSanitizedStreamErrorResponse

文件：`src/routes/openaiRoutes.js:271`

根据原始 Content-Type 决定以 SSE 还是 JSON 格式返回清洗后的错误：

```js
function sendSanitizedStreamErrorResponse(res, status, errorPayload, headers = {}) {
  res.status(status)

  const contentType = normalizeHeaders(headers)['content-type'] || 'application/json'
  const shouldUseSse = contentType.includes('text/event-stream')
  res.setHeader('Content-Type', shouldUseSse ? 'text/event-stream' : 'application/json')

  if (shouldUseSse) {
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.write(`data: ${JSON.stringify(errorPayload)}\n\n`)
    res.end()
    return
  }

  res.json(errorPayload)
}
```

### 4.6 完整调用链路

在 `handleResponses` 函数中（`openaiRoutes.js:694`）：

```
1. axios 请求上游（stream 模式）
2. 如果 upstream.status >= 400 且是 stream：
   → resolveStreamErrorPayload(upstream.data)  // 读取并解析错误流
   → 得到 { rawBody, parsedBody }
3. 429 限流：
   → sanitizeOpenAIErrorResponse(429, errorData)
   → 流式：res.write(SSE 格式)  非流式：res.json()
4. 401/402 认证失败：
   → sanitizeOpenAIErrorResponse(status, rawErrorResponse, rawErrorResponse)
   → 标记账户 unauthorized
   → res.json()
5. 其他 4xx/5xx：
   → sanitizeOpenAIErrorResponse(status, rawErrorResponse, resolvedStreamErrorRawBody)
   → 流式：sendSanitizedStreamErrorResponse()
     非流式：res.json()
```

---

## 5. server_is_overloaded 友好提示替换

### 5.1 问题背景

OpenAI Codex 上游在算力不足时，会在 SSE 流中返回 `server_is_overloaded` 错误事件。
直接透传这个错误对用户不友好，需要替换为中文提示并引导用户操作。

### 5.2 实现位置

文件：`src/routes/openaiRoutes.js:1117-1159`

### 5.3 完整实现逻辑

在 SSE 流的 `data` 事件处理中，对每个 chunk 做双重处理：

```js
upstream.data.on('data', (chunk) => {
  try {
    // 1. 先解析 chunk，检测是否包含过载错误
    const events = sseParser.feed(chunk.toString())
    let overloaded = false
    for (const event of events) {
      if (event.type === 'data' && event.data) {
        processSSEEvent(event.data)  // 正常处理 usage/model 等
        if (event.data?.error?.code === 'server_is_overloaded') {
          overloaded = true
        }
      }
    }

    // 2. 如果检测到过载，替换为友好提示
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
        // 记录原始 chunk 用于排查
        logger.warn(`⚠️ OpenAI server_is_overloaded raw chunk for account ${accountId}:`, {
          raw: chunk.toString()
        })
        // 写入友好提示并结束流
        res.write(`data: ${JSON.stringify(friendly)}\n\n`)
        streamEnded = true
        res.end()
        upstream.data.destroy()  // 关闭上游流
        return
      } else {
        // 正常透传 chunk
        res.write(chunk)
      }
    }
  } catch (error) {
    logger.error('Error processing OpenAI stream chunk:', error)
  }
})
```

### 5.4 关键设计点

1. **先解析再决定是否透传**：不能直接透传 chunk，需要先解析 SSE 事件检测过载
2. **替换而非追加**：检测到过载后，不写原始 chunk，只写友好提示
3. **立即终止**：写完友好提示后立即 `res.end()` + `upstream.data.destroy()`
4. **保留原始日志**：过载时记录原始 chunk 内容用于排查
5. **保留 error code**：友好提示中保留 `code: 'server_is_overloaded'`，客户端可据此做重试逻辑

### 5.5 在非流式场景中的检测

非流式场景中也有过载检测（`openaiRoutes.js:1109`）：

```js
// 在 processSSEEvent 中（流式）
if (eventData.error?.code === 'server_is_overloaded') {
  logger.warn(`⚠️ Server overload detected in stream for OpenAI account ${accountId}: ${eventData.error?.message}`)
}
```

---

## 6. 计费模型修正

### 6.1 问题背景

上游平台返回的 `model` 字段可能是免费模型名或别名（如 DeepSeek 返回 `deepseek-chat` 而非用户请求的 `deepseek-reasoner`），
导致 `pricingService.calculateCost` 查不到价格，费用计算为 0。

### 6.2 解决方案

在 `_recordUsage` 中使用 `billingModel = requestedModel || model` 作为计费模型：
- `requestedModel`：用户请求体中的 `model` 字段（经过 `_normalizeRequestModel` 标准化）
- `model`：上游响应中的实际模型名

### 6.3 DeepSeek 实现

文件：`src/services/relay/deepseekRelayService.js:981`

```js
async _recordUsage(req, options) {
  const { usage, body, model, accountId, sessionHash, stream, statusCode, protocol, assistantContent } = options
  // ...
  const costs = await apiKeyService.recordUsageWithDetails(
    req.apiKey.id,
    normalizedUsage,
    model,           // ← 直接用 model（DeepSeek 的 model 就是 requestedModel 标准化后的值）
    accountId,
    'deepseek',
    usageExtra,
    createRequestDetailMeta(req, { requestBody: body, stream, statusCode })
  )
  // ...
}
```

DeepSeek 的 `model` 在 `_handleJsonResponse` 中通过 `this._normalizeRequestModel(responseData?.model || requestedModel)` 得到，
优先用上游返回的 model，回退到 requestedModel。

### 6.4 GLM 实现（含计费决策日志）

文件：`src/services/relay/glmRelayService.js:987`

```js
async _recordUsage(req, options) {
  const { usage, body, model, accountId, sessionHash, stream, statusCode, protocol, assistantContent, requestedModel } = options

  // 计费使用请求模型（用户配置的），避免上游返回免费模型导致费用为0
  const billingModel = requestedModel || model
  logger.info(
    `💰 GLM billing decision requestedModel=${requestedModel || 'unknown'} actualModel=${model || 'unknown'} billingModel=${billingModel || 'unknown'} stream=${stream === true}`
  )

  const costs = await apiKeyService.recordUsageWithDetails(
    req.apiKey.id,
    normalizedUsage,
    billingModel,    // ← 使用 billingModel 而非 model
    accountId,
    'glm',
    usageExtra,
    createRequestDetailMeta(req, { requestBody: body, stream, statusCode })
  )

  await updateRateLimitCounters(
    req.rateLimitInfo,
    { inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens },
    billingModel,    // ← 限流计数也用 billingModel
    req.apiKey.id,
    'glm',
    costs
  )
}
```

### 6.5 GLM 额外的模型日志

GLM 在非流式和流式完成时都记录模型对应关系日志：

```js
logger.info(
  `🧾 GLM completion models requestedModel=${requestedModel || 'unknown'} actualModel=${model || 'unknown'} billingModel=${requestedModel || model || 'unknown'} accountId=${accountId || 'unknown'}`
)
```

### 6.6 四个平台的统一模式

| 平台 | billingModel | 日志 |
|------|-------------|------|
| DeepSeek | `model`（已标准化） | 无额外日志 |
| GLM | `requestedModel \|\| model` | `💰 GLM billing decision` + `🧾 GLM completion models` |
| Kimi | `requestedModel \|\| model` | 无额外日志 |
| MiniMax | `requestedModel \|\| model` | 无额外日志 |

---

## 7. GLM 分层定价体系

### 7.1 问题背景

GLM（智谱 AI）的定价不是一口价，而是按输入/输出 token 量分层计价。
例如 GLM-4.7 有三个 tier：
- `input < 32k && output < 0.2k`：最便宜
- `input < 32k && output >= 0.2k`：稍贵
- `32k <= input < 200k`：最贵

### 7.2 数据结构

定价条目中存储 `provider_specific_entry.pricing_in_cny.tiers` 数组：

```json
{
  "glm-4.7": {
    "input_cost_per_token": 1.43e-7,
    "output_cost_per_token": 1.43e-6,
    "cache_read_input_token_cost": 0,
    "litellm_provider": "glm",
    "pricing_currency": "USD",
    "pricing_source": "glm_official_docs",
    "provider_specific_entry": {
      "pricing_in_cny": {
        "exchange_rate": 7,
        "tiers": [
          {
            "condition": "input < 32k && output < 0.2k",
            "input": 1,
            "output": 10,
            "cacheRead": 0,
            "input_usd_per_million": 0.143,
            "output_usd_per_million": 1.429,
            "cache_read_usd_per_million": 0
          },
          {
            "condition": "input < 32k && output >= 0.2k",
            "input": 2,
            "output": 10,
            ...
          },
          {
            "condition": "32k <= input < 200k",
            "input": 5,
            "output": 10,
            ...
          }
        ]
      }
    }
  }
}
```

第一个 tier 的价格同时写入顶层字段（`input_cost_per_token` 等），作为默认/兜底价格。

### 7.3 Tier 条件匹配

文件：`src/services/pricingService.js:407`

`_matchesGlmTierCondition(condition, usageContext)` 支持两种匹配方式：

**方式一：预定义条件精确匹配**

```js
if (normalized === 'input < 32k') {
  return usageContext.totalInputTokens < 32000
}
if (normalized === 'input < 32k && output < 0.2k') {
  return usageContext.totalInputTokens < 32000 && outputInK < 0.2
}
if (normalized === '32k <= input < 200k') {
  return usageContext.totalInputTokens >= 32000 && usageContext.totalInputTokens < 200000
}
// ... 等等
```

**方式二：通用表达式解析**

将条件字符串中的 `input` 替换为实际 inputK 值，`output` 替换为 outputK 值，`32k` 替换为 `32`，
然后用正则解析 `&&` 分隔的多个比较表达式：

```js
// 支持：
//   简单比较：32 <= 100, 100 < 200, 50 >= 32
//   链式比较：32 <= 100 < 200
```

### 7.4 在 calculateCost 中的调用

文件：`src/services/pricingService.js:2788`

```js
const isGlmProvider =
  typeof pricing?.litellm_provider === 'string' &&
  pricing.litellm_provider.toLowerCase() === 'glm'

const glmTieredPricing = isGlmProvider
  ? this._resolveGlmTieredPricing(pricing, {
      totalInputTokens,        // inputTokens + cacheCreationTokens + cacheReadTokens
      outputTokens: usage.output_tokens || 0
    })
  : null
```

如果匹配到 tier，返回 `{ input, output, cacheRead }`（USD per token）；否则返回 `null`。

### 7.5 价格选择优先级

```js
let actualInputPrice = glmTieredPricing
  ? glmTieredPricing.input                              // GLM 分层价格
  : useLongContextPricing
    ? hasInput200kPrice
      ? pricing.input_cost_per_token_above_200k_tokens   // 200K+ 专用价格
      : isClaudeModel
        ? baseInputPrice * 2                             // Claude 200K+ 兜底：2倍
        : baseInputPrice
    : useMiniMax512kPricing && hasInput512kPrice
      ? pricing.input_cost_per_token_above_512k_tokens   // MiniMax 512K+ 价格
      : baseInputPrice                                   // 基础价格
```

`glmTieredPricing` 优先级最高，匹配到就直接用分层价格，不再走 200K/512K 逻辑。

---

## 8. GLM 价格抓取

### 8.1 数据来源

- URL：`https://open.bigmodel.cn/pricing`（可通过 `GLM_PRICING_URL` 环境变量覆盖）
- 格式：HTML 表格
- 汇率：人民币转美元，固定 `GLM_CNY_PER_USD = 7`

### 8.2 远程模型映射

只抓取最新的几个模型（精简后）：

```js
const GLM_REMOTE_MODEL_MAPPINGS = [
  { label: 'GLM-5.2', key: 'glm-5.2' },
  { label: 'GLM-5.1', key: 'glm-5.1' },
  { label: 'GLM-5-Turbo', key: 'glm-5-turbo' },
  { label: 'GLM-5', key: 'glm-5' },
  { label: 'GLM-4.7', key: 'glm-4.7' }
]
```

### 8.3 HTML 表格解析（处理 rowspan/colspan）

文件：`src/services/pricingService.js:813`

`_extractGlmTableRows(html)` 是核心，处理 HTML 表格中的合并单元格：

```js
_extractGlmTableRows(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
  const carryCells = []     // 跨行单元格的"余数"
  const resolvedRows = []

  for (const [, rowHtml] of rows) {
    const rawCells = [...rowHtml.matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi)]
      .map((match) => ({ attributes: match[1], html: match[2] }))

    const cells = []
    let columnIndex = 0

    // 填充从上一行"继承"的单元格
    const fillCarryCells = () => {
      while (carryCells[columnIndex]?.remaining > 0) {
        cells[columnIndex] = carryCells[columnIndex].html
        carryCells[columnIndex].remaining -= 1
        if (carryCells[columnIndex].remaining === 0) {
          carryCells[columnIndex] = null
        }
        columnIndex += 1
      }
    }

    for (const cell of rawCells) {
      fillCarryCells()
      const rowspan = this._parseGlmHtmlSpanCount(cell.attributes, 'rowspan')
      const colspan = this._parseGlmHtmlSpanCount(cell.attributes, 'colspan')

      // 填充当前单元格（考虑 colspan）
      for (let offset = 0; offset < colspan; offset += 1) {
        cells[columnIndex + offset] = cell.html
        // 如果有 rowspan，记录到 carryCells 供后续行使用
        if (rowspan > 1) {
          carryCells[columnIndex + offset] = {
            html: cell.html,
            remaining: rowspan - 1
          }
        }
      }
      columnIndex += colspan
    }

    fillCarryCells()  // 填充末尾的继承单元格
    resolvedRows.push(cells)
  }

  return resolvedRows
}
```

### 8.4 Tier 条件规范化

`_canonicalizeGlmTierCondition(conditionText)` 将中文/英文的各种写法统一为标准条件字符串：

```
"输入长度[0,32)且输出长度[0,0.2)"  →  "input < 32k && output < 0.2k"
"输入长度[32,200)"                  →  "32k <= input < 200k"
"input<32k&&output>=0.2k"          →  "input < 32k && output >= 0.2k"
```

处理步骤：
1. 去 HTML 标签、normalize 空格
2. 转小写
3. 中文括号转英文：`（【` → `(`，`）】` → `)`
4. 中文逗号转英文：`，、` → `,`
5. 中文"并且/且"转 `&&`
6. 压缩空格
7. 模式匹配到预定义的标准条件字符串

### 8.5 价格单元格解析

`_parseGlmPriceCell(cellHtml)`：
1. 去 HTML 标签
2. 检测 "free"/"免费" → 返回 0
3. 尝试提取美元价格（`extractUsdPrices`）
4. 回退提取数字

### 8.6 解析流程

`parseGlmPricingHtml(html, now)` 的完整流程：

```
1. 获取 fallback 定价
2. 遍历 GLM_REMOTE_MODEL_MAPPINGS
3. 对每个模型：
   a. _extractGlmPriceRows(html, label) — 找到匹配的表格行
   b. _parseGlmPricingRow(cells) — 解析每行的 input/output/cacheRead
   c. 如果有 fallback tiers：
      - 规范化每行的 condition
      - 与 fallback tiers 匹配
      - 全部匹配成功 → 创建分层定价条目
   d. 否则：取第一行创建平价定价条目
4. 返回 pricing 对象
```

### 8.7 Headless 浏览器渲染兜底

GLM 的定价页面可能是 JS 动态渲染的，当 HTML 中没有 `<tr>` 标签且没有 `GLM-5.2` 文本时，
会尝试用 headless 浏览器渲染：

```js
const GLM_RENDER_BROWSER_CANDIDATES = [
  process.env.GLM_RENDER_BROWSER_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'google-chrome',
  'google-chrome-stable',
  'chromium-browser',
  'chromium'
].filter(Boolean)
```

### 8.8 定价保留策略

`_preserveGlmPricingUpdatedAt(currentPricingData, nextPricingData)`：
当价格字段（`cache_read_input_token_cost`、`input_cost_per_token`、`output_cost_per_token`、`pricing_source`）
都没有变化时，保留原有的 `pricing_updated_at` 时间戳，避免误更新。

---

## 9. 多平台价格镜像生成脚本

### 9.1 脚本概览

文件：`scripts/update-model-pricing.js`

两种模式：
- **本地更新模式**（默认）：从价格镜像分支下载，仅注入 DeepSeek 内置兜底价
- **镜像生成模式**（`--mirror`）：从上游仓库下载原始数据，远程抓取四平台价格，生成价格文件 + hash

### 9.2 镜像生成流程

```js
async function generatePriceMirror() {
  // 1. 从上游下载原始价格数据
  const rawData = await downloadText(config.upstreamPricingUrl)
  const upstreamData = JSON.parse(rawData)

  // 2. 合并已有镜像中四平台的定价条目（避免被上游覆盖）
  const dataWithExistingProviders = mergeExistingMirrorProviderEntries(upstreamData)

  // 3. 依次调用四平台的 enrich 方法（allowRemote: true）
  let enrichedData = await pricingService.enrichPricingDataWithDeepSeek(dataWithExistingProviders, { allowRemote: true })
  enrichedData = await pricingService.enrichPricingDataWithMiniMax(enrichedData, { allowRemote: true })
  enrichedData = await pricingService.enrichPricingDataWithGlm(enrichedData, { allowRemote: true })
  enrichedData = await pricingService.enrichPricingDataWithKimi(enrichedData, { allowRemote: true })

  // 4. 生成价格文件 + SHA256 hash
  const formattedJson = JSON.stringify(enrichedData, null, 2)
  const hash = crypto.createHash('sha256').update(formattedJson).digest('hex')
  fs.writeFileSync(config.mirrorPricingFile, formattedJson)
  fs.writeFileSync(config.mirrorHashFile, `${hash}\n`)

  // 5. 输出统计
  // DeepSeek models: N
  // GLM models: N
  // MiniMax models: N
  // Kimi models: N
}
```

### 9.3 已有 provider entries 合并

`mergeExistingMirrorProviderEntries(baseData)` 从已有的镜像文件中提取四平台的定价条目，合并到新下载的上游数据中：

```js
function mergeExistingMirrorProviderEntries(baseData) {
  if (!fs.existsSync(config.mirrorPricingFile)) return baseData

  const existingData = JSON.parse(fs.readFileSync(config.mirrorPricingFile, 'utf8'))
  const existingProviderEntries = Object.fromEntries(
    Object.entries(existingData).filter(([modelName]) => {
      const normalized = modelName.toLowerCase()
      return (
        normalized.includes('deepseek') ||
        normalized.startsWith('glm-') ||
        normalized.startsWith('minimax-') ||
        normalized.startsWith('kimi-') ||
        normalized.startsWith('moonshot-')
      )
    })
  )
  // 已有平台条目在前，上游数据在后（上游的非平台条目会被保留）
  return { ...existingProviderEntries, ...baseData }
}
```

### 9.4 命令行参数

```bash
# 本地更新
node scripts/update-model-pricing.js

# 镜像生成
node scripts/update-model-pricing.js --mirror

# 指定输出目录
node scripts/update-model-pricing.js --mirror --output-dir=/path/to/output

# 环境变量
MODEL_PRICING_UPSTREAM_URL=https://...    # 上游价格数据 URL
PRICE_MIRROR_OUTPUT_DIR=/path/to/output   # 输出目录
```

### 9.5 本地更新模式的容错

```
1. 备份现有文件
2. 下载最新数据
3. 成功 → 清理备份
4. 失败 → 恢复备份 → 尝试 fallback 文件
5. fallback 也失败 → exit(1)
```

---

## 附：重写检查清单

在其他项目中重写这些功能时，确保以下要点：

### 错误清洗
- [ ] 定义标准错误码表（至少覆盖 401/403/404/429/500/502/503/504/529/413）
- [ ] 三层匹配：状态码 → 消息正则 → 错误 code
- [ ] 原始错误只记日志不返回客户端
- [ ] 支持 SSE 格式的错误响应

### 计费类错误检测
- [ ] 402 状态码直接判定
- [ ] 递归遍历错误对象提取 token（message/detail/code/type/error/errors）
- [ ] 中英双语正则匹配
- [ ] 检测后标记账户临时不可用 + 清除会话映射
- [ ] 临时不可用 key 必须带 TTL，无 TTL 自动清理

### Relay 错误清洗
- [ ] 统一为 `{ error: { message, ... } }` 结构
- [ ] 去除内部路由标识
- [ ] FastAPI `detail` 字段兼容
- [ ] 计费类错误使用固定安全消息

### 流式错误体解析
- [ ] 带 5 秒超时保护的 Stream 读取
- [ ] 支持 SSE 格式（`data: ` 行）和 JSON 格式的错误体解析
- [ ] 根据原始 Content-Type 决定返回 SSE 还是 JSON

### server_is_overloaded 替换
- [ ] 先解析 chunk 检测过载，不直接透传
- [ ] 替换为友好提示后立即终止流
- [ ] 保留原始 chunk 用于日志排查
- [ ] 保留 error code 供客户端重试

### 计费模型修正
- [ ] `billingModel = requestedModel || model`
- [ ] 计费和限流计数都使用 billingModel
- [ ] 记录计费决策日志

### GLM 分层定价
- [ ] tiers 数组存储在 `provider_specific_entry.pricing_in_cny.tiers`
- [ ] 第一个 tier 价格同时写入顶层字段
- [ ] tier 条件匹配支持预定义条件和通用表达式解析
- [ ] glmTieredPricing 优先级高于 200K/512K 逻辑

### GLM 价格抓取
- [ ] HTML 表格解析支持 rowspan/colspan
- [ ] tier 条件中英文规范化
- [ ] headless 浏览器渲染兜底
- [ ] 价格未变化时保留 pricing_updated_at

### 价格镜像生成
- [ ] 合并已有镜像中四平台条目
- [ ] 依次调用四平台 enrich 方法
- [ ] 生成价格文件 + SHA256 hash
- [ ] 本地更新模式有备份/恢复/fallback 容错
