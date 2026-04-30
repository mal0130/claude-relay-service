# 多平台 API Key 与计费扩展方案

> 状态：讨论稿，当前收敛为 DeepSeek-first 方案  
> 目标：一个 `cr_xxx` API Key 同时支持 Claude、OpenAI、DeepSeek 等平台；客户端通过不同路由访问不同平台；系统保持统一认证、调度、统计和计费。

## 本轮决策

1. 第一版只实现 DeepSeek，架构保持可快速扩展到 GLM、Kimi、Qwen 等平台。
2. 国产模型客户端主要使用 `@ai-sdk/openai-compatible` 调用本 relay，而不是直接调用上游。
3. Platform/Adapter 注册表不保存 `baseApi`、`apiKey` 等账号参数；这些参数由管理员在后台录入账号时填写。
4. DeepSeek 第一版按现有平台方式建模：新增 DeepSeek 平台，下设一个具体类型 `DeepSeek API / 标准 API`；不再拆分 `official / aliyun / custom` 这类上游服务商维度。
5. DeepSeek 账号字段尽量与现有 Claude、OpenAI、Gemini、Droid 账号字段对齐；没有预设账号，只提供后台表单录入。
6. 新的 `accountBindings` 只用于 DeepSeek、GLM、Kimi 等新增平台；Claude、OpenAI、Gemini、Droid 继续保持现有绑定字段和逻辑。
7. DeepSeek 价格自动更新应接入现有 price mirror 流程，而不是在业务请求链路中实时抓官方页面。

## 背景

当前系统已经具备 API Key 认证、账户调度、用量统计、成本计算、倍率扣费、账号级统计和请求明细等基础能力。但平台和账号类型在多处仍是硬编码，例如：

- `src/routes/unified.js` 主要按模型名前缀识别 `claude / gemini / gpt`。
- `src/services/apiKeyService.js` 中账号类型、权限分类、绑定字段和账号解析逻辑是静态映射。
- `src/services/serviceRatesService.js` 中服务倍率只覆盖现有服务。
- `src/services/requestDetailService.js`、`src/routes/admin/usageStats.js` 等统计展示需要显式识别账号类型。

新增 DeepSeek、GLM、Kimi、Qwen 等国产模型时，不建议为每个平台复制完整一套 relay 逻辑；但在后台和数据模型上，仍应像 Claude、OpenAI 这类现有平台一样使用清晰的一等平台类型。

## 核心目标

1. 一个 `cr_xxx` API Key 可以同时拥有多个平台权限。
2. 不同平台通过不同路由进入，路由优先决定后端平台。
3. 每个平台请求都复用现有 API Key 认证链。
4. 每个平台请求都能正常记录 token、成本、倍率成本、账号用量和请求明细。
5. 国产模型先复用 OpenAI Chat Completions 兼容协议，不强行接入 OpenAI Responses。
6. DeepSeek 第一版可用后，后续能低成本扩展 `glm / kimi / qwen / hunyuan / minimax / siliconflow / openrouter` 等平台。

## 客户端接入方式

国产模型客户端优先使用 `@ai-sdk/openai-compatible` 调用 relay。SDK 的 `baseURL` 指向本服务的平台路由，`apiKey` 使用本系统的 `cr_xxx`，不是上游 DeepSeek 原始 key。

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'

const deepseek = createOpenAICompatible({
  name: 'relay-deepseek',
  baseURL: 'https://relay.example.com/deepseek/v1',
  apiKey: process.env.CRS_API_KEY,
  includeUsage: true
})

