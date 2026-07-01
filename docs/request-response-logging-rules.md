# 请求 / 响应日志规则（当前代码实现）

> 更新时间：2026-07-01
> 说明：本文描述当前工作区代码里 request / response 相关日志的实际行为，重点覆盖普通访问日志、路由专项日志、请求明细留存和调试 dump。若后续实现有变更，请以源码为准。

---

## 1. 范围

本文覆盖以下 5 套机制：

1. `src/middleware/requestId.js` 中的链路请求 ID
2. `src/middleware/auth.js` 中的通用访问日志 `requestLogger`
3. `src/routes/api.js` 与 `src/routes/openaiRoutes.js` 中的路由专项日志
4. `src/services/requestDetailService.js` 中的请求明细留存
5. `src/utils/anthropicRequestDump.js` 中的 Anthropic 调试请求 dump

---

## 2. 总体原则

### 2.1 请求 ID

- 应用最早注册 `requestIdMiddleware`
- `requestIdMiddleware` 会优先读取客户端传入的 `x-request-id`，没有时生成 8 位十六进制 ID
- 该 ID 写入：
  - `req.reqId`
  - `asyncLocalStorage` 上下文中的 `reqId`
  - 响应头 `X-Relay-Request-Id`
- 如果请求头带 `session_id` 或 `x-session-id`，也会写入 `asyncLocalStorage` 上下文，便于日志链路关联

通用访问日志还有一套独立 ID：

- `requestLogger` 会生成随机 `requestId`
- 该 ID 写入：
  - `req.requestId`
  - `req.requestStartedAt`
  - 响应头 `X-Request-ID`
- `requestDetailService` 使用的是 `req.requestId`

注意：

- 当前 `X-Relay-Request-Id` 和 `X-Request-ID` 是两条不同链路，默认不会互相覆盖
- CORS 暴露头当前包含 `X-Request-ID`，不包含 `X-Relay-Request-Id`
- 迁移到其他项目时，如果希望全链路只有一个 ID，可以让 `requestLogger` 复用 `req.reqId`

### 2.2 日志等级

- 普通成功请求默认使用 `info`
- `4xx` 默认使用 `warn`
- `5xx` 默认使用 `error`
- URL 中包含 `event_logging` 的调试路由，入口和出口日志改为 `debug`

### 2.3 忽略规则

- `/health` 不记录通用 request / response 访问日志

---

## 3. 通用访问日志：`requestLogger`

代码位置：`src/middleware/auth.js`

### 3.1 请求开始日志

请求进入时会记录：

- `requestId`
- `method`
- `originalUrl`
- `ip`

对于 `GET` 以外且 `body` 非空的请求，会额外记录请求体摘要。

### 3.2 请求体记录规则

`requestLogger` 的请求体处理以“避免日志爆炸”为主，不是完整的通用脱敏器。

当前规则如下：

- 优先识别 `body.input` 或 `body.messages`
- 如果是数组，只保留最后 `50` 条
- 若原始数组长度超过 `50`，补充 `_inputTruncated: 原始条数`
- 媒体类内容不会原样写入日志，以下类型会被替换为摘要：
  - `image`
  - `image_url`
  - `file`
  - `document`
  - `input_image`
- 媒体相关字段如 `image_url`、`image_data`、`base64` 会改写成占位文本，例如：
  - `[media only, xxxB]`
- 遇到过深对象时会输出 `[too deep]`

### 3.3 入口日志格式

入口日志主消息格式为：

```text
▶ [requestId] METHOD URL
```

同时附带 metadata，例如：

- `ip`
- `req`

### 3.4 响应完成日志

`finish` 时记录：

- `requestId`
- `statusCode`
- `method`
- `originalUrl`
- `duration`
- `contentLength`
- `query`
- `key`
- `auth`
- `ip`
- `ua`
- `referer`

主消息格式为：

```text
🟢/⚠️/❌ STATUS METHOD URL duration contentLength
```

### 3.5 响应体记录规则

`requestLogger` 只拦截 `res.json()`：

- 如果路由通过 `res.json(body)` 返回，响应体会暂存到 `res._responseBody`
- `finish` 时会把 `meta.res = res._responseBody` 一起写日志
- 如果路由通过 `res.send()` 返回文本或原始 body，`requestLogger` 默认不会捕获响应体
- SSE / 流式响应也不走这条响应体捕获逻辑

### 3.6 慢请求与异常

