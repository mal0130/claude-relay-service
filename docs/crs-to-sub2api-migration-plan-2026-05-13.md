# CRS 迁移到 sub2api 工作评估与实施计划

> 状态：计划细化稿，待确认。计划完全确认前不进入业务代码实现。
> 参考：`docs/fork-upstream-change-summary-2026-05-12.md` 的“主要改动详述”1-8 点；第 9/10/11 点按当前要求暂不纳入迁移范围。

## 1. 已确认迁移原则

- 保留现有外部 `cr_...` API Key，不要求客户按平台重新分发 Key。
- 保留 CRS 的“同一个 API Key 可访问多个平台，并以 API Key 为唯一计费主体”的业务语义。
- sub2api 当前“一个 API Key 绑定一个 group/platform”的模型不能直接承接 CRS，需要新增 CRS 兼容层。
- DeepSeek 默认作为 OpenAI-compatible upstream/group 接入 sub2api，不优先新增独立顶层平台，但后台和统计需要能以 DeepSeek 维度展示。
- 外部业务系统迁移为读取 sub2api 提供的稳定 API、Postgres view 或 Webhook，不继续读取 CRS Redis 内部 key 结构。
- 历史明细不完整导入：CRS Redis 保留只读归档；sub2api 只导入余额、额度、累计成本、Key/账号映射等迁移所需状态。

## 2. sub2api 现状与核心差距

| 维度 | sub2api 现状 | 与 CRS 的差距 | 迁移方向 |
| --- | --- | --- | --- |
| API Key | `api_keys.key` 保存明文 Key，`group_id` 只绑定一个 group | CRS Key 只存 hash，且同 Key 跨 Claude/OpenAI/Gemini/DeepSeek 多平台 | 增加 legacy hash lookup 和多平台 binding，保留标准 sub2api Key 行为 |
| 平台选择 | 主要由 Key 所属 group 的 `platform` 决定 | CRS 由请求入口和 Key 权限共同决定平台 | 在认证后、调度前增加 platform resolver，按路径/协议选 binding |
| 计费 | `usage_logs.total_cost` + `actual_cost`，存在 group/user/account 倍率 | CRS 业务计费以 API Key 为中心，平台倍率不同，不能双重相乘 | CRS 兼容 Key 的最终倍率由 binding/serviceRates 计算并写 usage log |
| 限额 | API Key 只有 5h/1d/7d 成本窗口 | CRS 支持任意多窗口 request/cost 限制和资源包切换 | 增加多窗口规则与运行时计数，兼容现有 5h/1d/7d 字段 |
| 用量日志 | `usage_logs` 有 token/cost/model/account/group/request_id 等字段 | CRS 额外有 session/userInput/processType/projectType/assistantContent 等 | 小字段进入 `usage_logs.extra` 或扩展列，大内容进入 request detail 表 |
| OpenAI Codex 用量 | 已能解析部分 `x-codex-*` 快照到 `account.extra` | CRS 还有自动停止调度、自动恢复、阈值、通知、UI 状态 | 补齐保护策略和调度排除逻辑，复用现有 snapshot |
| DeepSeek | 可按 OpenAI-compatible 思路承接，但未形成 CRS 兼容闭环 | CRS 是一等平台，有路由、账号、统计、价格、cache hit/miss | 以 platform alias + OpenAI-compatible gateway 承接，补 usage/pricing/同步 |
| 外部同步 | 有 Postgres/服务 API 基础 | 业务系统原来直接读 CRS Redis | 提供稳定 API/view/Webhook 和 legacy id 映射 |

## 3. 统一前置设计：CRS API Key 兼容层与统一计费

这是迁移成败的核心工作，优先级高于各平台细节。

### 3.1 API Key 兼容模型

- 新增 legacy Key 索引：保存 `legacy_crs_key_id`、`key_hash`、`source=crs`、`api_key_id`、状态和迁移批次；不保存已有 `cr_...` 明文。
- 保留 sub2api 原生 Key：非 `cr_` 或未命中 legacy hash 的 Key 继续走现有 `api_keys.key` 明文查找，避免破坏原功能。
- 新增 Key 元数据：`external_uid`、`tags`、`pack_consent`、`translate_reasoning`、`legacy_permissions`、`legacy_client_restrictions`、`legacy_model_blacklist`。
- 新增多平台 binding：一个 `api_key_id` 可以绑定多条平台记录，字段至少包括 `platform/service`、`group_id`、`account_id/group_ref`、`enabled`、`rate_multiplier`、`binding_mode`、`legacy_account_id`、`metadata`。
- 平台解析顺序：先根据路由/协议识别目标平台，再校验 Key 是否有该平台 binding、权限、客户端限制、模型黑名单、余额和限额。

