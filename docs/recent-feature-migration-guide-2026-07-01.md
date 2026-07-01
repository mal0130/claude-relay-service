# 近期功能迁移补充说明（liyanchao / mal0130）

> 更新时间：2026-07-01
> 范围：补齐 `liyanchao` 与 `maliang(mal0130)` 近期提交中，尚未集中成文或容易迁漏的功能点。
> 用途：在其他项目新增等价能力时，可按本文件拆任务和验收。

---

## 1. 已有文档覆盖情况

已经有专项文档的内容，不在本文重复展开：

- Webhook 通知：`docs/webhook-notification-integration-guide.md`
- 请求 / 响应日志：`docs/request-response-logging-rules.md`
- 错误处理、计费和定价：`docs/error-handling-and-pricing-2026-06-23.md`
- Partner API：`docs/partner-api.md`、`docs/partner-api-enterprise.md`
- 多 Key 自动切换：`docs/multi-key-switching.md`
- CRS 到 sub2api 迁移：`docs/crs-to-sub2api-migration-plan-2026-05-13.md`
- Redis Key：`docs/redis-key-summary.md`

本文主要补充这些文档没有讲细，或近期代码已变更但文档口径需要同步的部分。

---

## 2. OpenAI server_is_overloaded 账号临时限流

### 行为

OpenAI/Codex 流式响应中如果出现：

```json
{ "error": { "code": "server_is_overloaded" } }
```

系统会：

1. 替换成中文友好 SSE 错误
2. 结束客户端流
3. 销毁上游流
4. 调用 OpenAI 调度器把当前账号临时限流

默认限流 `3` 分钟，可通过环境变量配置：

```bash
OPENAI_SERVER_OVERLOAD_RATE_LIMIT_MINUTES=3
```

### 实现点

- 配置：`config.openai.serverOverloadRateLimitMinutes`
- 路由：`src/routes/openaiRoutes.js`
- 调度器方法：`unifiedOpenAIScheduler.markAccountRateLimited(accountId, 'openai', sessionHash, seconds)`
- 配置示例：`config/config.example.js`、`.env.example`

### 迁移注意

- 复用已有 429 限流逻辑，不要另建一套过载状态
- 传入 `sessionHash`，让当前粘性会话跟着清理
- Redis 操作可以 best-effort，不要阻塞已经要返回给客户端的错误流
- 这个逻辑只在流式 `server_is_overloaded` 分支触发

---

## 3. DeepSeek 代码补全接口

### 路由

DeepSeek 现在不只有 Chat Completions 和 Anthropic Messages，还支持代码补全：

| 客户端路由 | 上游协议 |
| ---------- | -------- |
| `POST /deepseek/v1/chat/completions` | DeepSeek Chat Completions |
| `POST /deepseek/v1/completions` | DeepSeek `/beta/completions` |
| `POST /deepseek/anthropic/v1/messages` | DeepSeek Anthropic-compatible |

### 账号字段

代码补全必须给 DeepSeek 账号配置：

```js
codeCompletionBaseApi: 'https://api.deepseek.com/beta'
```

支持填写：

- `https://api.deepseek.com`
- `https://api.deepseek.com/v1`
- `https://api.deepseek.com/beta`
- `https://api.deepseek.com/beta/completions`

系统会通过 `buildCompletionsUrl()` 归一化为 `/beta/completions`。

### 调度差异

补全请求会用独立 endpoint type：

```js
unifiedDeepSeekScheduler.selectAccountForApiKey(apiKey, sessionHash, model, 'completion')
```

调度器只选择配置了 `codeCompletionBaseApi` 的账号。补全粘性会话 key 也独立：

```text
deepseek_session_mapping:completion:{sessionHash}
```

这样 Chat 和 Completion 不会互相污染粘性绑定。

### 迁移注意

- 后台账号表单要新增 `codeCompletionBaseApi`
- DeepSeek 账号服务创建/更新时要保存并归一化该字段
- scheduler 需要按 endpoint type 过滤账号
- usage 记录里 `protocol` 要能区分 `openai`、`anthropic`、`completion`
- 流式 completion 要自动补 `stream_options.include_usage`

---

## 4. DeepSeek / MiniMax / GLM / Kimi 四平台账号

### 后端结构

四个平台都按“一等账号类型”实现：