const result = await generateText({
  model: deepseek('deepseek-v4-flash'),
  prompt: '你好'
})
```

注意：relay 内部不建议使用 AI SDK 调上游。中转服务需要精确控制 headers、SSE 透传、AbortController、错误处理、usage 捕获、账号限流和日志脱敏，直接使用 `axios` 或原生 `fetch` 更可控。

## 推荐路由

采用 route-first 分发，避免模型别名导致后端识别错误。

| 路由                                 | 平台           | 协议                               | 第一版 |
| ------------------------------------ | -------------- | ---------------------------------- | ------ |
| `POST /api/v1/messages`              | Claude         | Anthropic Messages                 | 已有   |
| `POST /openai/v1/responses`          | OpenAI / Codex | OpenAI Responses                   | 已有   |
| `POST /openai/v1/chat/completions`   | OpenAI         | OpenAI Chat Completions            | 已有   |
| `POST /deepseek/v1/chat/completions` | DeepSeek       | OpenAI-compatible Chat Completions | 新增   |
| `POST /glm/v1/chat/completions`      | GLM            | OpenAI-compatible Chat Completions | 后续   |
| `POST /kimi/v1/chat/completions`     | Kimi           | OpenAI-compatible Chat Completions | 后续   |

`POST /api/v1/chat/completions` 或 `POST /v1/chat/completions` 可以保留智能路由能力，但只作为辅助入口。主路径应以显式平台路由为准。

## 后台平台模型

后台平台选择应保持现有模式：先选平台，再选该平台下的具体类型。DeepSeek 第一版只有一个具体类型：标准 API。

```text
平台：DeepSeek
具体平台类型：DeepSeek API / 标准 API
```

这和 Claude 当前的模式一致：Claude 平台下有 Claude Code、Claude Console、Bedrock、CCR 等具体类型。DeepSeek 后续如果真的出现需要差异化支持的类型，再新增具体类型；第一版不按 `官方 / 阿里云 / 自定义` 拆分类型。

实现上可以复用 OpenAI-compatible adapter，但后台和数据统计中不要把用户可见平台显示为 `OpenAI-compatible`。

## Platform/Adapter 注册表

Platform/Adapter 注册表只描述平台协议、权限、模型匹配和适配能力，不保存 `baseApi`、`apiKey`、代理等账号参数。

注册表解决的是“这个平台怎么被系统识别和适配”的问题：

- 路由知道 `/deepseek/...` 需要走 DeepSeek 适配器。
- 权限知道该路由需要 `deepseek` 权限。
- 调度器知道需要筛选 `platform=deepseek` 的账号。
- relay 知道 DeepSeek 的请求字段、usage 字段、stream usage 行为。
- 计费知道该平台默认服务倍率、模型别名和 usage 映射。
- 后续扩展 GLM/Kimi 时，只增加 adapter 配置和少量 platform-specific transform。

注册表不应该解决“具体打到哪个上游地址”的问题。这个问题属于账号配置，由管理员在管理后台录入。

第一版注册表示例：

```js
{
  deepseek: {
    label: 'DeepSeek',
    routePrefix: '/deepseek',
    permission: 'deepseek',
    accountType: 'deepseek',
    accountSubType: 'deepseek-api',
    accountSubTypeLabel: '标准 API',
    protocol: 'openai-compatible-chat',
    modelPatterns: ['deepseek-*'],
    modelAliases: {
      'deepseek-chat': 'deepseek-v4-flash',
      'deepseek-reasoner': 'deepseek-v4-flash'
    },
    requestProfile: 'deepseek-chat-completions',
    usageMapper: 'deepseek-chat-usage',
    pricingFamily: 'deepseek',
    capabilities: {
      stream: true,
      tools: true,
      jsonOutput: true,
      reasoning: true,
      promptCacheUsage: true,
      includeUsageInStream: true
    }
  }
}
```

## 账号模型

DeepSeek 账号应尽量与现有平台账号字段对齐。第一版建议新增 DeepSeek 一等账号服务，例如：

```text
src/services/account/deepseekAccountService.js
src/services/scheduler/unifiedDeepSeekScheduler.js
src/services/relay/deepseekRelayService.js
src/routes/deepseekRoutes.js
src/routes/admin/deepseekAccounts.js
```

其中 `deepseekRelayService` 内部可以复用通用 OpenAI-compatible 转发工具，避免重复实现 SSE、usage 和错误处理。

账号 Redis 前缀建议使用平台专属前缀，保持现有风格：

```text
deepseek:account:{id}
shared_deepseek_accounts
```

账号字段建议：

```js
{
  id,
  platform: 'deepseek',
  accountType: 'shared',
  accountSubType: 'deepseek-api',
  name,
  description,
  baseApi: 'https://api.deepseek.com',
  apiKey: '<AES encrypted>',
  priority: 50,
  proxy: null,
  isActive: true,
  schedulable: true,
  dailyQuota: 0,
  quotaResetTime: '00:00',
  rateLimitDuration: 60,
  disableAutoProtection: false,
  createdAt: '<ISO time>',
  lastUsedAt: '',
  status: 'active',
  errorMessage: '',
  rateLimitedAt: '',
  rateLimitStatus: '',
  quotaStoppedAt: ''
}
```

字段说明：

- `baseApi` 由管理员录入，默认可填 `https://api.deepseek.com`，但这只是表单默认值，不是 Provider 注册表配置。
- DeepSeek 官方标准接口路径固定为 `/chat/completions`，第一版不必把 `chatPath` 暴露为账号字段；如果后续需要兼容特殊网关，再增加可选字段。
- 不增加 `upstreamVendor`，不同服务商可以通过账号名称、`baseApi` 和代理配置区分。
- 不增加账号预设列表，所有账号都由管理员在管理后台录入。
- `apiKey` 必须 AES 加密存储，参考现有 `claudeAccountService.js` 和 `openaiResponsesAccountService.js`。
- 如果后续需要账号级模型白名单、价格覆盖、额外 headers，可以作为后续扩展，不进入第一版 MVP。