### 3.2 计费口径

CRS 兼容 Key 的目标公式：

```text
raw_model_cost -> service/global rate -> API Key 平台倍率 -> billed actual_cost
```

- `usage_logs.api_key_id` 始终写同一个逻辑 Key，保证业务系统按 Key 统一计费。
- `usage_logs.group_id` 写本次请求选中的平台 group，保证平台、账号、模型维度可拆分统计。
- CRS 兼容 Key 的 `usage_logs.rate_multiplier` 写最终扣费倍率；避免再叠加 sub2api group/user multiplier。
- `usage_logs.account_rate_multiplier` 可继续作为账号维度成本快照，但不影响 API Key 扣费口径。
- quota、余额、多窗口 cost 限制必须按最终 `actual_cost` 消耗，不能按原始 `total_cost` 消耗。

### 3.3 路由到 binding 的建议映射

| 请求入口/协议 | CRS 平台语义 | sub2api 目标 | 备注 |
| --- | --- | --- | --- |
| Anthropic Messages / Claude Code | `claude`/`cc` | Claude/Anthropic group binding | 保留客户端限制、模型黑名单、粘性/并发语义 |
| OpenAI Chat/Responses/Codex | `codex`/`openai` | OpenAI group binding | 兼容 Codex usage protection 和 Responses 适配 |
| Gemini API | `gemini` | Gemini group binding | 保留 Gemini CLI header key 兼容 |
| DeepSeek OpenAI-compatible | `deepseek` | DeepSeek alias 的 OpenAI-compatible group | 保留 `/deepseek/v1/chat/completions` |
| DeepSeek Anthropic-compatible | `deepseek` | DeepSeek alias + Anthropic adapter 或协议转换 | 保留 `/deepseek/anthropic/v1/messages` |

## 4. 主要改动点对点迁移方案

### 4.1 DeepSeek 平台支持

**CRS 能力**

- 独立 DeepSeek 账户实体、AES 加密 API Key、状态管理和调度器。
- 独立路由 `/deepseek/v1/chat/completions` 和 `/deepseek/anthropic/v1/messages`。
- DeepSeek 模型标准化、usage 归一化、cache hit/miss 成本、价格抓取和 fallback 定价。
- API Key 权限、账号绑定、账号组、统计、请求明细和前端后台全部支持 `deepseek`。

**sub2api 现状与差距**

- sub2api 已有通用 account/group/channel/gateway 能力，适合承接 OpenAI-compatible provider。
- 当前还缺少 CRS 兼容的 DeepSeek 路由别名、DeepSeek 账号导入映射、cache hit/miss usage 解析、DeepSeek 维度统计和 Partner API 字段兼容。

**迁移方案**

- 不新增顶层 `PlatformDeepSeek` 作为第一选择；新增 `platform_alias=deepseek` 或等价 metadata，底层仍使用 OpenAI-compatible group/account/channel。
- 保留 CRS 外部路由：
  - `POST /deepseek/v1/chat/completions` 转到 OpenAI-compatible chat completions gateway。
  - `POST /deepseek/anthropic/v1/messages` 转到 DeepSeek Anthropic-compatible 路径；如 sub2api 现有链路不能直接支持，则先做路由兼容层和协议转换评估。
- DeepSeek 账号导入为 sub2api account：`platform=openai_compatible` 或现有可复用平台，`extra.provider_alias=deepseek`、`extra.legacy_crs_account_id`、`credentials.api_key` 加密保存。
- DeepSeek group 作为平台 binding 目标：API Key 的 `deepseek` binding 指向该 group，可选绑定具体 account 或 group。
- usage 解析补齐：
  - `prompt_cache_hit_tokens` -> `cache_read_tokens`。
  - `prompt_cache_miss_tokens` -> billable input tokens。
  - 有 hit/miss breakdown 时不要再把完整 `prompt_tokens` 重复计入 input。
  - 流式响应捕获 `[DONE]` 前的 usage chunk；缺 usage 时记录 warning，不默认估算扣费。
- 定价补齐：`deepseek-chat`、`deepseek-reasoner` 以及缓存命中/未命中价格必须进入 sub2api pricing/fallback；price mirror 可后续接入，但迁移上线必须有 fallback。
- 后台/UI 以 DeepSeek 展示：账号列表、Key binding、Dashboard、请求明细和统计筛选显示 `DeepSeek`，底层实现可仍是 OpenAI-compatible。

**数据和接口映射**

