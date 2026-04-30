# 多平台 API Key 与计费扩展方案

> 状态：讨论稿  
> 目标：在同一个 API Key 下同时支持 Claude、OpenAI、DeepSeek、GLM 等平台，并通过不同路由提供服务，同时保持统一认证、调度、统计和计费。

## 背景

当前系统已经具备 API Key 认证、账户调度、用量统计、成本计算、倍率扣费、账号级统计和请求明细等基础能力。但平台和账号类型在多处仍是硬编码，例如：

- `src/routes/unified.js` 主要按模型名前缀识别 `claude / gemini / gpt`。
- `src/services/apiKeyService.js` 中账号类型、权限分类、绑定字段和账号解析逻辑是静态映射。
- `src/services/serviceRatesService.js` 中服务倍率只覆盖现有服务。
- `src/services/requestDetailService.js`、`src/routes/admin/usageStats.js` 等统计展示需要显式识别账号类型。

新增 DeepSeek、GLM、Kimi、Qwen 等国产模型时，不建议为每个平台复制完整一套 relay/service/scheduler，而应抽象出通用 OpenAI-compatible 平台能力。

## 核心目标

1. 一个 `cr_xxx` API Key 可以同时拥有多个平台权限。
2. 不同平台通过不同路由进入，路由优先决定后端平台。
3. 每个平台请求都复用现有 API Key 认证链。
4. 每个平台请求都能正常记录 token、成本、倍率成本、账号用量和请求明细。
5. 国产模型先复用 OpenAI Chat Completions 兼容协议，不强行接入 OpenAI Responses。
6. 后续能低成本扩展 `kimi / qwen / hunyuan / minimax / siliconflow / openrouter` 等平台。

## 推荐路由

采用 route-first 分发，避免模型别名导致后端识别错误。

| 路由                                 | 平台           | 协议                                               |
| ------------------------------------ | -------------- | -------------------------------------------------- |
| `POST /api/v1/messages`              | Claude         | Anthropic Messages                                 |
| `POST /openai/v1/responses`          | OpenAI / Codex | OpenAI Responses                                   |
| `POST /openai/v1/chat/completions`   | OpenAI         | OpenAI Chat Completions                            |
| `POST /deepseek/v1/chat/completions` | DeepSeek       | OpenAI-compatible Chat Completions                 |
| `POST /glm/v1/chat/completions`      | GLM            | OpenAI-compatible Chat Completions                 |
| `POST /kimi/v1/chat/completions`     | Kimi           | OpenAI-compatible Chat Completions，可第二阶段加入 |

`POST /api/v1/chat/completions` 或 `POST /v1/chat/completions` 可以保留智能路由能力，但只作为辅助入口。主路径应以显式平台路由为准。

## 平台抽象

逻辑上把 DeepSeek、GLM 等作为一等平台，便于权限、计费和展示；实现上共用一套 OpenAI-compatible 适配器。

```text
逻辑平台：claude / openai / deepseek / glm / kimi / qwen
底层协议：anthropic / openai-responses / openai-chat-compatible / gemini
```

建议新增模块：

```text
src/services/openaiCompatible/providerRegistry.js
src/services/account/openaiCompatibleAccountService.js
src/services/scheduler/unifiedOpenAICompatibleScheduler.js
src/services/relay/openaiCompatibleRelayService.js
src/routes/openaiCompatibleRoutes.js
src/routes/admin/openaiCompatibleAccounts.js
```

Provider 注册表示例：

```js
{
  deepseek: {
    label: 'DeepSeek',
    baseApi: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    modelPatterns: ['deepseek-*'],
    service: 'deepseek',
    includeUsageInStream: true
  },
  glm: {
    label: 'GLM',
    baseApi: 'https://open.bigmodel.cn/api/paas/v4',
    chatPath: '/chat/completions',
    modelPatterns: ['glm-*'],
    service: 'glm',
    includeUsageInStream: true
  },
  kimi: {
    label: 'Kimi',
    baseApi: 'https://api.moonshot.cn/v1',
    chatPath: '/chat/completions',
    modelPatterns: ['kimi-*', 'moonshot-*'],
    service: 'kimi',
    includeUsageInStream: true
  }
}
```

## 账号模型

建议使用统一账号类型 `openai-compatible`，通过 `provider` 区分厂商。计费记录和统计展示时，可以把 `accountType` 记录为逻辑平台，例如 `deepseek`、`glm`，这样账单拆分更清晰。

账号字段建议：

```js
{
  id,
  platform: 'openai-compatible',
  provider: 'deepseek',
  name,
  description,
  baseApi: 'https://api.deepseek.com',
  apiKey: '<AES encrypted>',
  chatPath: '/chat/completions',
  modelPatterns: ['deepseek-*'],
  priority: 50,
  proxy: null,
  isActive: true,
  schedulable: true,
  accountType: 'shared',
  dailyQuota: 0,
  quotaResetTime: '00:00',
  rateLimitDuration: 60,
  disableAutoProtection: false,
  capabilities: {
    stream: true,
    tools: true,
    vision: false,
    reasoning: true,
    includeUsage: true
  }
}
```