| 平台 | 账号服务 | 调度器 | Relay | 路由 |
| ---- | -------- | ------ | ----- | ---- |
| DeepSeek | `src/services/account/deepseekAccountService.js` | `unifiedDeepSeekScheduler.js` | `deepseekRelayService.js` | `src/routes/deepseekRoutes.js` |
| MiniMax | `minimaxAccountService.js` | `unifiedMinimaxScheduler.js` | `minimaxRelayService.js` | `minimaxRoutes.js` |
| GLM | `glmAccountService.js` | `unifiedGlmScheduler.js` | `glmRelayService.js` | `glmRoutes.js` |
| Kimi | `kimiAccountService.js` | `unifiedKimiScheduler.js` | `kimiRelayService.js` | `kimiRoutes.js` |

每个平台都有：

- API Key AES 加密保存
- `isActive` / `schedulable` / `status`
- `rateLimitDuration`
- `dailyQuota` / `quotaResetTime` / `quotaStoppedAt`
- 代理配置
- 账号测试接口
- 限流恢复和错误历史记录

### API Key 权限与绑定

API Key 通过 `permissions` 控制平台访问：

```js
permissions: ['claude', 'openai', 'deepseek', 'minimax', 'glm', 'kimi']
```

新增平台绑定统一放在：

```js
accountBindings: {
  deepseek: { mode: 'shared', accountId: '...' },
  minimax: { mode: 'shared', accountId: '...' },
  glm: { mode: 'shared', accountId: '...' },
  kimi: { mode: 'shared', accountId: '...' }
}
```

Partner API 对应字段：

```text
deepseek_account_id
minimax_account_id
glm_account_id
kimi_account_id
```

支持普通账号 ID 和 `group:{id}`。

---

## 5. 账户级模型映射

### 当前实现口径

四平台账号字段实际存的是 `supportedModels`，语义是“请求模型名 -> 上游实际模型名”：

```json
{
  "deepseek-chat": "deepseek-v4-flash",
  "DeepSeek-V4-Pro": "deepseek-v4-pro"
}
```

匹配规则以当前代码为准：

1. 空对象：不限制模型，原样透传
2. 精确命中：使用映射值
3. 大小写不敏感命中：使用映射值
4. 未命中：调度阶段认为账号不支持该模型

注意：部分旧迁移文档写过“支持通配符”，但当前四平台账号服务没有真正实现 `*` 通配匹配。迁移到其他项目时，如果需要通配符，要单独补实现和测试。

### 计费口径

Relay 会保留 `requestedModel`，计费时使用：

```js
billingModel = requestedModel || actualModel
```

也就是说：即使上游实际请求模型被映射成别名，扣费仍按用户请求模型查价，避免映射后找不到价格或误用免费模型价格。

---

## 6. API Key 多规则限流与窗口重置

### 数据结构

新限流使用 `rateLimits` 数组：

```json
[
  { "window": 300, "cost": 500 },
  { "window": 60, "requests": 120 }
]
```

旧字段 `rateLimitWindow` / `rateLimitRequests` / `rateLimitCost` 仍保留兼容读取，但新增和编辑界面优先使用多规则。

### 规则

- `window` 单位是分钟，必须为正整数
- 每条规则至少配置 `requests` 或 `cost`
- `requests` 是窗口内请求数限制
- `cost` 是窗口内费用限制
- `rateLimits: []` 表示清空多规则限流

Partner API 更新时支持：

```text
reset_window=1  重置当前限流窗口
reset_window=2  不重置
```

---

## 7. Standard Responses Codex Adaptation

Standard Responses 路由现在会强制开启 Codex adaptation 的默认处理：

```js
apiKeyData.enableOpenAIResponsesCodexAdaptation = true
```

行为：

- 标准 Responses 路由强制开启 adaptation 默认值
- Codex CLI 请求根据 User-Agent 识别，命中后按当前 payload 透传
- 非 Codex CLI 且标准 Responses 路由会应用 Codex CLI adaptation
- payload rules 在 adaptation 后再执行
- 备用 Key 切换时也要补齐该字段默认值，缺失时默认 `true`

迁移时不要只在创建 Key 时设置默认值，还要在 Redis 读取、备用 Key 校验、路由处理前都做默认值标准化。

---

## 8. 上游错误保护补充