| CRS 字段/接口 | sub2api 目标 |
| --- | --- |
| DeepSeek account id | `accounts.extra.legacy_crs_account_id` |
| DeepSeek `apiKey` | `accounts.credentials.api_key`，加密/脱敏 |
| `baseApi` | account/channel base URL 或 `extra.base_api` |
| `rateLimitStatus` | `accounts.rate_limited_at`、`rate_limit_reset_at`、`extra.deepseek_rate_limit_status` |
| `serviceRates.deepseek` | API Key `deepseek` binding 的 `rate_multiplier` |
| `/admin/deepseek-accounts/*` | sub2api admin account API 的 DeepSeek alias 过滤/兼容路由 |
| DeepSeek usage records | `usage_logs` token/cost 字段 + `extra.provider_alias=deepseek` |

**验收标准**

- 同一个 `cr_...` Key 可以分别访问 Claude/OpenAI/DeepSeek，DeepSeek 请求写入同一个 `api_key_id` 和 DeepSeek group。
- DeepSeek 非流式/流式 usage 的 cache hit/miss 成本与 CRS 样本一致。
- DeepSeek 账号状态、限流、禁用、测试、统计在后台可见。
- DeepSeek 价格缺失时 dry-run 直接报错，不允许无价格静默上线。

### 4.2 合作伙伴 Partner API

**CRS 能力**

- `/partner` 路由使用签名认证：参数排序拼接后用 SHA-256 校验 `sign`。
- 支持创建、更新、批量更新 API Key，更新过期时间，查询用量汇总和近 30 天明细。
- 支持 `claude_account_id`、`openai_account_id`、`deepseek_account_id`，支持 `group:` 绑定。
- 支持 `claude_rate`、`openai_rate`、`deepseek_rate`、兼容字段 `rate`。
- 支持 `rateLimits`、`pack_consent`、`user_id`/`externalUid`。

**sub2api 现状与差距**

- sub2api 有 admin/API Key/usage 能力，但接口路径、签名方式和字段语义与 CRS Partner API 不等价。
- 如果直接让业务系统改用 sub2api admin API，会同时改认证、字段、计费语义和平台绑定，风险较高。

**迁移方案**

- 实现 `/partner` 兼容层，优先保持 CRS 的签名和字段契约；内部调用 sub2api service。
- 签名兼容 CRS：排除 `sign` 字段，参数按 key 排序，拼接后加 partner secret，SHA-256 后比较；失败日志只记录脱敏参数和计算阶段，不记录 secret。
- 创建 Key 时分两层：
  - 创建/关联 sub2api 逻辑 API Key。
  - 写入 CRS 兼容 metadata 和多平台 bindings。
- 更新接口按“未传字段不覆盖”处理，避免 Partner 批量更新时误清空某平台倍率或绑定。
- 用量接口从 `usage_logs` 聚合，返回 `legacy_crs_key_id`、平台、模型、token、原始成本、倍率后成本、窗口限制等 CRS 兼容字段。
- 近 30 天明细优先查询 sub2api 新日志；切换前历史仍由 CRS 只读归档提供，必要时在业务侧展示“切换前/切换后”来源。

**接口映射**

| CRS Partner API | sub2api 迁移目标 | 说明 |
| --- | --- | --- |
| `POST /partner/api-key/create` | 兼容路由 + API Key service + binding service | 返回 legacy id 和新 `api_key_id` |
| `POST /partner/api-key/:keyId/update` | 兼容路由 + partial update | 支持倍率、绑定、限额、tags |
| `POST /partner/api-key/:keyId/expiration` | 兼容路由 + Key status/expires_at | 保留手动激活语义 |
| `POST /partner/api-key/update-config` | 批量兼容更新 | 单条失败要有明细结果 |
| `POST /partner/api-key/usage` | `usage_logs` 聚合/API view | 支持多个 Key |
| `POST /partner/api-key/usage-details` | daily/model 聚合 + request detail | 切换后数据来自 sub2api |

**字段映射**

| CRS 字段 | sub2api 目标 |
| --- | --- |
| `user_id` / `externalUid` | API Key metadata `external_uid` + 候选 Key 索引 |
| `claude_account_id` | `claude` binding 的 account/group ref |
| `openai_account_id` | `openai/codex` binding 的 account/group ref |
| `deepseek_account_id` | `deepseek` binding 的 account/group ref |
| `claude_rate` | `claude` binding `rate_multiplier` |
| `openai_rate` | `openai/codex` binding `rate_multiplier` |
| `deepseek_rate` | `deepseek` binding `rate_multiplier` |
| `rateLimits` | 多窗口限制规则表/JSONB |
| `pack_consent` | `tags` 包含 `pack_consent` 或 metadata bool |

**验收标准**

