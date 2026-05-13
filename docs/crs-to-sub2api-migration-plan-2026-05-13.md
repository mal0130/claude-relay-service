# CRS 迁移到 sub2api 工作评估与实施计划

## Summary

- 迁移策略按已确认方向执行：保留现有 `cr_...` API Key 跨平台访问和统一计费；外部业务系统改读 sub2api；历史明细不完整导入，只迁移余额/额度/累计用量口径，CRS 保留只读归档。
- sub2api 不能直接沿用“一个 API Key 绑定一个 group”的现状，需要新增 CRS 兼容 Key 层：一个逻辑 API Key 可绑定多个平台 group，并按请求入口选择目标平台。
- DeepSeek 不作为新的顶层平台优先实现，默认按 OpenAI-compatible upstream/group 接入，但要补齐 DeepSeek usage 字段、价格、路由别名和账号同步。
- CRS Redis 中的请求日志、账号数据同步逻辑要改为 sub2api 的稳定 API/视图/Webhook；不建议让外部系统继续读取 Redis 内部 key 结构。

## Key Changes

### API Key 兼容层

- 新增 `legacy_api_key_hashes` 类表或等价结构：保存 CRS Key 的 SHA-256 hash、legacy key id、来源、状态、关联的 sub2api `api_key_id`；不得保存已有 `cr_...` 明文。
- 新增 `api_key_platform_bindings` 类表或等价结构：`api_key_id + service/platform + group_id + enabled + rate_multiplier + migrated_permissions`，用于一个 CRS Key 绑定 Claude/OpenAI/Gemini/DeepSeek 等多个 group。
- 修改认证中间件：Bearer 为 `cr_` 时先 hash 查 legacy 表；普通 sub2api key 仍走现有明文 key 流程，避免破坏原功能。
- 修改平台解析：根据入口路径/协议选择 binding，例如 Anthropic Messages、OpenAI Chat/Responses、Gemini、DeepSeek alias，再把选中的 group 注入后续调度与计费上下文。
- 迁移 CRS 的 platform permissions、模型黑名单、客户端限制、限额字段；缺失字段按 CRS 原默认值补齐，避免兼容 Key 误判。

### 计费适配

- 对 CRS 兼容 Key，`usage_logs.api_key_id` 始终写同一个逻辑 Key，`usage_logs.group_id` 写本次请求选中的平台 group，从而保留“按 Key 汇总、按平台拆分”的双口径。
- 费用公式保持 CRS 语义：模型原始成本 `total_cost` x CRS service/global rate x API Key 平台覆盖倍率 = `actual_cost`/扣费成本。
- 避免与 sub2api group/user rate 双重相乘：CRS 兼容 Key 的最终倍率由 binding 计算并写入 `usage_logs.rate_multiplier`；标准 sub2api Key 继续使用现有 group/user multiplier。
- 迁移 CRS `usage:cost:total:*`、当日/周期限额、quota used、rate-limit cost window 到 sub2api API Key 的 `quota_used`、rate limit usage 或兼容扩展字段。
- 加一套对账脚本：用 CRS Redis 汇总与 sub2api 导入后的 API Key 余额/额度/累计成本做差异检查。

### DeepSeek 适配

