# Webhook 通知功能迁移文档

本文档用于把当前项目的 Webhook 通知能力迁移到其它项目中，包含当前实现位置、通知规则、业务触发点、数据结构、迁移步骤和注意事项。

## 1. 功能目标

Webhook 模块负责把系统中的关键事件推送到外部通知平台，例如企业微信、钉钉、飞书、Slack、Discord、Telegram、Bark、SMTP 邮件或自定义 HTTP Webhook。

当前项目中主要用于：

- 账号异常通知：账号未授权、限流、禁用、配额耗尽、恢复等。
- 系统错误通知：上游 API 调用失败、流式/非流式请求错误等。
- 限流恢复通知：定时清理任务发现账号限流状态恢复后汇总通知。
- 手动测试通知：后台配置页验证平台连通性和通知格式。

## 2. 当前项目文件地图

| 文件 | 职责 |
| --- | --- |
| `src/routes/webhook.js` | Webhook 管理后台 API：配置、平台增删改、测试连接、发送测试通知 |
| `src/services/webhookConfigService.js` | Webhook 配置读写、默认配置、平台配置校验 |
| `src/services/webhookService.js` | 通知发送核心：按类型过滤、按平台分发、重试、消息格式化 |
| `src/utils/webhookNotifier.js` | 业务侧兼容封装：账号异常、账号事件 |
| `src/services/rateLimitCleanupService.js` | 限流恢复汇总通知触发点 |
| `src/routes/api.js` | Claude 主路由系统错误通知触发点 |
| `src/services/relay/*RelayService.js` | 各平台 relay 上游错误通知触发点 |
| `src/services/account/*AccountService.js` | 账号状态异常、恢复、限流、未授权等通知触发点 |
| `src/routes/admin/*Accounts.js` | 后台手动停止调度等管理动作通知触发点 |

后台路由挂载在 `src/app.js`：

```js
this.app.use('/admin/webhook', webhookRoutes)
```

## 3. 总体架构

推荐迁移时保留三层结构：

```text
业务代码
  -> webhookNotifier.sendAccountAnomalyNotification()
  -> webhookNotifier.sendAccountEvent()
  -> webhookService.sendNotification()
  -> platform handler
  -> HTTP / SMTP / Push 平台
```

### 3.1 webhookConfigService

负责：

- 从存储中读取配置。
- 保存配置。
- 合并默认通知类型。
- 校验平台配置。
- 获取启用平台列表。

当前项目使用 Redis key：

```text
webhook_config:default
```

如果其它项目不是 Redis，可以替换成数据库表、配置中心或本地配置文件，但建议保留同样的数据结构。

### 3.2 webhookService

负责：

- 检查全局开关。
- 检查通知类型开关。
- 获取启用的平台。
- 并发发送到所有平台。
- 每个平台按 retrySettings 重试。
- 根据平台格式化消息体。
- 记录成功/失败数量。

发送入口：

```js
await webhookService.sendNotification(type, data)
```

### 3.3 webhookNotifier

这是业务侧建议使用的轻量封装，避免业务代码直接关心消息类型和字段格式。

当前封装了：

```js
await webhookNotifier.sendAccountAnomalyNotification({
  accountId,
  accountName,
  platform,
  status,
  errorCode,
  reason,
  timestamp
})
```

```js
await webhookNotifier.sendAccountEvent('account.status_changed', {
  accountId,
  platform,
  schedulable,
  changedBy,
  action
})
```

## 4. 配置模型

当前默认配置：