- 现有 Partner API 调用方无需同时改签名算法和字段名即可接入 sub2api。
- 批量更新只影响传入字段，不覆盖未传平台配置。
- 用量汇总与 CRS 同期样本按 Key 总成本、平台成本、模型成本对账一致。

### 4.3 API Key 套餐、限额和自动切换

**CRS 能力**

- API Key 新增 `rateLimits`、`accountBindings`、`translateReasoning`、`externalUid`。
- 认证链路支持多窗口请求/费用限制、每日费用、总费用、Claude 周费用、AI 修复资源包限制。
- Redis 使用 `rate_limit:window_start:{keyId}`、`rate_limit:requests:{keyId}`、`rate_limit:cost:{keyId}` 等 key 维护窗口。
- `uid_keys:{externalUid}` 支持同用户多 Key 自动切换。
- 自动切换按资源类型排序，资源包切换需要 `pack_consent`。
- 中文套餐/资源包错误文案保留 402/403/429 等状态含义。

**sub2api 现状与差距**

- API Key 只有 `quota`、`quota_used`、`rate_limit_5h/1d/7d`、`usage_5h/1d/7d` 等固定成本窗口。
- 不支持 CRS 任意窗口数组、请求数窗口、资源包 consent、externalUid 自动换 Key，也不支持单 Key 多平台绑定。

**迁移方案**

- Key 迁移：
  - 建立 `legacy_crs_key_id -> api_key_id` 映射。
  - 导入 `key_hash`、status、expires、quota/cost totals、tags、externalUid、permissions、model blacklist、client restrictions。
  - `cr_` 明文只在请求时用于 hash lookup，不落库、不写日志。
- 多平台绑定：
  - `accountBindings` 拆成多条 binding，不再塞进单个 `api_keys.group_id`。
  - CRS 兼容 Key 可以保留一个默认 group，但真实调度必须以 binding resolver 输出为准。
- 多窗口限额：
  - 建议新增可表达任意窗口的 `api_key_rate_limit_rules` 和 `api_key_rate_limit_windows`，或 JSONB + Redis cache。
  - 常见 300min/1d/7d 同步镜像到 sub2api 现有字段，便于复用 UI 和已有检查。
  - request count 和 cost count 都要支持；窗口结构变化才重置窗口。
- 自动切换：
  - 导入/维护 `externalUid -> api_key_id list` 索引。
  - 当前 Key 因过期、禁用、quota、窗口、资源包限制失败时，查同 externalUid 候选 Key。
  - 候选 Key 必须完整执行与主 Key 等价的认证、权限、平台 binding、客户端限制、模型黑名单、余额、限额检查。
  - 成功切换后上下文中的 `api_key_id` 改为备用 Key，响应可加内部 debug header 或日志字段，默认不暴露完整 Key。
- 资源包语义：
  - `pack_consent` 保存在 tags/metadata。
  - 套餐 Key -> 资源包 Key 的切换必须检查 consent；资源包之间可直接切换。
  - 错误文案保留面向套餐/资源包的中文语义，避免业务前端提示退化。

**验收标准**

- 同一 `cr_...` Key 跨平台请求仍统一计入一个 API Key 的 quota/cost。
- 任意窗口 cost/request 限制与 CRS 样本一致，尤其是窗口不应在普通配置更新时被误重置。
- externalUid 自动切换只切到有目标平台权限和 binding 的 Key，不会绕过客户端限制或模型黑名单。
- `pack_consent=false` 时不会从套餐透明切到资源包。

### 4.4 OpenAI Codex 使用量自动保护

**CRS 能力**

- 从上游响应头提取 Codex 5 小时窗口、周窗口、reset 秒数、窗口分钟数、周均摊比例等 snapshot。
- OpenAI 账号根据阈值自动停止调度：5 小时接近上限、周限额接近上限、周限额日均摊超限。
- 调度器按 5 小时/周 reset 时间或本地零点自动恢复。
- 管理接口和 UI 有自动保护开关、状态展示和测试覆盖。

**sub2api 现状与差距**

- sub2api 已有 `x-codex-*` header 解析并写入 `account.extra` 的基础能力。
- 需要确认并补齐 CRS 等价的阈值配置、自动 `schedulable=false`/`temp_unschedulable_until`、恢复策略、通知和 UI 状态。

**迁移方案**