- 将 CRS DeepSeek 账号迁移为 sub2api OpenAI-compatible upstream/account，默认 base URL 指向 DeepSeek API，账号 metadata 保留 `legacy_crs_account_id` 和原 CRS 类型。
- 增加 DeepSeek 路由兼容：保留 CRS 旧路径别名，如 `/deepseek/v1/chat/completions`、必要时保留 Anthropic-compatible DeepSeek 入口，并映射到 sub2api OpenAI-compatible gateway。
- 补齐 usage 解析：识别 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`，将 hit 映射为 cache read，将 miss/非缓存 prompt 映射为 billable input，避免 cache 命中费用不准。
- 校验模型价格：确认 `deepseek-chat`、`deepseek-reasoner` 和缓存命中价格存在；缺失时在 channel pricing 或 fallback pricing 中补齐。
- 扩展 CRS account export/import：把 DeepSeek 账号纳入当前 sub2api CRS sync 流程，并支持 dry-run/preview。

### 外部业务系统同步

- 新增或补齐 partner/compat API：API Key 列表、Key 平台绑定、Key usage summary、usage log 查询、账号列表、账号状态变更。
- 响应字段保留业务系统依赖的 CRS 标识：`legacy_crs_key_id`、`legacy_crs_account_id`、平台类型、Key 名称、owner、status、rate/serviceRates、累计成本、最后使用时间。
- 默认不返回账号/API Key 明文 secret；如确需 secrets export，必须是 admin-only、显式参数、审计日志、token 脱敏。
- 如业务系统短期需要数据库直连，提供稳定 Postgres view，不暴露内部 ent 表结构作为长期契约。
- 可选 Webhook：Key 用量落库、账号状态变化、账号额度/过载事件触发推送，减少业务侧轮询。

### 日志处理

- 业务用量日志统一进入 `usage_logs`，作为计费、报表、外部同步唯一事实源。
- CRS 的 `usage:records:{keyId}` 和 `request_detail:*` 不完整迁移；切换前保留 CRS Redis 只读归档，用于历史排查。
- sub2api 成功请求 drilldown 使用 `usage_logs` + ops request view；失败请求继续走 `ops_error_logs`。
- 大量 AI 接口 debug 日志改为结构化日志字段：request_id、api_key_id、group_id、account_id、platform、model、duration、status、cost、token breakdown、cache fields。
- 请求体快照默认不落库；如必须保留，做短 TTL、脱敏、采样和开关控制，避免敏感内容长期存储。

## Migration Rollout

### Phase 1: Inventory

- 从 CRS Redis 导出 API Key、serviceRates、permissions、cost totals、account bindings、AI platform accounts、DeepSeek accounts。
- 生成迁移映射表：legacy key id -> sub2api api_key_id；legacy account id -> sub2api account_id；CRS service -> sub2api group。
- 产出 dry-run 报告：无法映射的平台、缺失价格模型、重复账号、无 group 目标、权限冲突。

### Phase 2: sub2api Compatibility Build

- 实现 legacy hash auth、multi-platform bindings、平台解析、CRS 计费倍率计算。
- 扩展 DeepSeek usage/pricing/account sync。
- 新增 partner/compat API 或 Postgres views 给外部业务系统使用。

### Phase 3: Data Migration

- 导入 API Key 逻辑记录和 legacy hash，不导入明文 `cr_` token。
- 导入每个平台 binding 与倍率，导入余额/额度/累计 usage cost。
- 导入账号并写入 legacy id metadata；DeepSeek 作为 OpenAI-compatible upstream 账号创建。
- 不导入完整历史 usage 明细；CRS Redis 进入只读归档模式。

### Phase 4: Validation And Gray Release

- 用样本 `cr_` Key 分别请求 Claude/OpenAI/Gemini/DeepSeek，确认同一 `api_key_id`、不同 `group_id`、正确倍率扣费。
- 用历史 CRS usage 样本重放计费，核对 `real cost`、`rated/actual cost`、模型维度、平台维度。
- 外部业务系统先接 sub2api staging API，对比 CRS 现有同步结果。
- 小流量切到 sub2api；保留 CRS 作为回滚入口，禁止双扣费。

### Phase 5: Cutover

- 冻结 CRS API Key/账号写入，执行最终增量导入。
- 切换入口流量到 sub2api，监控认证失败率、调度失败率、成本差异、DeepSeek usage 解析、外部同步延迟。
- 稳定后下线业务系统对 CRS Redis 的读取，仅保留 CRS 只读查询窗口。

## Test Plan

- API Key auth：`cr_` 明文只用于请求时 hash lookup；数据库和日志不出现完整 token；普通 sub2api Key 不受影响。
- Cross-platform：同一个 legacy Key 调用 Claude/OpenAI/Gemini/DeepSeek，均通过权限校验并写同一个 `usage_logs.api_key_id`。
- Billing：按 CRS serviceRates/key serviceRates 计算，验证不叠加 sub2api group multiplier；quota/rate limit 按 `actual_cost` 消耗。
- DeepSeek：流式/非流式 Chat Completions 均解析 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`，cache hit 成本与 CRS 样本一致。
- Migration dry-run：重复执行不产生重复 Key/account；缺失 group、缺失价格、无效账号状态可明确报错。
- External sync：partner API/view 返回字段与现有业务系统依赖字段对齐；分页、时间范围、Key/account 过滤可用。
- Security/logging：OAuth token、refresh token、API Key、DeepSeek key 均脱敏；请求体快照默认关闭。
- Rollback：切流失败时 CRS 可恢复承接请求，sub2api 已写 usage 不会被 CRS 重复扣费。

## Assumptions

- 保留现有 `cr_...` 外部 Key，不要求用户重新分发每个平台 Key。
- 业务系统迁移为读取 sub2api API/Postgres view/Webhook，不继续依赖 CRS Redis 内部结构。
- 历史明细只保留在 CRS 只读归档；sub2api 只承接切换后的新 usage log，并导入余额、额度、累计成本口径。
- DeepSeek 默认作为 OpenAI-compatible upstream/group 接入；除非后续明确要求独立平台，否则不新增 `PlatformDeepSeek` 顶层平台。
- 迁移优先保证计费一致性、Key 兼容性和外部同步稳定性，管理后台 UI 可在核心链路验证后再补齐。