```js
{
  enabled: false,
  platforms: [],
  notificationTypes: {
    accountAnomaly: true,
    quotaWarning: true,
    systemError: true,
    securityAlert: true,
    rateLimitRecovery: true,
    test: true
  },
  retrySettings: {
    maxRetries: 3,
    retryDelay: 1000,
    timeout: 10000
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | Webhook 总开关 |
| `platforms` | array | 通知平台列表 |
| `notificationTypes` | object | 通知类型开关 |
| `retrySettings.maxRetries` | number | 每个平台最大尝试次数 |
| `retrySettings.retryDelay` | number | 重试基础延迟，毫秒 |
| `retrySettings.timeout` | number | 默认超时，毫秒 |

当前项目注意点：

- `config/config.js` 中有 `WEBHOOK_ENABLED`、`WEBHOOK_URLS`、`WEBHOOK_TIMEOUT`、`WEBHOOK_RETRIES`，但实际发送链路读取的是 Redis 中的 `webhook_config:default`。
- 迁移到新项目时，建议二选一：
  - 保留 Redis/DB 配置方式，并移除无效 env 配置。
  - 或者改造 `webhookConfigService.getConfig()`，让它优先读取 env。

## 5. 支持平台

当前 `webhookService.platformHandlers` 支持：

| type | 平台 | 必需配置 | 可选配置 |
| --- | --- | --- | --- |
| `wechat_work` | 企业微信机器人 | `url` | `timeout` |
| `dingtalk` | 钉钉机器人 | `url` | `enableSign`、`secret`、`timeout` |
| `feishu` | 飞书机器人 | `url` | `enableSign`、`secret`、`timeout` |
| `slack` | Slack Incoming Webhook | `url` | `timeout` |
| `discord` | Discord Webhook | `url` | `timeout` |
| `telegram` | Telegram Bot | `botToken`、`chatId` | `apiBaseUrl`、`proxyUrl`、`timeout` |
| `custom` | 自定义 HTTP Webhook | `url` | `timeout` |
| `bark` | Bark 推送 | `deviceKey` | `serverUrl`、`level`、`sound`、`group`、`icon`、`clickUrl` |
| `smtp` | 邮件 | `host`、`user`、`pass`、`to` | `port`、`secure`、`from`、`ignoreTLS` |

平台配置通用字段：

```js
{
  id: 'uuid',
  name: '平台名称',
  type: 'dingtalk',
  enabled: true,
  timeout: 10000,
  createdAt: 'ISO time',
  updatedAt: 'ISO time'
}
```

## 6. 发送规则

`webhookService.sendNotification(type, data)` 的规则：

1. 读取配置。
2. 如果 `config.enabled` 为 false，直接跳过。
3. 如果 `type !== 'test'` 且 `config.notificationTypes[type]` 不为 true，直接跳过。
4. 获取 `platform.enabled === true` 的平台。
5. 没有启用平台则跳过。
6. 对所有启用平台并发发送。
7. 单个平台发送失败时，按 `retrySettings.maxRetries` 和 `retrySettings.retryDelay` 进行指数退避重试。
8. 所有平台发送完成后返回：

```js
{
  succeeded: 1,
  failed: 0
}
```

重试逻辑：

```js
const delay = retryDelay * Math.pow(2, retryIndex)
```

也就是 1000ms、2000ms、4000ms 这样的指数退避。

## 7. 通知类型

当前项目定义的标题：

| type | 标题 | 主要用途 |
| --- | --- | --- |
| `accountAnomaly` | 账号异常通知 | 账号限流、未授权、禁用、配额异常、恢复 |
| `quotaWarning` | 配额警告 | 预留类型，当前业务触发较少 |
| `systemError` | 系统错误 | 上游请求错误、流式错误、非流式错误 |
| `securityAlert` | 安全警报 | 预留类型，当前业务触发较少 |
| `rateLimitRecovery` | 限流恢复通知 | 定时清理恢复限流账号 |
| `test` | 测试通知 | 后台测试连接/手动测试 |

当前项目还存在业务调用：

```js
webhookNotifier.sendAccountEvent('account.status_changed', data)
```

它会发送通知类型：

```js
accountEvent
```

但默认 `notificationTypes` 没有 `accountEvent`。如果你要迁移并启用账号事件通知，建议把默认配置补上：

```js
notificationTypes: {
  accountAnomaly: true,
  accountEvent: true,
  quotaWarning: true,
  systemError: true,
  securityAlert: true,
  rateLimitRecovery: true,
  test: true
}
```

同时给 `webhookService.getNotificationTitle()` 添加：

```js
accountEvent: '📌 账号事件通知'
```

## 8. 消息数据格式

### 8.1 accountAnomaly

推荐字段：

```js
{
  accountId: '账号ID',
  accountName: '账号名称',
  platform: 'openai',
  status: 'blocked',
  errorCode: 'OPENAI_RATE_LIMITED',
  reason: 'Account rate limited',
  timestamp: '2026-06-30T10:00:00.000+08:00'
}
```

常见 status：

| status | 含义 |
| --- | --- |
| `error` | 一般错误 |
| `unauthorized` | 认证失败 |
| `blocked` | 被阻断/限流/不可用 |
| `disabled` | 管理员手动禁用 |
| `quota_exceeded` | 配额耗尽 |
| `warning` | 使用量预警 |
| `recovered` | 状态恢复 |
| `resumed` | 自动恢复调度 |
| `temp_error` | 临时错误 |

### 8.2 systemError

推荐字段：

```js
{
  title: 'OpenAI Responses 请求错误',
  platform: 'openai-responses',
  apiKeyName: 'key name',
  accountId: 'account id',
  account: 'account name',
  status: 429,
  path: '/v1/responses',
  method: 'POST',
  model: 'gpt-5',
  error: '原始错误',
  sanitizedError: '脱敏后的错误'
}
```

迁移时建议：

- `error` 可用于内部排查，但对外部通知平台存在泄漏风险。
- 如果 Webhook 接收方不完全可信，建议只发 `sanitizedError`。

### 8.3 rateLimitRecovery

当前字段：

```js
{
  title: '限流恢复通知',
  message: '汇总消息',
  totalAccounts: 3,
  platforms: ['openai', 'claude'],
  accounts: [
    {
      accountId: 'id',
      accountName: 'name',
      platform: 'openai'
    }
  ],
  timestamp: 'ISO time'
}
```

### 8.4 accountEvent

当前字段示例：

```js
{
  eventType: 'account.status_changed',
  accountId: 'id',
  platform: 'deepseek',
  schedulable: false,
  changedBy: 'admin',
  action: 'stopped_scheduling',
  timestamp: 'ISO time'
}
```

## 9. 管理 API

所有接口都需要管理员认证 `authenticateAdmin`。

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/admin/webhook/config` | 获取配置 |
| POST | `/admin/webhook/config` | 保存完整配置 |
| POST | `/admin/webhook/platforms` | 添加平台 |
| PUT | `/admin/webhook/platforms/:id` | 更新平台 |
| DELETE | `/admin/webhook/platforms/:id` | 删除平台 |
| POST | `/admin/webhook/platforms/:id/toggle` | 启用/禁用平台 |
| POST | `/admin/webhook/test` | 测试某个平台连通性 |
| POST | `/admin/webhook/test-notification` | 使用当前配置发送测试通知 |