- 保留现有 snapshot 解析字段，统一字段名：`codex_5h_used_percent`、`codex_5h_reset_at`、`codex_7d_used_percent`、`codex_7d_reset_at`、`codex_primary_over_secondary_percent`、`codex_usage_updated_at`。
- 增加 account 级保护配置：`usage_protection_enabled`、5h 阈值、7d 阈值、周均摊阈值、恢复策略、通知开关。
- 请求返回后异步判断保护策略：命中后设置账号不可调度，写 `temp_unschedulable_reason=codex_usage_protection:*` 和恢复时间。
- 调度器过滤不可调度账号，并在恢复时间到达后自动恢复；恢复操作要有审计日志。
- Webhook/通知复用 sub2api 通知系统：首次触发、恢复、连续超限每日去重。
- UI 在 OpenAI 账号行展示 5h/7d 使用率、reset 时间、保护原因、预计恢复时间和手动恢复入口。

**验收标准**

- 上游响应含 `x-codex-*` 时，账号 extra 更新字段完整。
- 达到阈值后该 OpenAI 账号不再被调度，未达阈值账号不受影响。
- reset 到期或本地零点恢复逻辑与 CRS 样本一致。
- 通知不重复刷屏，同一账号同类保护事件按策略去重。

### 4.5 用量明细、日志和请求追踪

**CRS 能力**

- 请求 ID 中间件贯穿全链路。
- 请求日志在 body 解析后注册，记录请求体时剔除 `tools`、图片/base64 等大字段。
- `userInputExtractor` 从 Anthropic/OpenAI/Gemini 请求中提取用户输入、developer/system 内容、用户 IP、进程类型、项目类型。
- `ENABLE_USAGE_DETAIL=true` 时写 `sessionId`、`rawSessionId`、`userInput`、`userIp`、`processType`、`projectType`、`assistantContent` 等。
- 多个转发服务补充 usage extra、请求元信息、断开清理、流式 chunk 日志和上游响应日志。

**sub2api 现状与差距**

- `usage_logs` 已有 `request_id`、token、cost、model、account、group、user_agent、ip、duration 等基础字段。
- 缺少 CRS 的 session/userInput/processType/projectType/assistantContent 等业务字段。
- 外部业务系统原来读取 CRS Redis 中的请求日志，需要迁移到 sub2api 的稳定数据源。

**迁移方案**

- `usage_logs` 作为切换后计费和报表的唯一事实源；不把 CRS Redis 明细完整导入 sub2api。
- 小型可索引字段建议进入 `usage_logs` 扩展列或 JSONB：`session_id`、`raw_session_id`、`process_type`、`project_type`、`user_ip`、`request_source`、`platform_alias`。
- 大文本和敏感内容进入独立 `request_details`/ops detail 表：`user_input`、`developer/system 摘要`、`assistant_content`、`sanitized_request_body`、`sanitized_response_body`。
- request detail 必须支持开关、采样、TTL、脱敏和最大长度限制；默认不长期保存完整请求体。
- 流式 chunk 日志默认关闭，只在排障开关开启时短期采样；必须截断 base64、图片、工具大参数和 token。
- 外部同步改为：
  - 用量汇总读 `usage_logs` 聚合 API/view。
  - 请求明细读 request detail API/view。
  - 历史 CRS 明细通过只读归档查询，不混入新表。
- 请求断开、AbortController、并发计数清理要在 sub2api 各 gateway 中做一致性检查，避免迁移后并发泄漏。

**API Key Redis 请求日志处理**

| 现有 CRS 数据 | 迁移处理 |
| --- | --- |
| `usage:records:{keyId}` | 不完整导入；CRS Redis 只读保留 |
| `request_detail:*` | 不完整导入；只保留归档查询能力 |
| API Key 维度累计成本 | 导入 sub2api API Key quota/usage counters 或迁移扩展表 |
| 切换后新日志 | 写 sub2api `usage_logs` + request detail |
| 业务系统同步 | 改读 sub2api API/view/Webhook |

**验收标准**

- 切换后任一请求能通过 `request_id` 从访问日志、usage log、request detail、error log 串起来。
- request detail 开启时字段与 CRS 业务系统依赖字段一致；关闭时不影响计费和转发。
- 日志不出现完整 API Key、OAuth token、refresh token、DeepSeek key、图片 base64。

### 4.6 思考链翻译

**CRS 能力**

- `reasoningTranslationService` 对 reasoning delta 增量翻译，按句子边界并发翻译并按原始顺序输出。
- SSE transformer 把翻译后的 `reasoning_content` 注入 OpenAI 风格流，并把翻译 token usage 合并进 usage chunk。
- API Key 有 `translateReasoning` 开关，前端、后端和 Redis 解析都支持。
- OpenAI/兼容路由记录 reasoning、thinking、assistant output，用于中文化展示和附加费用统计。

**sub2api 现状与差距**

- sub2api 已有较多 reasoning/thinking 协议转换，但不是 CRS 这种“增量翻译并合并 usage”的功能。
- 如果业务侧依赖中文 reasoning 展示或翻译成本统计，需要迁移；否则可作为二期可选能力。