敏感字段 `apiKey` 必须 AES 加密存储，参考现有 `claudeAccountService.js` 和 `openaiResponsesAccountService.js`。

## API Key 权限

当前 API Key 的 `permissions` 已支持数组，可以扩展为：

```js
permissions: ['claude', 'openai', 'deepseek', 'glm']
```

权限判断建议：

| 路由            | 需要权限   |
| --------------- | ---------- |
| `/api/...`      | `claude`   |
| `/openai/...`   | `openai`   |
| `/deepseek/...` | `deepseek` |
| `/glm/...`      | `glm`      |
| `/kimi/...`     | `kimi`     |

需要注意历史兼容：当前空权限数组表示全部服务。新增平台后，历史“全部权限”API Key 是否自动获得新平台权限需要明确策略。

推荐策略：

1. 更安全：新增配置控制新平台是否默认对历史全权限 Key 开放。
2. 或做一次迁移：把历史空权限显式展开为当前已有平台，再由管理员手动开启新平台。

## API Key 账号绑定

不建议继续新增大量固定字段，例如 `deepseekAccountId`、`glmAccountId`、`kimiAccountId`。长期建议新增通用 JSON 绑定字段：

```js
accountBindings: {
  claude: {
    mode: 'shared',
    accountId: ''
  },
  openai: {
    mode: 'shared',
    accountId: ''
  },
  deepseek: {
    mode: 'shared',
    accountId: ''
  },
  glm: {
    mode: 'shared',
    accountId: ''
  }
}
```

第一版可以降低范围：

- 只做 API Key 多平台权限。
- 国产模型账号全部走 shared pool 和账号组调度。
- 暂不支持 API Key 绑定指定 DeepSeek/GLM 账号。

## 调度设计

DeepSeek、GLM、Kimi 等平台共用一个调度器，但调度必须带 provider。

```js
selectAccountForApiKey(apiKeyData, {
  provider: 'deepseek',
  model,
  sessionHash
})
```

调度过滤条件：

1. `account.provider` 匹配请求平台。
2. `isActive === true`。
3. `schedulable === true`。
4. 未被临时限流或临时不可用。
5. 未超过每日额度。
6. 如果 API Key 后续支持绑定，则只在绑定账号或账号组内选择。

粘性会话 Key 必须带 provider，避免跨平台污染：

```text
openai_compatible_session_mapping:deepseek:{sessionHash}
openai_compatible_session_mapping:glm:{sessionHash}
```

## Relay 设计

OpenAI-compatible relay 主要职责：

1. 校验 API Key 是否具备对应平台权限。
2. 通过调度器选择对应 provider 的账号。
3. 解密账号 API Key，构造上游请求。
4. 按 provider 清洗或转换请求字段。
5. 转发普通 JSON 或 SSE 流式响应。
6. 捕获 `usage`，记录 API Key 和账号用量。
7. 根据上游错误标记账号限流、异常或临时不可用。

DeepSeek/GLM 第一版建议只支持 Chat Completions，不接 Responses API。

对于流式请求，如果 provider 支持，应自动补：

```js
stream_options: {
  include_usage: true
}
```

然后在 SSE 中捕获最后一个 `usage` chunk，并在响应结束后记录用量。

## 计费设计

新增平台必须复用现有计费链路，核心入口是：

```js
apiKeyService.recordUsageWithDetails(
  req.apiKey.id,
  usage,
  model,
  account.id,
  'deepseek',
  extra,
  requestMeta
)
```

GLM 请求传入：

```js
accountType = 'glm'
```

这样可以复用现有能力：

- API Key token 统计
- API Key 每日/月度成本统计
- 账户级 token 统计
- usage record 明细
- request detail 捕获
- billing event 发布
- 费率倍率扣费
- rate limit cost 计数

需要扩展的位置：

```text
src/services/apiKeyService.js
src/services/serviceRatesService.js
src/services/requestDetailService.js
src/routes/admin/usageStats.js
src/utils/rateLimitHelper.js
```

## 服务倍率

`src/services/serviceRatesService.js` 需要增加新服务默认倍率：

```js
rates: {
  claude: 1.0,
  codex: 1.0,
  gemini: 1.0,
  droid: 1.0,
  bedrock: 1.0,
  azure: 1.0,
  ccr: 1.0,
  deepseek: 1.0,
  glm: 1.0,
  kimi: 1.0
}
```

同时扩展服务推断：

```js
getServiceFromAccountType('deepseek') -> 'deepseek'
getServiceFromAccountType('glm') -> 'glm'
getServiceFromAccountType('kimi') -> 'kimi'

getServiceFromModel('deepseek-*') -> 'deepseek'
getServiceFromModel('glm-*') -> 'glm'
getServiceFromModel('kimi-*' / 'moonshot-*') -> 'kimi'
```

## 模型价格

当前价格计算依赖：

```text
data/model_pricing.json
resources/model-pricing/model_prices_and_context_window.json
src/services/pricingService.js
```