## 10. 当前业务触发点

### 10.1 账号异常通知

账号服务中常见触发：

| 平台 | 触发点 |
| --- | --- |
| OpenAI | token 刷新失败、429 限流、401 未授权、状态重置、使用量自动停止调度 |
| OpenAI-Responses | 401 未授权、状态重置 |
| Claude OAuth | refresh 失败、手动禁用、限流、订阅/会话异常、临时错误、使用量预警 |
| Claude Console | 手动禁用、429 限流、401 未授权、blocked、529 overload、quota exceeded、恢复 |
| Gemini | 手动禁用、错误、恢复 |
| Gemini-API | 未授权、恢复 |
| CCR | 日额度耗尽、恢复 |
| Azure OpenAI | 恢复 |
| Bedrock | 恢复 |
| Droid | 恢复 |

### 10.2 后台手动停止调度

后台管理路由中，如果管理员把账号调度状态切到不可调度，会发送通知。

两种实现风格：

- 老平台：发 `accountAnomaly`，状态为 `disabled`。
- 新平台：发 `accountEvent`，事件为 `account.status_changed`。

涉及平台：

- `openai`
- `openai-responses`
- `claude-oauth`
- `claude-console`
- `gemini`
- `gemini-api`
- `azure-openai`
- `bedrock`
- `ccr`
- `droid`
- `deepseek`
- `minimax`
- `glm`
- `kimi`

迁移建议：统一成一种风格，优先推荐 `accountAnomaly disabled`，因为默认通知类型已经启用。

### 10.3 系统错误通知

当前主要在 relay 或路由层触发：

| 文件 | 场景 |
| --- | --- |
| `src/routes/api.js` | Claude API 错误 |
| `src/services/relay/openaiResponsesRelayService.js` | OpenAI-Responses 上游错误 |
| `src/services/relay/claudeConsoleRelayService.js` | Claude Console 非流式/流式错误 |
| `src/services/anthropicGeminiBridgeService.js` | Gemini bridge 非流式/流式错误 |

这些通知一般使用：

```js
webhookService.sendNotification('systemError', {
  title,
  platform,
  apiKeyName,
  accountId,
  account,
  status,
  error,
  sanitizedError
})
```

### 10.4 限流恢复通知

`rateLimitCleanupService` 定时清理过期限流状态。

当本轮清理有账号恢复时：

```js
await webhookService.sendNotification('rateLimitRecovery', {
  title: '限流恢复通知',
  message,
  totalAccounts,
  platforms,
  accounts,
  timestamp
})
```

## 11. 迁移步骤

### 11.1 安装依赖

当前 Webhook 相关依赖：

```bash
npm install axios nodemailer https-proxy-agent socks-proxy-agent uuid
```

如果目标项目已经有这些依赖，可以复用。

### 11.2 复制核心文件

建议复制：