**迁移方案**

- 默认迁移字段但关闭功能：`translate_reasoning=false`，避免切流时引入额外模型调用和延迟。
- 如果确认业务仍依赖，则实现为独立可插拔 transformer：只作用于配置开启的 Key/binding 和支持 reasoning delta 的 OpenAI-compatible 流。
- 翻译服务独立配置模型、上游、超时、并发和失败策略；翻译失败不得中断主请求流。
- usage 合并要明确区分主请求 usage 和翻译 usage：
  - 主请求照常计费。
  - 翻译调用成本可写入 `usage_logs.extra.translation_cost` 或单独 usage log，避免污染上游模型成本。
- request detail 可保存原始 reasoning 摘要和翻译后摘要，但必须受 TTL/脱敏/长度限制。

**验收标准**

- 未开启 `translate_reasoning` 的 Key 行为与 sub2api 原生一致。
- 开启后流式输出顺序稳定，翻译失败时主流不中断。
- 翻译 usage 能对账，且不会重复计入主请求 input/output tokens。

### 4.7 错误处理、通知和上游保护

**CRS 能力**

- 上游错误归一化覆盖 400、401、402、429、529、上下文超长、Prompt too long 等。
- OpenAI refresh 失败、限流、未授权、状态重置等事件发送 webhook。
- `No available accounts` 每日一次提醒，避免重复告警。
- API 错误文案面向套餐/资源包，Prompt too long 映射为 413。
- 多窗口费用按倍率后成本更新。

**sub2api 现状与差距**

- sub2api 有账号限流、过载、错误日志和部分客户端错误处理能力，但需要按 CRS 的业务文案、状态码、通知事件和多窗口费用口径做兼容校验。

**迁移方案**

- 建立 CRS 兼容错误归一化层，至少覆盖：
  - 上游 unauthorized/invalid token -> 账号状态和通知。
  - 上游 rate limited -> `rate_limited_at`/`rate_limit_reset_at` 和调度排除。
  - 529/overloaded -> `overload_until`。
  - context too long / prompt too long -> 413。
  - no available accounts -> 503/业务兼容错误码 + 每日去重通知。
  - Key quota/rate/package/resource pack -> CRS 中文文案 + 原状态码语义。
- Webhook event schema 保持稳定：事件类型、账号 legacy id、新 account id、platform、原因、恢复时间、request_id、脱敏错误摘要。
- 多窗口费用更新统一使用 `actual_cost`，并在请求失败/取消时明确是否扣费；保持 CRS 样本一致。
- 错误日志写 sub2api error log/ops log，并关联 `request_id`、api_key_id、group_id、account_id、legacy id。

**验收标准**

- CRS 常见错误样本迁移后状态码和业务提示等价。
- 账号限流/过载后调度器不会继续选中该账号。
- `No available accounts` 不会重复轰炸通知。
- rate limit window 的 cost 消耗使用倍率后成本。

### 4.8 统计和后台 UI

**CRS 能力**

- Dashboard 支持 DeepSeek 账号统计、昨日快捷筛选、API Key 标签筛选、请求数/Token 指标切换、Top 50 图表和可排序分页表。
- API Key 趋势接口支持 `startDate`、`endDate`、`metric`、`tag`，返回完整 `apiKeyStats`。
- 用户侧用量统计聚合所有 Key 的 daily/model 数据，补充 cache create/read tokens。
- 账号用量历史、账号趋势和请求明细支持 DeepSeek，并补充 session、用户输入、项目类型、assistant 内容等扩展字段。
- 前端 API Key 创建/编辑/批量编辑支持多窗口限制、服务倍率、标签、`pack_consent`、DeepSeek 绑定和 `externalUid`。

**sub2api 现状与差距**

- sub2api 已有 dashboard、usage、account 统计基础，但缺少 CRS 的标签筛选、DeepSeek alias 视图、多平台 Key binding 表单、完整 request detail 字段和 Partner 统计契约。

**迁移方案**

- 后端统计 API 先补能力，再补 UI：
  - `metric=requests|tokens|cost|actual_cost`。
  - `tag`、`platform_alias`、`legacy_crs_key_id`、`group_id`、`account_id`、日期范围筛选。
  - Top 50 Key/model/account/group 聚合。
  - 用户侧按 user 聚合所有 Key，不只看单 Key。
- UI 表单：
  - API Key 创建/编辑显示多平台 bindings，而不是单 group。
  - 支持 `serviceRates`/binding multiplier、`rateLimits` 多窗口、tags、`pack_consent`、`externalUid`、`translateReasoning`。
  - DeepSeek 在账号页和 Dashboard 独立显示，但底层可通过 alias 过滤。