### upstream connect error 屏蔽

以下网关类错误不会原样返回客户端：

```text
upstream connect error
disconnect/reset before headers
reset reason: connection termination
```

它们通过 `errorSanitizer` 映射成标准错误，原始内容只写日志。

### 账号额度耗尽

`AccountQuotaExceeded` 或 `exceeded ... usage quota` 会走额度耗尽保护：

- 账号标记为 `quotaExceeded`
- `schedulable=false`
- 写入 `providerQuotaResetAt`
- reset 时间到达后调度器自动恢复

### 临时不可用 TTL

全局配置在 `config.upstreamError`：

```js
serviceUnavailableTtlSeconds
serverErrorTtlSeconds
overloadTtlSeconds
authErrorTtlSeconds
timeoutTtlSeconds
```

Claude 官方账号还支持账号级 503 / 5xx TTL 覆盖，以及禁用 temp unavailable 自动保护。

---

## 9. 请求日志与请求明细

### 双 request id

当前有两套 ID：

- `X-Relay-Request-Id`：来自 `requestIdMiddleware`，优先透传客户端 `x-request-id`
- `X-Request-ID`：来自 `requestLogger`，用于访问日志和请求明细

迁移时建议二选一：

- 保持现状：兼容当前日志
- 或统一为一个 ID：让 `requestLogger` 复用 `req.reqId`

### 请求体与媒体过滤

普通访问日志会：

- `input/messages` 只保留最后 50 条
- 图片、文件、document、base64 字段替换成摘要
- 深层对象超过深度后输出 `[too deep]`

请求明细使用 `requestDetailService`，会额外做敏感字段掩码、长度限制和结构裁剪，更适合长期留存。

### 流式响应

当前没有全局流式 chunk 正文日志开关。生产默认只记录：

- 调度信息
- usage summary
- 错误与断开事件
- `server_is_overloaded` 原始 chunk

不要默认保存完整 SSE chunk，除非是短期排障开关，并且要过滤媒体和 token。

---

## 10. 启动任务、运维脚本与 CI

### 成本初始化改为定时任务

启动时不再直接做成本初始化，日志会提示：

```text
Skipping startup cost initialization; scheduler will handle it
```

定时任务由 `src/services/costInitService.js` 控制：

- `COST_INIT_SCHEDULER_ENABLED=true` 才启用
- `COST_INIT_CRON` 控制执行时间，默认 `0 2 * * *`
- 使用 Redis done key 防止同一天重复执行
- 使用 Redis lock 防止多实例并发初始化

### manage.sh

`scripts/manage.sh` 支持：

- `start/restart/update --instances N|max`
- PM2 cluster / fork 自动处理
- `--node-memory` 和 `--max-memory-restart`
- `--log-output` / `--no-log-output`
- `rotate-log` 无需重启轮转 `service.log`
- 更新/重启时尽量保留现有 PM2 实例数和模式

### CI

`.github/workflows/changed-files-coverage.yml`：

- Node.js 24
- 只统计变更后端源码
- 生成 changed files coverage
- 再通过 `scripts/filter-owned-coverage.js` 过滤 owned lines 覆盖率

`.github/workflows/sync-model-pricing.yml`：

- Node.js 24
- 每小时多次同步价格镜像
- 输出到 `price-mirror` 分支
- 只在价格文件或 hash 变化时提交

---

## 11. 迁移验收清单

- OpenAI 流式 `server_is_overloaded` 会友好返回，并临时限流账号
- DeepSeek `/v1/completions` 可用，且只选择配置了 `codeCompletionBaseApi` 的账号
- DeepSeek completion 粘性会话不影响 chat 粘性会话
- DeepSeek / MiniMax / GLM / Kimi 的权限、绑定、账号 CRUD、调度和计费都可独立运行
- 模型映射按当前实现的精确/大小写不敏感规则测试通过
- 多规则 `rateLimits` 和 `reset_window` 在管理后台与 Partner API 都可用
- Standard Responses 备用 Key 切换后仍有 `enableOpenAIResponsesCodexAdaptation=true`
- 上游连接错误、欠费、额度耗尽不会把原始上游文案暴露给客户端
- 请求日志不输出完整图片/base64/token
- 成本初始化、限流恢复、价格同步等后台任务在多实例下不会重复写坏数据