- 请求耗时超过 `5000ms` 时，追加一条 `Slow request` 警告
- `res.on('error')` 会记录响应阶段异常
- 全局 `errorHandler` 会记录未处理异常，包括：
  - `error.message`
  - `stack`
  - `url`
  - `method`
  - `ip`
  - `userAgent`
  - `apiKey`
  - `admin`

---

## 4. 认证阶段补充日志

代码位置：`src/middleware/auth.js`

认证中间件会单独记录一次 headers 摘要：

- `authorization` 会被替换为 `***`
- `x-api-key` 会被替换为 `***`

这一条日志的目标是排查调用来源和 header 结构，不用于记录完整请求体。

---

## 5. Claude `/v1/messages` 路由专项日志

代码位置：`src/routes/api.js`

### 5.1 请求侧

进入 `/v1/messages` 时，默认记录：

- `model`
- `forcedVendor`
- `stream`

随后会再记录一条“正在处理”的日志，区分：

- `stream request`
- `non-stream request`

### 5.2 非流式响应侧

非流式请求成功后，额外记录：

- `statusCode`
- `headers`
- `bodyLength`

如果响应体能成功解析为 JSON，还会直接打印完整解析结果：

- `Parsed Claude API response`

如果解析失败，会记录：

- `Failed to parse Claude API response as JSON`
- `Raw response body`

### 5.3 usage 记录日志

当官方响应里带有 `usage` 时，会记录：

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `ephemeral_5m_input_tokens`
- `ephemeral_1h_input_tokens`

若没有 `usage`，只打警告，不做估算。

### 5.4 连接状态日志

非流式分支还会额外记录 socket 相关事件，用于定位“客户端先断开”的问题，例如：

- `Socket 'end' event`
- `Socket 'close' event`
- `Socket error`

---

## 6. OpenAI / Codex 路由专项日志

代码位置：`src/routes/openaiRoutes.js`

### 6.1 请求侧

OpenAI / Codex 路由默认会记录：

- 是否是 Codex CLI
- 是否应用 Codex adaptation
- 是否应用 payload rules
- `sessionId`
- `sessionHash`
- 选择到的 `accountId`
- `accountType`
- `accountName`
- `proxy`
- 上游 endpoint
- `model`
- `stream`
- `inputItems`

### 6.2 上游响应侧

收到上游响应后，会记录：

- 上游 `status`
- 总耗时

对于错误状态，还会追加：

- 原始错误日志
- `429` 限流日志
- `401/402` 认证或计费异常日志
- 其他 `4xx/5xx` 清洗后的错误处理日志

### 6.3 非流式成功响应日志

非流式响应成功时，会输出 usage summary，包括：

- completion type
- platform
- elapsed
- accountId / accountName
- input / output / cache read / total
- model / actual model / requested model

如果 `LOG_TRUNCATE !== true`，还会把完整 `response` 挂到日志 metadata。

### 6.4 流式成功响应日志

流式响应成功结束时，也会记录同样的 usage summary。

如果 `LOG_TRUNCATE !== true`，则会尽量附带：

- `completedResponse`
- `outputItems`
- `streamErrors`

### 6.5 流式异常与断开日志

OpenAI 流式分支会额外记录：

- 上游流中断
- 客户端断开
- 上游流异常关闭但没有 `end/error`
- `server_is_overloaded`

当前没有全局“记录每个流式 chunk 正文”的开关。流式正文默认不进入 `requestLogger` 的 `meta.res`，
专项日志只记录调度、usage、错误和断开等事件；只有 `server_is_overloaded` 这类排障分支会记录原始
chunk。

---

## 7. 请求明细留存：`requestDetailService`

代码位置：

- `src/utils/requestDetailHelper.js`
- `src/services/requestDetailService.js`
- `src/services/apiKeyService.js`

### 7.1 与普通日志的区别

普通访问日志偏“排障现场”，请求明细偏“可控留痕”。

请求明细只有在配置开启后才会落库，且脱敏和裁剪更严格。

### 7.2 采集时机

usage 记录完成后，系统会异步触发请求明细采集，不阻塞主请求。

采集内容包括：

- `requestId`
- `timestamp`
- `requestStartedAt`
- `endpoint`
- `method`
- `statusCode`
- `stream`
- `durationMs`
- `requestBody`
- `apiKeyId`
- `accountId`
- `accountType`
- `model`
- token 使用信息
- `cost`
- `realCost`
- `uniUserId`

### 7.3 请求体快照脱敏规则

`sanitizeRequestBodySnapshot()` 的默认规则：