要求：

1. `deepseek-chat`、`deepseek-reasoner`、`glm-*` 等模型必须有价格条目。
2. 价格字段使用 `input_cost_per_token` 和 `output_cost_per_token`。
3. 如果上游官方价格是人民币，应统一换算成 USD 存储，保持现有 `realCost/ratedCost` 口径一致。
4. 若价格表缺失模型，请求可以成功，但成本会为 0，并应输出告警。

## 用量提取

OpenAI-compatible 非流式响应一般包含：

```js
usage: {
  ;(prompt_tokens, completion_tokens, total_tokens)
}
```

需要转换为系统内部格式：

```js
{
  input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
  output_tokens: usage.completion_tokens || usage.output_tokens || 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0
}
```

流式响应需要从 SSE chunk 中捕获 `usage`。如果 provider 不返回 usage：

1. 第一版不做估算扣费，记录 `missing usage` 警告。
2. 后续可以引入 tokenizer 估算，但估算计费需要单独标记，避免与真实上游账单混淆。

## 错误处理

OpenAI-compatible relay 应接入现有账号保护逻辑：

| 状态码                  | 建议处理                                    |
| ----------------------- | ------------------------------------------- |
| `401 / 403`             | 账号认证失败，标记 unauthorized 或 disabled |
| `429`                   | 账号临时限流                                |
| `500 / 502 / 503 / 529` | 账号临时不可用，按配置恢复                  |
| `400`                   | 多数是请求或模型参数错误，不应直接禁用账号  |

可复用：

```text
src/utils/upstreamErrorHelper.js
```

## 后台管理

后端管理路由建议新增：

```text
GET    /admin/openai-compatible-accounts
POST   /admin/openai-compatible-accounts
PUT    /admin/openai-compatible-accounts/:id
DELETE /admin/openai-compatible-accounts/:id
PUT    /admin/openai-compatible-accounts/:id/toggle
PUT    /admin/openai-compatible-accounts/:id/toggle-schedulable
POST   /admin/openai-compatible-accounts/:id/reset-status
POST   /admin/openai-compatible-accounts/:accountId/test
```

前端需要更新：

```text
web/admin-spa/src/views/AccountsView.vue
web/admin-spa/src/views/ApiKeysView.vue
web/admin-spa/src/components/apikeys/CreateApiKeyModal.vue
web/admin-spa/src/components/apikeys/EditApiKeyModal.vue
web/admin-spa/src/views/DashboardView.vue
web/admin-spa/src/utils/http_apis.js
web/admin-spa/src/stores/accounts.js
```

展示建议：

- 账号管理中显示逻辑平台 `DeepSeek`、`GLM`，而不是只显示 `OpenAI-compatible`。
- API Key 权限中新增 `DeepSeek`、`GLM`。
- 用量统计和请求明细支持按 `accountType` / `provider` 筛选。
- 服务倍率配置支持 `deepseek`、`glm`。

## 落地顺序

第一阶段：后端 MVP

1. 新增 provider registry。
2. 新增 OpenAI-compatible 账号服务。
3. 新增 OpenAI-compatible 调度器。
4. 新增 OpenAI-compatible relay。
5. 新增 `/deepseek/v1/chat/completions` 和 `/glm/v1/chat/completions`。
6. 接入 API Key 权限校验。
7. 接入 `recordUsageWithDetails()` 和 rate limit cost 计数。

第二阶段：统计和后台

1. 扩展 `apiKeyService` 的账号类型和历史用量解析。
2. 扩展 `serviceRatesService`。
3. 扩展 `requestDetailService` 和 `usageStats`。
4. 补充 DeepSeek/GLM 模型价格。
5. 增加后台账号管理和 API Key 权限选择。

第三阶段：增强兼容性

1. 支持 Kimi、Qwen 等更多 provider。
2. 支持 API Key 对国产平台绑定指定账号或账号组。
3. 为 `/v1/chat/completions` 增加智能模型路由。
4. 评估是否支持 Responses API 到 Chat Completions 的转换。
5. 增加流式 usage 缺失时的估算策略。

## 第一版建议范围

第一版建议控制范围如下：

- 一个 API Key 支持多平台权限。
- DeepSeek 和 GLM 通过独立 route 提供服务。
- DeepSeek 和 GLM 共用 OpenAI-compatible relay。
- DeepSeek 和 GLM 账号先走 shared pool 调度。
- 请求正常记录 token、真实成本、倍率成本和请求明细。
- 暂不支持 Responses API 转国产模型。
- 暂不支持每个 API Key 绑定指定 DeepSeek/GLM 账号。

## 官方文档参考

- DeepSeek API Docs: <https://api-docs.deepseek.com/>
- 智谱 GLM OpenAI 兼容文档: <https://docs.bigmodel.cn/cn/guide/develop/openai/introduction>
- Kimi API 快速开始: <https://platform.kimi.com/docs/guide/start-using-kimi-api>
- 阿里云百炼 OpenAI 兼容: <https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope>