## API Key 权限

当前 API Key 的 `permissions` 已支持数组，DeepSeek 第一版扩展为：

```js
permissions: ['claude', 'openai', 'deepseek']
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

推荐策略：新增配置控制新平台是否默认对历史全权限 Key 开放；更安全的默认值是不开启，由管理员显式给 API Key 增加 `deepseek` 权限。

## API Key 账号绑定

Claude、OpenAI、Gemini、Droid 等现有平台继续保持现有字段和逻辑，例如 `claudeAccountId`、`openaiAccountId`、`geminiAccountId`、`droidAccountId`，不迁移到新结构。

新的 `accountBindings` 只用于 DeepSeek、GLM、Kimi、Qwen 等新增平台，避免继续新增大量固定字段：

```js
accountBindings: {
  deepseek: {
    mode: 'shared',
    accountId: ''
  },
  glm: {
    mode: 'shared',
    accountId: ''
  },
  kimi: {
    mode: 'shared',
    accountId: ''
  }
}
```

第一版降低范围：

- 只做 API Key 多平台权限。
- DeepSeek 账号全部走 shared pool 和账号组调度。
- 可以先设计 `accountBindings.deepseek` 字段，但后台不一定第一版开放绑定能力。
- 暂不支持 API Key 绑定指定 DeepSeek 账号。

## 调度设计

DeepSeek 第一版使用专属调度器，行为与现有平台调度器保持一致；内部可复用通用 OpenAI-compatible 选择逻辑。

```js
selectAccountForApiKey(apiKeyData, {
  model,
  sessionHash
})
```

调度过滤条件：

1. 只选择 DeepSeek 账号池中的账号。
2. `isActive === true`。
3. `schedulable === true`。
4. 未被临时限流或临时不可用。
5. 未超过每日额度。
6. 如果后续支持 `accountBindings.deepseek`，则只在绑定账号或账号组内选择。

粘性会话 Key 必须带平台，避免跨平台污染：

```text
deepseek_session_mapping:{sessionHash}
```

## DeepSeek Relay 设计

DeepSeek 官方对话补全接口是：

```text
POST /chat/completions
```

本服务第一版新增：

```text
POST /deepseek/v1/chat/completions
```

relay 根据选中账号转发到：

```text
{account.baseApi}/chat/completions
```

如果账号录入 DeepSeek 官方地址，则等价于：

```text
https://api.deepseek.com/chat/completions
```

主要职责：

1. 校验 API Key 是否具备 `deepseek` 权限。
2. 通过调度器选择 DeepSeek 账号。
3. 解密账号 API Key，构造上游请求。
4. 清洗或转换 DeepSeek 不支持的请求字段。
5. 转发普通 JSON 或 SSE 流式响应。
6. 捕获 `usage`，记录 API Key 和账号用量。
7. 根据上游错误标记账号限流、异常或临时不可用。

对于流式请求，如果账号能力未显式禁用，应自动补：

```js
stream_options: {
  include_usage: true
}
```

DeepSeek 文档说明：开启 `include_usage` 后，在 `data: [DONE]` 前会额外传输一个包含完整 usage 的 chunk，且该 chunk 的 `choices` 为空数组；其他 chunk 的 `usage` 为 `null`。

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

`src/services/serviceRatesService.js` 需要增加 DeepSeek 默认倍率：

```js
rates: {
  claude: 1.0,
  codex: 1.0,
  gemini: 1.0,
  droid: 1.0,
  bedrock: 1.0,
  azure: 1.0,
  ccr: 1.0,
  deepseek: 1.0
}
```

同时扩展服务推断：

```js
getServiceFromAccountType('deepseek') -> 'deepseek'
getServiceFromModel('deepseek-*') -> 'deepseek'
```

后续扩展 GLM/Kimi 时再加入：

```js
getServiceFromAccountType('glm') -> 'glm'
getServiceFromAccountType('kimi') -> 'kimi'
getServiceFromModel('glm-*') -> 'glm'
getServiceFromModel('kimi-*' / 'moonshot-*') -> 'kimi'
```

## DeepSeek 用量提取

OpenAI-compatible 非流式响应一般包含：

```js
usage: {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120
}
```

DeepSeek usage 还包含上下文缓存字段：

```js
usage: {
  prompt_tokens: 100,
  prompt_cache_hit_tokens: 30,
  prompt_cache_miss_tokens: 70,
  completion_tokens: 20,
  total_tokens: 120
}
```

需要转换为系统内部格式：

```js
function mapDeepSeekUsage(usage = {}) {
  const hitTokens = Number(usage.prompt_cache_hit_tokens || 0)
  const missTokens = Number(usage.prompt_cache_miss_tokens || 0)
  const hasCacheBreakdown = hitTokens > 0 || missTokens > 0

  return {
    input_tokens: hasCacheBreakdown ? missTokens : Number(usage.prompt_tokens || 0),
    output_tokens: Number(usage.completion_tokens || 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: hitTokens
  }
}
```

如果同时有 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`，不要再把完整 `prompt_tokens` 重复计入 `input_tokens`，否则会重复计费。

流式响应需要从 SSE chunk 中捕获最后一个带完整 `usage` 的 chunk。如果 provider 或账号能力不返回 usage：

1. 第一版不做估算扣费，记录 `missing usage` 警告。
2. 后续可以引入 tokenizer 估算，但估算计费需要单独标记，避免与真实上游账单混淆。

## DeepSeek 模型价格自动更新

当前价格计算依赖：

```text
data/model_pricing.json
resources/model-pricing/model_prices_and_context_window.json
src/services/pricingService.js
config/pricingSource.js
```

现有机制：

1. `pricingService` 从 `config/pricingSource.js` 指定的远端 JSON 下载价格。
2. 默认远端是 GitHub `price-mirror` 分支上的 `model_prices_and_context_window.json`。
3. 本地写入 `data/model_pricing.json`。
4. 每 24 小时常规更新一次。
5. 每 10 分钟拉取远端 hash，对比变更后自动下载。

DeepSeek 自动更新推荐接入现有 price mirror 流程：

```text
DeepSeek 官方价格页
  -> price-mirror 定时脚本抓取/解析
  -> 生成统一 model_pricing.json
  -> 生成 sha256
  -> relay 服务自动 hash 检测并下载
```

不建议业务服务在请求链路或启动链路直接抓 DeepSeek 官网。原因：

- 当前系统已有统一价格源和 hash 更新机制。
- 避免业务进程依赖网页结构变化。
- 避免每个部署实例重复抓取官方页面。
- 价格变动应在 price mirror 中审计、生成 hash，再由服务自动同步。

DeepSeek 官方价格页当前提供人民币/百万 tokens 价格，并区分缓存命中输入、缓存未命中输入和输出。价格 mirror 需要转换成现有 pricingService 可消费的 USD/token 字段：

```js
{
  'deepseek-v4-flash': {
    litellm_provider: 'deepseek',
    input_cost_per_token: '<缓存未命中 CNY/百万 -> USD/token>',
    cache_read_input_token_cost: '<缓存命中 CNY/百万 -> USD/token>',
    output_cost_per_token: '<输出 CNY/百万 -> USD/token>',
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    source_currency: 'CNY'
  }
}
```

第一版建议：

1. price mirror 抓取 DeepSeek 官方价格页。
2. 只取当前有效价格，忽略删除线旧价格。
3. 将 CNY/百万 tokens 换算为 USD/token 后写入 JSON，保持系统现有 `$` 口径。
4. 对 `deepseek-chat`、`deepseek-reasoner` 生成兼容条目或 alias，避免旧客户端请求成本为 0。
5. 对促销价保留 `valid_until`、`source_updated_at` 等元数据，方便后续审计。

币种处理建议：

- MVP：price mirror 负责换算，业务服务仍只消费 USD/token。
- 增强版：pricing schema 增加 `currency`、`exchange_rate`、`effective_at`，由 `pricingService` 统一换算。

如果未来需要支持与官方定价不同的 DeepSeek 兼容服务商，再考虑增加账号级价格覆盖或独立 pricing profile；这不是第一版范围。

## 错误处理

DeepSeek relay 应接入现有账号保护逻辑：

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
GET    /admin/deepseek-accounts
POST   /admin/deepseek-accounts
PUT    /admin/deepseek-accounts/:id
DELETE /admin/deepseek-accounts/:id
PUT    /admin/deepseek-accounts/:id/toggle
PUT    /admin/deepseek-accounts/:id/toggle-schedulable
POST   /admin/deepseek-accounts/:id/reset-status
POST   /admin/deepseek-accounts/:accountId/test
```

第一版前端需要更新：

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

- 平台选择新增 `DeepSeek` 卡片。
- 具体平台类型新增 `DeepSeek API / 标准 API`，第一版只有这一个类型。
- 添加账号表单由管理员填写 `name`、`description`、`baseApi`、`apiKey`、`proxy`、`priority`、`dailyQuota`、`rateLimitDuration` 等字段。
- 不提供 `官方 / 阿里云 / 自定义` 预设账号分类。
- API Key 权限中新增 `DeepSeek`。
- 用量统计和请求明细支持按 `accountType=deepseek` 筛选。
- 服务倍率配置支持 `deepseek`。

## 落地顺序

第一阶段：DeepSeek 后端 MVP

1. 新增 Platform/Adapter registry，只包含 DeepSeek。
2. 新增 DeepSeek 账号服务，字段尽量对齐现有账号服务。
3. 新增 DeepSeek 调度器，第一版只筛选 DeepSeek 账号。
4. 新增 DeepSeek relay，内部复用 OpenAI-compatible 转发工具。
5. 新增 `/deepseek/v1/chat/completions`。
6. 接入 API Key `deepseek` 权限校验。
7. 接入 DeepSeek usage mapper。
8. 接入 `recordUsageWithDetails()` 和 rate limit cost 计数。

第二阶段：统计、价格和后台

1. 扩展 `apiKeyService` 的新增平台账号类型和历史用量解析。
2. 为新增平台设计 `accountBindings`，但不迁移现有平台绑定字段。
3. 扩展 `serviceRatesService`。
4. 扩展 `requestDetailService` 和 `usageStats`。
5. 将 DeepSeek 官方价格自动更新接入 price mirror。
6. 增加后台账号管理和 API Key 权限选择。

第三阶段：增强兼容性

1. 支持 GLM、Kimi、Qwen 等更多平台。
2. 支持 API Key 对新增平台绑定指定账号或账号组。
3. 为 `/v1/chat/completions` 增加智能模型路由。
4. 评估是否支持 Responses API 到 Chat Completions 的转换。
5. 增加流式 usage 缺失时的估算策略。
6. 如确有需要，再支持账号级自定义 headers、path、价格覆盖等高级能力。

## 第一版建议范围

第一版建议控制范围如下：

- 一个 API Key 支持 `claude / openai / deepseek` 多平台权限。
- DeepSeek 通过独立 route `/deepseek/v1/chat/completions` 提供服务。
- 后台新增 DeepSeek 平台和 `DeepSeek API / 标准 API` 类型。
- DeepSeek 账号字段尽量与现有平台账号字段对齐。
- DeepSeek 账号先走 shared pool 调度。
- 请求正常记录 token、真实成本、倍率成本和请求明细。
- 暂不支持 Responses API 转 DeepSeek。
- 暂不支持每个 API Key 绑定指定 DeepSeek 账号。
- 暂不实现 GLM/Kimi，仅保留扩展位。

## 官方文档参考

- AI SDK OpenAI Compatible Provider: <https://ai-sdk.dev/providers/openai-compatible-providers>
- DeepSeek 对话补全接口: <https://api-docs.deepseek.com/zh-cn/api/create-chat-completion>
- DeepSeek 模型与价格: <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
- 智谱 GLM OpenAI 兼容文档: <https://docs.bigmodel.cn/cn/guide/develop/openai/introduction>
- Kimi API 快速开始: <https://platform.kimi.com/docs/guide/start-using-kimi-api>
- 阿里云百炼 OpenAI 兼容: <https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope>