- 请求明细 UI：展示 `request_id`、legacy key id、platform、group、account、model、session、userInput 摘要、projectType、processType、assistantContent 摘要、成本 breakdown。
- 排序分页：后端完成分页聚合，避免前端拉全量 usage log。

**验收标准**

- Dashboard 与 CRS 关键指标同口径：请求数、token、原始成本、倍率后成本、DeepSeek 统计。
- 标签筛选、昨日快捷筛选、metric 切换和 Top 50 可用。
- API Key 编辑不会丢失任一平台 binding 或倍率。
- 用户侧统计能聚合用户所有 Key。

## 5. 外部业务系统同步迁移方案

### 5.1 API Key 请求日志同步

现状：业务系统直接读取 CRS Redis 中的 API Key 请求日志和用量记录。

目标：切换后业务系统只读取 sub2api 稳定契约，不读取 Redis 内部结构。

**建议数据源优先级**

1. sub2api Partner/Compat API：最适合业务系统调用，认证、字段、分页、过滤可控。
2. Postgres view：适合短期低改造同步任务，但必须声明为稳定 view，不暴露 ent 内部表结构。
3. Webhook：适合账号状态变化、用量落库事件、阈值告警，减少轮询。
4. CRS Redis 只读归档：仅用于切换前历史排查，不作为新同步链路。

**推荐 view/API 字段**

| 字段 | 说明 |
| --- | --- |
| `legacy_crs_key_id` | 业务系统原主键对齐 |
| `api_key_id` | sub2api 新主键 |
| `external_uid` | 外部用户 ID |
| `platform` / `platform_alias` | Claude/OpenAI/Gemini/DeepSeek |
| `group_id` / `account_id` | 本次请求实际调度对象 |
| `request_id` | 全链路追踪 |
| `model` / `requested_model` / `upstream_model` | 模型口径 |
| token breakdown | input/output/cache create/cache read |
| cost breakdown | raw cost、actual cost、rate multiplier |
| detail fields | session/userInput/processType/projectType/assistantContent 摘要 |
| timestamps | created_at、last_used_at |

### 5.2 AI 平台账号同步

现状：AI 平台账号会直接读取 CRS Redis 中账号数据同步到其它业务系统。

目标：账号同步改读 sub2api account API/view/Webhook。

**迁移处理**

- 每个迁移账号写入 `extra.legacy_crs_account_id` 和 `extra.legacy_crs_account_type`，保证业务系统能按旧 ID 对齐。
- 凭证字段只允许 admin 内部使用，业务同步 API 默认不返回明文 token/API Key/refreshToken。
- 账号状态同步字段包括：status、schedulable、rate_limited_at、rate_limit_reset_at、overload_until、temp_unschedulable_until、error_message 脱敏摘要、last_used_at、codex usage snapshot。
- DeepSeek 账号以 `provider_alias=deepseek` 暴露给业务系统，即使底层 platform 是 OpenAI-compatible。
- 短期可提供 `crs_accounts_compat_view`，字段尽量接近 CRS Redis 导出的 JSON；长期以正式 API 为准。
- 账号状态变化使用 Webhook 推送：限流、未授权、refresh 失败、自动保护停调度、恢复、禁用/启用。

## 6. 数据迁移清单

| 数据类型 | 迁移方式 | 是否完整迁移历史 | 备注 |
| --- | --- | --- | --- |
| API Key 基础信息 | 导入到 sub2api API Key + legacy hash 表 | 是 | 不导入 `cr_` 明文，只导入 hash 和 metadata |
| API Key 多平台权限/绑定 | 导入 binding 表/JSONB | 是 | Claude/OpenAI/Gemini/DeepSeek 分平台映射 |
| API Key serviceRates | 导入 binding multiplier | 是 | 作为 CRS 最终倍率计算输入 |
| API Key tags/pack_consent | 导入 metadata/tags | 是 | 用于资源包切换和 UI 筛选 |
| externalUid 索引 | 重建索引 | 是 | 用于自动切换候选 Key |
| rateLimits | 导入多窗口规则 | 是 | 运行时窗口状态按 CRS cutover 快照导入或从切换时重开，需确认 |
| 余额/额度/累计成本 | 导入 quota/usage counters 或兼容表 | 是 | 迁移后做 CRS/sub2api 对账 |
| 请求历史明细 | CRS Redis 只读归档 | 否 | sub2api 只承接切换后新明细 |
| AI 平台账号 | 导入 sub2api accounts | 是 | credentials 加密，legacy id 写 extra |
| DeepSeek 账号 | 导入 OpenAI-compatible account + alias | 是 | 补 base URL、限流状态、价格 |
| OpenAI Codex usage snapshot | 导入 account extra | 当前状态导入 | 用于切换后保护策略连续 |