```text
src/services/webhookService.js
src/services/webhookConfigService.js
src/utils/webhookNotifier.js
src/routes/webhook.js
```

同时确认目标项目中已有或补齐：

```text
src/utils/logger.js
src/utils/dateHelper.js
src/middleware/auth.js
src/models/redis.js
```

如果目标项目不是 Redis，需要改 `webhookConfigService` 的读写方法。

### 11.3 挂载管理路由

在 Express app 中添加：

```js
const webhookRoutes = require('./routes/webhook')

app.use('/admin/webhook', webhookRoutes)
```

### 11.4 接入业务触发点

账号异常：

```js
const webhookNotifier = require('../utils/webhookNotifier')

await webhookNotifier.sendAccountAnomalyNotification({
  accountId,
  accountName,
  platform: 'openai',
  status: 'unauthorized',
  errorCode: 'OPENAI_UNAUTHORIZED',
  reason: 'OpenAI账号认证失败（401错误）'
})
```

系统错误：

```js
const webhookService = require('../services/webhookService')

webhookService
  .sendNotification('systemError', {
    title: '上游请求错误',
    platform: 'openai',
    apiKeyName,
    accountId,
    status,
    sanitizedError
  })
  .catch((error) => logger.warn('Failed to send webhook notification:', error))
```

限流恢复：

```js
await webhookService.sendNotification('rateLimitRecovery', {
  title: '限流恢复通知',
  message,
  totalAccounts,
  platforms,
  accounts,
  timestamp: new Date().toISOString()
})
```

### 11.5 后台页面接入

如果目标项目有管理后台，建议提供：

- Webhook 总开关。
- 通知类型开关。
- 平台列表。
- 新增/编辑平台表单。
- 平台测试按钮。
- 发送测试通知按钮。

后端已有 API，可直接调用 `/admin/webhook/*`。

## 12. 建议优化

迁移时建议顺手修正当前项目里的几个不一致点：

1. 补上 `accountEvent` 默认通知类型。

```js
notificationTypes: {
  accountAnomaly: true,
  accountEvent: true,
  quotaWarning: true,
  systemError: true,
  securityAlert: true,
  rateLimitRecovery: true,
  test: true
}
```

2. 给 `accountEvent` 增加标题和格式化字段。

```js
accountEvent: '📌 账号事件通知'
```

3. 不要同时保留两套配置来源。

当前项目里 `WEBHOOK_*` env 看起来像旧配置，但实际发送读 Redis。新项目建议只保留一种配置来源，减少误解。

4. 对系统错误通知做脱敏。

建议默认只发送：

```js
sanitizedError
status
platform
accountId
apiKeyName
path
model
```

不要默认发送完整 token、Authorization、原始请求体、完整响应体。

5. 敏感平台配置建议加密。

例如：

- 钉钉 secret
- 飞书 secret
- Telegram botToken
- SMTP pass
- Webhook URL 中的 token

当前项目配置是 JSON 存 Redis，迁移到生产项目时建议复用项目现有加密工具。

6. 通知失败不能影响主业务。

业务路径中建议：

```js
webhookService
  .sendNotification(type, data)
  .catch((error) => logger.warn('Failed to send webhook notification:', error))
```

账号状态变更这种后台动作可以 `await`，但请求转发路径建议异步发送，避免 Webhook 平台拖慢用户请求。

## 13. 测试清单

迁移后建议验证：

- 默认配置下不发送通知。
- 开启 `enabled` 但没有平台时不发送通知。
- 禁用某个通知类型后，该类型不发送。
- `test` 类型即使类型开关缺失也可以发送。
- 单个平台失败不会影响其它平台发送。
- 重试次数符合配置。
- 钉钉/飞书签名正确。
- Telegram 代理配置生效。
- SMTP 发送成功。
- 自定义 Webhook 收到 payload：

```js
{
  type,
  service: 'claude-relay-service',
  timestamp,
  data
}
```

- 业务触发点不会因为 Webhook 失败导致主请求失败。

## 14. 最小可用版本

如果只想在其它项目快速加最小版 Webhook，保留这些能力即可：

```text
webhookConfigService:
  - getConfig()
  - saveConfig()
  - getEnabledPlatforms()

webhookService:
  - sendNotification()
  - sendToCustom()
  - sendHttpRequest()
  - retryWithBackoff()

webhookNotifier:
  - sendAccountAnomalyNotification()

routes/webhook:
  - GET /config
  - POST /config
  - POST /test-notification
```

最小版只支持 `custom` HTTP Webhook，后续再逐步加企业微信、钉钉、飞书等平台。