- 敏感字段按 key 名匹配掩码，例如：
  - `authorization`
  - `apiKey`
  - `access_token`
  - `refresh_token`
  - `token`
  - `secret`
  - `password`
  - `cookie`
  - `client_secret`
  - `private_key`
  - `proxy`
- 字符串默认最多保留 `80` 字符
- 数组默认最多保留 `24` 项
- 对象最大深度默认 `6`
- `encrypted_content` 直接替换成长度摘要
- `tools` 会被压缩成简要结构
- 整体快照总长度默认最多 `12000` 字符

如果超出总量上限，不再保留完整结构，而是转为：

- `summary`
- `originalChars`
- `maxChars`
- `preview`

### 7.4 保留策略

请求明细保留时间按“小时”配置。

相关配置项：

- `requestDetailCaptureEnabled`
- `requestDetailRetentionHours`
- `requestDetailBodyPreviewEnabled`

---

## 8. Anthropic 调试请求 Dump

代码位置：`src/utils/anthropicRequestDump.js`

### 8.1 触发方式

只有当环境变量开启时才会写文件：

- `ANTHROPIC_DEBUG_REQUEST_DUMP=true`
- 或 `ANTHROPIC_DEBUG_REQUEST_DUMP=1`

### 8.2 写入位置

输出文件固定为项目根目录下：

```text
anthropic-requests-dump.jsonl
```

### 8.3 写入内容

每条记录包含：

- `ts`
- `requestId`
- `method`
- `url`
- `ip`
- `meta`
- `headers`
- `body`

### 8.4 脱敏与大小限制

以下 headers 会脱敏：

- `authorization`
- `proxy-authorization`
- `x-api-key`
- `cookie`
- `set-cookie`
- `x-forwarded-for`
- `x-real-ip`

单条 dump 默认最大 `2MB`，可通过以下环境变量覆盖：

- `ANTHROPIC_DEBUG_REQUEST_DUMP_MAX_BYTES`

超限时不会直接丢弃，而会写入一条截断结构，包含：

- `maxBytes`
- `originalBytes`
- `partialJson`

---

## 9. 配置项总表

### 9.1 普通日志

- `LOG_LEVEL`
- `LOG_MAX_SIZE`
- `LOG_MAX_FILES`
- `LOG_TRUNCATE`

### 9.2 Anthropic 调试 dump

- `ANTHROPIC_DEBUG_REQUEST_DUMP`
- `ANTHROPIC_DEBUG_REQUEST_DUMP_MAX_BYTES`

### 9.3 请求明细

运行时配置项：

- `requestDetailCaptureEnabled`
- `requestDetailRetentionHours`
- `requestDetailBodyPreviewEnabled`

---

## 10. 当前实现的已知限制

### 10.1 `requestLogger` 的请求体脱敏不完整

普通访问日志中的请求体主要做的是：

- 媒体内容裁剪
- `input/messages` 数量裁剪

它没有像 `requestDetailService` 那样对所有敏感 key 统一掩码，因此：

- 普通日志更适合排障
- 请求明细更适合长期留存

### 10.2 `requestLogger` 只自动捕获 `res.json()`

因此以下内容不会被它自动记录成 `meta.res`：

- `res.send()` 的文本响应
- SSE / 流式响应正文
- 直接 pipe 的上游流

如果需要在排障期保存流式正文，应在具体路由或 relay 服务中加短期开关，并确保过滤图片、文件、
base64 和 token。不要把流式 chunk 原文作为默认生产日志。

### 10.3 路由专项日志存在“完整响应体输出”

例如 Claude 非流式分支会打印：

- 完整解析后的 JSON
- 解析失败时的 raw response body

这对排障很有帮助，但日志量和敏感内容风险也更高，应结合部署环境、日志保留策略和 `LOG_TRUNCATE` 使用。

---

## 11. 建议的使用口径

为了便于团队统一理解，建议将现有日志机制按下面口径使用：

1. `requestLogger`：看访问轨迹、状态码、耗时、基础请求体摘要
2. 路由专项日志：看调度、上游请求、响应解析、usage、限流和断线现场
3. `requestDetailService`：看受控的请求明细留存和后台排查
4. `anthropicRequestDump`：只在短期专项排障时开启，用完即关

---

## 12. 相关源码

- `src/middleware/auth.js`
- `src/middleware/requestId.js`
- `src/routes/api.js`
- `src/routes/openaiRoutes.js`
- `src/services/apiKeyService.js`
- `src/services/requestDetailService.js`
- `src/utils/requestDetailHelper.js`
- `src/utils/anthropicRequestDump.js`
- `config/config.js`