## 7. 实施阶段

### Phase 0：确认计划和契约

- 确认本文档中的 API Key 兼容模型、计费公式、DeepSeek 接入方式和外部同步方式。
- 确认 Partner API 必须兼容的字段、签名、错误码和分页格式。
- 确认 request detail 保存范围、TTL、采样和敏感字段脱敏策略。
- 确认 `translateReasoning` 是否必须首批上线；如非必须，作为二期保留字段默认关闭。

### Phase 1：迁移盘点和 dry-run

- 从 CRS Redis 导出 API Key、permissions、serviceRates、accountBindings、rateLimits、externalUid、tags、cost totals。
- 导出 Claude/OpenAI/Gemini/DeepSeek 账号和状态，生成 legacy id 映射。
- 检查 sub2api 中目标 group/account/channel/pricing 是否齐全。
- 生成 dry-run 报告：缺 group、缺价格、重复账号、无效绑定、权限冲突、无法映射字段。

### Phase 2：核心兼容能力

- legacy hash auth + 多平台 binding resolver。
- CRS 兼容计费倍率和 quota/rate limit 消耗。
- 多窗口 request/cost 限制和 externalUid 自动切换。
- Partner API 兼容层。
- DeepSeek route/account/usage/pricing 兼容。

### Phase 3：日志、同步和通知

- usage log/request detail 扩展。
- 外部业务系统 API/view/Webhook。
- 账号状态同步和 legacy id view。
- 错误归一化、通知去重和 OpenAI Codex 自动保护。

### Phase 4：后台 UI 和统计

- API Key 多平台 binding 表单。
- DeepSeek 账号和统计展示。
- Dashboard 指标、标签筛选、Top 50、昨日快捷筛选、请求明细字段。
- 用户侧所有 Key 聚合统计。

### Phase 5：灰度和切换

- staging 导入一批真实 Key/account，做请求重放和计费对账。
- 小流量切到 sub2api，监控认证失败率、调度失败率、成本差异、DeepSeek usage、外部同步延迟。
- 冻结 CRS 写入，执行最终增量导入。
- 切换入口流量到 sub2api；保留 CRS 只读和回滚入口。
- 稳定后停止业务系统对 CRS Redis 的直接读取。

## 8. 测试与验收矩阵

| 场景 | 验收点 |
| --- | --- |
| legacy auth | `cr_` Key 只通过 hash lookup，数据库和日志不出现完整 Key |
| 跨平台访问 | 同一 Key 调 Claude/OpenAI/Gemini/DeepSeek，写同一 `api_key_id` 和不同 group/platform |
| 平台倍率 | 不同平台倍率生效，且不与 sub2api group/user multiplier 双重相乘 |
| quota/rate limit | quota 和多窗口限制按 `actual_cost` 消耗，request count 和 cost 都可限 |
| externalUid 切换 | 主 Key 失败后只切到同 uid 且满足目标平台校验的候选 Key |
| pack_consent | 未授权时不切资源包，授权后按 CRS 顺序切换 |
| Partner API | 签名、字段、批量更新、usage 汇总与 CRS 兼容 |
| DeepSeek | 路由、账号、stream usage、cache hit/miss、价格、统计可用 |
| Codex 保护 | header snapshot、停调度、恢复、通知、UI 状态一致 |
| request detail | session/userInput/processType/projectType/assistantContent 可按开关记录 |
| 外部同步 | API/view/Webhook 能替代业务系统直接读 CRS Redis |
| 错误处理 | 401/402/403/413/429/503/529 等常见错误与 CRS 语义一致 |
| 安全 | secret/token/API Key 全链路脱敏，request body 默认不长期保存 |
| 回滚 | 切流失败可回 CRS，避免 sub2api/CRS 双扣费 |

## 9. 待确认问题

- `translateReasoning` 是否必须首批迁移；若不是，建议首批只迁移字段并默认关闭。
- CRS `rateLimits` 的运行时窗口状态是否要按 Redis 当前窗口精确迁移，还是 cutover 时重新开窗。
- 外部业务系统优先使用 Partner API、Postgres view 还是 Webhook；不同选择会影响工作量和稳定性边界。
- DeepSeek Anthropic-compatible 路由是否必须首批完全兼容；若业务只使用 OpenAI-compatible，可先灰度 OpenAI-compatible。
- Partner API 的错误响应 JSON 是否需要字节级兼容 CRS，还是字段级兼容即可。
- 请求体/响应体明细的保存 TTL、采样率和最大长度，需要业务、安全、合规一起确认。
