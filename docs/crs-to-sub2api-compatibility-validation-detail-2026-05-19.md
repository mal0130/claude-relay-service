# CRS 迁移到 sub2api 兼容矩阵与测试方案细化

> 状态：讨论稿。
> 目的：细化 `crs-to-sub2api-migration-quality-assurance-plan-2026-05-19.md` 第 2、3、4 章，形成可独立执行的功能兼容矩阵、Golden Samples 样本库设计和兼容性测试套件方案。
> 重要前提：生产环境不做请求级灰度、不做 shadow、不做默认 Key 级灰度；迁移质量主要依赖测试环境固定响应验证、生产数据 dry-run、全量切换演练和短窗口 cutover。

## 1. 总体原则

### 1.1 验证目标

本方案只验证“迁移后外部行为和业务口径是否与 CRS 一致”，不要求 sub2api 内部实现方式与 CRS 完全相同。

必须一致的内容：

- API Key 认证结果。
- 同一个 `cr_...` Key 跨平台访问能力。
- 权限、模型黑名单、客户端限制。
- 平台倍率、服务倍率和最终计费结果。
- 5h/7d 限额和余额/额度消耗。
- Partner API 签名、字段和关键响应语义。
- DeepSeek usage 解析和 cache hit/miss 计费。
- 外部业务系统同步字段。
- 关键错误码、错误文案和通知事件。

允许内部实现不同的内容：

- 数据库表结构。
- account/group/binding 的内部建模。
- 日志存储方式。
- 后台任务实现方式。
- 价格同步任务执行方式。

明确不作为一致性目标的内容：

- CRS Redis 内部 key 结构在 sub2api 中原样复刻。
- 完整历史请求明细导入 sub2api。
- 生产 shadow 对比大模型响应内容。
- 同一 API Key 在 CRS/sub2api 之间按比例分流。

### 1.2 验证手段优先级

| 优先级 | 手段 | 用途 | 是否用于计费一致性结论 |
| --- | --- | --- | --- |
| P0 | 测试环境 mock upstream 固定响应 | 精确验证 usage、计费、限额、日志 | 是 |
| P0 | 生产数据 dry-run 和对账 | 验证迁移数据完整性 | 是 |
| P0 | 生产全量切换演练 | 验证切换流程和回滚准备 | 是 |
| P1 | real upstream 小样本测试 | 验证真实链路可用 | 否 |
| P2 | 人工后台 UI 检查 | 验证管理体验 | 否 |
| 禁用 | 生产 shadow | 会导致成本翻倍且响应不可精确比较 | 否 |
| 禁用 | 请求级灰度 | 计费事实源分裂 | 否 |

## 2. 功能兼容矩阵细化

### 2.1 分级规则

| 等级 | 含义 | 切换要求 |
| --- | --- | --- |
| P0 阻断项 | 影响认证、计费、限额、Partner API、数据迁移、外部同步 | 不通过不得切换 |
| P1 高优先级 | 影响核心业务体验或排障能力，但可短期人工兜底 | 切换前必须有修复计划和风险确认 |
| P2 可延后 | 后台展示、非核心统计、可选增强能力 | 可进入二期 |
| P3 不迁移 | 历史兼容或内部实现细节 | 明确归档或废弃 |

### 2.2 P0 功能兼容矩阵

| 编号 | 功能点 | CRS 当前行为 | sub2api 目标行为 | 验证方式 | 阻断条件 |
| --- | --- | --- | --- | --- | --- |
| P0-AUTH-001 | 原始 `cr_...` Key 认证 | CRS Redis 只存 hash，外部业务系统保存原始 Key | 从外部业务系统导入原始 Key 到 sub2api，保持用户侧 Key 不变 | dry-run 对账 + API 请求样本 | 任一有效 Key 无法认证 |
| P0-MIG-001 | CRS 旧 ID 映射和反查 | CRS Redis、历史日志和外部系统可能引用原 `keyId`/`accountId` | sub2api 保存 CRS 旧 ID 与新 ID 的映射；该映射不参与认证 | 数据迁移报告 + 外部同步字段测试 | CRS 旧 ID 无法反查或映射重复 |
| P0-AUTH-003 | 同 Key 跨平台 | 同一个 Key 可访问 Claude/OpenAI/Gemini/DeepSeek | 同一个 `api_key_id` 挂多平台 binding | mock upstream 请求 replay | 平台 binding 缺失或写入不同 Key |
| P0-AUTH-004 | 平台权限 | Key permissions 控制平台访问 | resolver 根据路由选择平台后执行权限校验 | 正反样本请求 | 无权限请求被放行或有权限请求被拒绝 |
| P0-AUTH-005 | 模型黑名单 | CRS 可按 Key 限制模型 | sub2api 兼容模型黑名单语义 | 黑名单模型请求样本 | 黑名单绕过 |
| P0-BILL-001 | 原始模型成本 | CRS 根据 usage 和价格算 raw cost | sub2api raw cost 与 CRS 一致 | 固定 usage 样本 | raw cost 不一致且无法解释 |
| P0-BILL-002 | 平台倍率 | CRS 支持不同平台不同倍率 | sub2api binding multiplier 还原 `serviceRates` 语义 | Claude/OpenAI/DeepSeek 多平台样本 | actual cost 不一致 |
| P0-BILL-003 | 避免重复倍率 | CRS 以 API Key 为计费主体 | CRS 兼容 Key 不叠加 sub2api group/user multiplier | 专门构造 group multiplier 非 1 样本 | 出现重复相乘 |
| P0-BILL-004 | quota/余额扣减 | CRS 按倍率后成本扣减 | sub2api 按 `actual_cost` 消耗 | fixed usage 计费样本 | 扣减金额不一致 |
| P0-BILL-005 | 5h 限额 | 当前实际使用 5h 限制 | 映射到 `rate_limit_5h`/`usage_5h` | 窗口边界样本 | 超限判断不一致 |
| P0-BILL-006 | 7d 限额 | 当前实际使用 7d 限制 | 映射到 `rate_limit_7d`/`usage_7d` | 窗口边界样本 | 超限判断不一致 |
| P0-BILL-007 | 累计成本迁移 | CRS Redis 保存累计成本 | sub2api 初始累计成本与 CRS 对账一致 | dry-run 对账 | 差异超出容忍范围 |
| P0-DEEP-001 | DeepSeek 路由 | `/deepseek/v1/chat/completions` | sub2api 保留兼容入口 | mock DeepSeek 请求 | 路由不可用 |
| P0-DEEP-002 | DeepSeek Anthropic 兼容 | `/deepseek/anthropic/v1/messages` | 保留兼容入口或明确首批不支持 | mock 请求 | 已确认首批范围内但不可用 |
| P0-DEEP-003 | cache hit/miss | DeepSeek usage 含 `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` | hit -> cache read，miss -> billable input | 固定 usage 样本 | 重复计费或漏计费 |
| P0-DEEP-004 | DeepSeek 价格 | CRS 有 fallback/官方价格 | sub2api 有等价价格 | 价格表 dry-run | 模型价格缺失 |
| P0-PARTNER-001 | 签名认证 | 参数排序 + SHA-256 + secret | `/partner` 兼容 CRS 签名 | 正确/错误签名样本 | 签名兼容失败 |
| P0-PARTNER-002 | 创建 Key | 支持账户绑定、倍率、限额、tags | 创建 sub2api Key + bindings + metadata | Partner API 样本 | 字段缺失或语义错误 |
| P0-PARTNER-003 | 更新 Key | 未传字段不覆盖 | partial update，不误清空 binding/rate | 更新样本 | 未传字段被清空 |
| P0-PARTNER-004 | 批量更新 | 多 Key 批量配置 | 返回逐条结果 | 批量样本 | 单条失败影响整体且无明细 |
| P0-PARTNER-005 | usage 查询 | 按 Key 汇总成本和明细 | 从 `usage_logs` 聚合返回兼容字段 | usage 样本 | 汇总口径不一致 |
| P0-SYNC-001 | 外部 usage 同步 | 业务系统读 CRS Redis | 业务系统改读 sub2api API/view/Webhook | 字段契约测试 | 关键字段缺失 |
| P0-SYNC-002 | 账号同步 | 业务系统读 CRS 账号 Redis | sub2api 暴露账号 API/view，保留 CRS 旧 accountId 映射 | 账号样本 | 账号状态无法同步 |
| P0-CUT-001 | 全量切换 | CRS 是唯一事实源 | 切换后 sub2api 是唯一事实源 | 切换演练 | 两边同时写真实计费 |
| P0-CUT-002 | in-flight drain | CRS 请求可能仍在写 Redis | 维护窗口等待或中断长连接 | 切换演练 | 最终导出状态不完整 |
| P0-TASK-001 | 后台任务单实例语义 | CRS/sub2api 单实例任务直接执行 | 分布式部署下任务加锁或独立 worker | 多实例任务测试 | 重复执行导致重复通知/状态覆盖 |
| P0-PRICE-001 | 价格同步源 | 不再直接跟随 weishaw 上游 | 固定为 `mal0130/sub2api` fork 指定分支 | 配置和 dry-run | 同步源错误或覆盖业务价格 |

### 2.3 P1 功能兼容矩阵

| 编号 | 功能点 | CRS 当前行为 | sub2api 目标行为 | 验证方式 | 风险处理 |
| --- | --- | --- | --- | --- | --- |
| P1-ERR-001 | Prompt too long | 映射为 413 | sub2api 保持 413 和兼容文案 | 错误样本 | 切换前修复或加兼容层 |
| P1-ERR-002 | 401/429/529 上游错误 | 标记账号状态并通知 | sub2api 账号状态和通知等价 | mock error upstream | 未完全一致时人工监控兜底 |
| P1-CODEX-001 | OpenAI Codex snapshot | 保存 5h/7d 使用率 | sub2api 保存并展示 snapshot | fixed header 样本 | 首批至少不能破坏调度 |
| P1-CODEX-002 | Codex 自动保护 | 命中阈值自动停调度/恢复 | sub2api 等价保护策略 | header + scheduler 样本 | 不通过不得开放 Codex 生产账号 |
| P1-LOG-001 | request id | 全链路 request id | sub2api 日志/usage/error 关联 | 请求样本 | 缺失时影响排障 |
| P1-LOG-002 | request detail | session/userInput/projectType 等 | sub2api detail/API/view 可返回 | 明细样本 | 缺失需业务确认 |
| P1-NOTIFY-001 | Webhook 通知 | 账号异常/无账号每日提醒 | sub2api 事件去重 | 通知样本 | 通知重复需限流 |
| P1-EXT-001 | `externalUid` 自动切换 | 主 Key 失败后切备用 Key | sub2api 候选 Key 完整校验后切换 | 多 Key 样本 | 不通过则首批关闭自动切换 |
| P1-PACK-001 | `pack_consent` | 套餐切资源包需授权 | sub2api 保持 consent 语义 | 资源包样本 | 不通过则禁止资源包自动切换 |

### 2.4 P2/P3 功能兼容矩阵

| 编号 | 功能点 | 处理方式 | 说明 |
| --- | --- | --- | --- |
| P2-UI-001 | Dashboard Top50/筛选 | 二期补齐 | 不影响切换计费事实源 |
| P2-UI-002 | 请求明细 UI 展示 | 二期优化 | API/view 先满足业务同步 |
| P2-TRANS-001 | 思考链翻译 | 默认关闭，字段保留 | 若业务依赖再单独验证 |
| P2-DEBUG-001 | 流式 chunk debug 日志 | 默认关闭 | 只在排障时短期开启 |
| P3-HIST-001 | 完整历史请求明细导入 | 不迁移 | CRS Redis 只读归档 |
| P3-REDIS-001 | CRS Redis key 结构 | 不复刻 | sub2api 提供稳定 API/view |

### 2.5 切换准入规则

- P0 全部通过才能进入生产切换窗口。
- P1 未通过项必须有明确风险确认、人工兜底或临时关闭策略。
- P2/P3 不阻断切换，但必须在迁移报告中列出。
- 任一 P0 项发现不可解释差异，必须停止切换。

### 2.6 CRS 旧 ID 映射说明

这里的“CRS 旧 ID 映射”不是认证必需项。原始 `cr_...` Key 已从外部业务系统导入后，请求认证可以直接使用 sub2api 的明文 Key 机制；旧 ID 映射用于迁移对账、外部系统字段兼容、历史 CRS 归档关联、账号同步和回滚补账。

建议至少保留以下映射：

| CRS 对象 | CRS 旧字段/来源 | sub2api 新对象 | 建议保存位置 | 主要用途 |
| --- | --- | --- | --- | --- |
| API Key | CRS `keyId`、Redis usage key 中的 `{keyId}`、Partner API 返回的 `keyId` | `api_keys.id` | `api_keys.extra.legacy_crs_key_id` 或独立 `crs_id_mappings` | dry-run 对账、Partner API 兼容、历史 usage 关联、回滚补账 |
| API Key hash | CRS Redis 中保存的 Key hash | `api_keys.id` | `api_keys.extra.legacy_crs_key_hash` 或独立索引 | 与 CRS Redis 对账、处理缺少原始 Key 的异常记录 |
| Claude/OpenAI/Gemini/DeepSeek 账号 | CRS account id | `accounts.id` | `accounts.extra.legacy_crs_account_id` | 账号同步、账号状态对账、请求明细关联 |
| CRS 账号类型 | CRS account type/platform | `accounts.platform`/`accounts.type`/`accounts.extra` | `accounts.extra.legacy_crs_account_type` | 外部系统展示和排障 |
| CRS 账号组/绑定 | CRS group id 或 `group:*` binding | sub2api `groups.id` / binding id | `groups.extra.legacy_crs_group_id` 或 binding metadata | Partner API `group:*` 参数兼容、绑定对账 |
| 请求日志关联 | `usage:records:{keyId}`、`request_detail:*` 中的 key/account id | `usage_logs.api_key_id`、`usage_logs.account_id` | usage view/API 返回 `legacy_crs_key_id`、`legacy_crs_account_id` | 历史归档和切换后新日志串联 |

实现要求：

- 映射必须唯一：同一个 CRS `keyId` 只能映射到一个 sub2api `api_key_id`；同一个 CRS `accountId` 只能映射到一个 sub2api `account_id`。
- 映射必须可反查：支持通过 CRS 旧 ID 找 sub2api 新 ID，也支持通过 sub2api 新 ID 返回 CRS 旧 ID。
- 映射不包含 secret：不得把 OAuth token、refresh token、上游 API Key 或完整用户请求内容放入映射表。
- 外部 API/view 应同时返回新旧 ID：例如 `api_key_id` + `legacy_crs_key_id`，`account_id` + `legacy_crs_account_id`。
- 迁移报告必须输出映射差异：缺失、重复、类型不匹配、绑定无法映射都应列为 dry-run 结果。

建议 dry-run 输出：

| 报告文件 | 内容 |
| --- | --- |
| `key_id_mapping.csv` | `legacy_crs_key_id`, `api_key_id`, `external_uid`, `status`, `mapping_status` |
| `account_id_mapping.csv` | `legacy_crs_account_id`, `account_id`, `platform`, `status`, `mapping_status` |
| `group_id_mapping.csv` | `legacy_crs_group_id`, `group_id`, `platform`, `mapping_status` |
| `mapping_errors.csv` | 缺失原始 Key、重复旧 ID、找不到目标 group/account、类型冲突 |

验收标准：

- 所有需要迁移的 CRS API Key 都能通过旧 `keyId` 反查到 sub2api `api_key_id`。
- 所有迁移账号都能通过旧 `accountId` 反查到 sub2api `account_id`。
- Partner API、usage view、账号同步 API 返回旧 ID 字段，外部业务系统无需一次性切换到 sub2api 新 ID。
- CRS 只读历史归档中的 `keyId`/`accountId` 可以和切换后 sub2api 新 usage 关联。
- 如需回滚或补账，可以从 sub2api usage 反推出 CRS `keyId`/`accountId`。

## 3. Golden Test 样本库细化

### 3.1 样本库结构

建议把样本库独立维护，样本只保存脱敏后的配置和固定响应，不保存真实 secret。

建议结构：

```text
golden-samples/
  manifest.json
  keys/
    api-keys.json
    external-keys.json
    external-uid-groups.json
  accounts/
    accounts.json
    account-bindings.json
    codex-usage-snapshots.json
  pricing/
    model-prices.json
    service-rates.json
  requests/
    claude-messages.jsonl
    openai-chat.jsonl
    openai-responses.jsonl
    gemini.jsonl
    deepseek-chat.jsonl
    deepseek-anthropic.jsonl
  partner/
    create-key.jsonl
    update-key.jsonl
    batch-update.jsonl
    usage-query.jsonl
  upstream-responses/
    claude/
    openai/
    gemini/
    deepseek/
  expected/
    crs-results.jsonl
    sub2api-results.jsonl
  reports/
    latest-diff.json
```

该结构是建议，不要求直接提交真实样本到代码仓库。真实样本如含业务敏感信息，应放在受控存储。

### 3.2 manifest 字段

`manifest.json` 建议包含：

| 字段 | 说明 |
| --- | --- |
| `sample_version` | 样本版本 |
| `generated_at` | 生成时间 |
| `source_env` | CRS/staging/production snapshot |
| `anonymization_version` | 脱敏规则版本 |
| `pricing_version` | 价格表版本 |
| `timezone` | 窗口和日期统计使用的时区 |
| `fixed_now` | 测试固定时间 |
| `coverage` | 样本覆盖矩阵 |
| `known_exceptions` | 已确认可接受差异 |

### 3.3 脱敏规则

| 数据 | 处理方式 | 要求 |
| --- | --- | --- |
| 原始 `cr_...` Key | 可生成测试 Key 或加密存储 | 不在普通日志输出完整 Key |
| OAuth token/refresh token | 删除或替换为 mock token | 不用于真实请求 |
| DeepSeek/OpenAI API Key | 删除或替换 | real upstream 测试另配测试账号 |
| 用户输入 | 摘要化或替换 | 保留长度、结构和工具调用特征 |
| IP/User-Agent | 保留分类特征 | 不保存真实 IP |
| externalUid | 稳定 hash | 保持同一用户多 Key 关系 |
| account id/key id | 稳定映射 | 保证 CRS 旧 ID 与 sub2api 新 ID 可追踪 |

### 3.4 API Key 样本细化

| 样本 ID | 场景 | 必备字段 | 期望验证 |
| --- | --- | --- | --- |
| KEY-001 | 普通 Claude Key | original key、CRS 旧 keyId、claude binding、quota | Claude 认证和计费 |
| KEY-002 | 多平台 Key | Claude/OpenAI/Gemini/DeepSeek bindings | 同 Key 跨平台 |
| KEY-003 | 不同平台倍率 | `serviceRates` 不同 | 各平台 actual cost |
| KEY-004 | 5h 接近上限 | `rate_limit_5h`、`usage_5h` | 下一个请求是否超限 |
| KEY-005 | 7d 接近上限 | `rate_limit_7d`、`usage_7d` | 周窗口判断 |
| KEY-006 | externalUid 多 Key | externalUid + 多个候选 Key | 自动切换候选逻辑 |
| KEY-007 | 资源包 Key | tags + `pack_consent` | 资源包切换授权 |
| KEY-008 | 禁用 Key | status disabled | 认证拒绝 |
| KEY-009 | 过期 Key | expires_at 过去时间 | 403/文案 |
| KEY-010 | 模型黑名单 Key | blacklist 包含目标模型 | 模型拒绝 |

### 3.5 请求样本细化

| 样本 ID | 请求类型 | upstream 响应 | 重点验证 |
| --- | --- | --- | --- |
| REQ-CLAUDE-001 | Claude Messages 非流式 | 固定 usage | token/cost/log |
| REQ-CLAUDE-002 | Claude Messages 流式 | SSE + final usage | 流式 usage 捕获 |
| REQ-OPENAI-001 | OpenAI Chat 非流式 | fixed `usage` | OpenAI 计费 |
| REQ-OPENAI-002 | OpenAI Responses | fixed response usage | Responses 适配 |
| REQ-CODEX-001 | Codex 请求 | `x-codex-*` header | snapshot 落库 |
| REQ-GEMINI-001 | Gemini 请求 | fixed usage metadata | Gemini token 解析 |
| REQ-DEEP-001 | DeepSeek chat | hit/miss usage | cache 计费 |
| REQ-DEEP-002 | DeepSeek stream | usage chunk before DONE | 流式 usage 捕获 |
| REQ-DEEP-003 | DeepSeek Anthropic | fixed translated request | 兼容路由 |
| REQ-ERR-001 | Prompt too long | 400 upstream body | 映射 413 |
| REQ-ERR-002 | Upstream 429 | 429 + reset info | 账号限流状态 |
| REQ-ERR-003 | Upstream 529 | 529 overloaded | overload_until |
| REQ-ERR-004 | Unauthorized | 401 body | 账号状态和通知 |

### 3.6 Partner API 样本细化

| 样本 ID | 接口 | 场景 | 期望验证 |
| --- | --- | --- | --- |
| PTN-001 | create | 创建多平台 Key | Key + bindings + rates |
| PTN-002 | create | `deepseek_account_id=group:*` | DeepSeek group binding |
| PTN-003 | update | 只更新 openai_rate | 未传字段不覆盖 |
| PTN-004 | update | 更新 expiration | 过期/激活语义 |
| PTN-005 | batch-update | 多 Key 部分成功 | 逐条结果 |
| PTN-006 | usage | 多 Key 汇总 | total/actual cost |
| PTN-007 | usage-details | 近 30 天 daily/model | 聚合口径 |
| PTN-008 | auth | sign 错误 | 认证拒绝 |
| PTN-009 | validation | 缺必填字段 | 错误码/文案 |

### 3.7 账号和后台任务样本细化

| 样本 ID | 类型 | 场景 | 期望验证 |
| --- | --- | --- | --- |
| ACC-001 | Claude account | active | 可调度 |
| ACC-002 | OpenAI account | token near expiry | refresh 行为 |
| ACC-003 | OpenAI account | Codex 5h near limit | 自动保护 |
| ACC-004 | DeepSeek account | rate_limited | 限流状态迁移 |
| ACC-005 | Gemini account | disabled | 不参与调度 |
| TASK-001 | 价格同步 | 两实例同时触发 | 只有一个执行 |
| TASK-002 | Webhook retry | 重复触发同事件 | 幂等去重 |
| TASK-003 | 保护恢复 | 多实例恢复同账号 | 状态不互相覆盖 |

### 3.8 样本覆盖要求

- P0 功能点必须至少有 1 个正向样本和 1 个反向/错误样本。
- 每个平台至少覆盖流式和非流式中的一种；DeepSeek 必须同时覆盖 cache hit/miss。
- Partner API 每个迁移接口至少 1 个成功样本和 1 个失败样本。
- 5h/7d 限额必须覆盖：未超限、刚好达到、超过上限、窗口重置。
- 价格表必须覆盖所有线上会使用的模型；缺失模型应在 dry-run 中阻断。

## 4. 兼容性测试套件细化

### 4.1 测试分层

| 层级 | 名称 | 目标 | 是否阻断切换 |
| --- | --- | --- | --- |
| L0 | 数据迁移校验 | 验证导入完整性和字段映射 | 是 |
| L1 | API replay | 用固定请求验证响应和状态变化 | 是 |
| L2 | 计费对账 | 精确比较 raw/actual cost | 是 |
| L3 | Partner API 兼容 | 验证签名、字段、聚合 | 是 |
| L4 | 外部同步契约 | 验证 API/view/Webhook 字段 | 是 |
| L5 | 分布式后台任务 | 验证锁、幂等和重复执行 | 是 |
| L6 | real upstream smoke | 验证真实链路可用 | 是，但不验证精确计费 |
| L7 | UI 人工验收 | 验证后台可操作性 | 否，除非影响核心运维 |

### 4.2 测试环境要求

- CRS staging 和 sub2api staging 使用同一批 Golden Samples。
- 两边使用同一份固定价格表。
- 两边指向 mock upstream，不请求真实大模型做精确计费验证。
- 测试时间固定，例如通过测试配置固定 `now`，保证 5h/7d 窗口可重复。
- Redis/Postgres 初始状态可重置。
- 每次测试输出机器可读 diff report。

### 4.3 mock upstream 协议要求

mock upstream 必须支持：

- 按请求 path/model 返回指定响应。
- 返回固定 usage。
- 返回固定 headers，例如 `x-codex-*`。
- 返回 SSE 流式 chunk。
- 模拟延迟和客户端断开。
- 模拟 400/401/402/429/529。
- 记录收到的请求，用于验证 sub2api 是否转发了正确 body/header。

DeepSeek mock usage 示例：

```json
{
  "usage": {
    "prompt_tokens": 1000,
    "completion_tokens": 500,
    "total_tokens": 1500,
    "prompt_cache_hit_tokens": 600,
    "prompt_cache_miss_tokens": 400
  }
}
```

期望解析：

```text
input_tokens = 400
cache_read_tokens = 600
output_tokens = 500
```

### 4.4 L0 数据迁移校验

输入：CRS Redis 导出、外部业务系统原始 Key 导出、sub2api 导入结果。

检查项：

- API Key 数量一致。
- 原始 `cr_...` Key 导入覆盖率达标。
- CRS 旧 ID 映射完整。
- 多平台 bindings 完整。
- `serviceRates` 映射完整。
- 5h/7d 限额和已用量映射正确。
- `externalUid` 候选 Key 关系完整。
- `pack_consent` 和 tags 完整。
- DeepSeek/OpenAI/Claude/Gemini 账号映射完整。
- Codex usage snapshot 可导入。
- 价格模型无缺失。

输出：

- `migration_diff.json`。
- `missing_keys.csv`。
- `missing_prices.csv`。
- `binding_diff.csv`。
- `cost_totals_diff.csv`。

### 4.5 L1 API replay

流程：

```text
reset CRS staging state
reset sub2api staging state
load same Golden Samples
send request to CRS staging
send same request to sub2api staging
collect response + state changes
normalize dynamic fields
compare diff
```

需要忽略的动态字段：

- request id，除非验证格式。
- created_at/updated_at 精确时间，除非验证窗口。
- 上游响应 id。
- 非契约性的 debug 字段。

必须比较的字段：

- HTTP status。
- error code/type/message。
- 平台识别结果。
- selected group/account 的 CRS 旧 ID。
- usage tokens。
- raw cost/actual cost。
- Key quota/rate usage。
- request detail 关键字段。

### 4.6 L2 计费对账

计费对账应单独输出结构化结果。

| 字段 | 要求 |
| --- | --- |
| `model` | 一致或有明确 mapping |
| `input_tokens` | 精确一致 |
| `output_tokens` | 精确一致 |
| `cache_creation_tokens` | 精确一致 |
| `cache_read_tokens` | 精确一致 |
| `raw_cost` | 精确到约定小数位 |
| `service_rate` | 与 CRS 配置一致 |
| `key_platform_rate` | 与 CRS `serviceRates` 一致 |
| `rate_multiplier` | 最终倍率一致 |
| `actual_cost` | 精确到约定小数位 |
| `quota_used_delta` | 与 actual cost 一致 |
| `usage_5h_delta` | 与 actual cost 一致 |
| `usage_7d_delta` | 与 actual cost 一致 |

建议容忍范围：

- token：必须完全一致。
- 成本：允许十进制定点精度差异，例如 `0.00000001`。
- 汇总成本：差异超过 1e-8 或约定精度即失败。

### 4.7 L3 Partner API 兼容测试

测试项：

- 签名算法兼容。
- 参数排序兼容。
- `claude_account_id`、`openai_account_id`、`deepseek_account_id` 映射。
- `claude_rate`、`openai_rate`、`deepseek_rate` 映射。
- `rateLimits` 只迁移当前实际使用的 5h/7d 限制。
- `pack_consent` 写入 tags/metadata。
- `externalUid` 写入候选 Key 索引。
- usage 查询字段兼容。
- usage details 的 daily/model 聚合口径兼容。
- partial update 不覆盖未传字段。

失败条件：

- 现有业务系统调用方需要改签名算法。
- 现有字段名无法识别。
- 批量更新无逐条错误明细。
- usage 聚合成本与 usage log 不一致。

### 4.8 L4 外部同步契约测试

外部同步契约至少覆盖：

- API Key 列表。
- API Key 状态。
- API Key 绑定平台和账号。
- API Key 余额/额度/累计成本。
- usage summary。
- usage detail。
- 账号列表。
- 账号状态变化。
- Codex usage snapshot。
- DeepSeek provider alias。

每个字段标记：

| 字段状态 | 处理方式 |
| --- | --- |
| 必须返回 | 缺失即失败 |
| 可选返回 | 缺失需记录 warning |
| 废弃字段 | 返回 null 或兼容默认值 |
| 禁止返回 | secret/token/API Key 明文不得返回 |

### 4.9 L5 分布式后台任务测试

使用至少两个 sub2api 实例或 worker 并发运行，验证：

- 价格同步只执行一次。
- 价格同步源是 `mal0130/sub2api` fork 指定分支。
- Webhook retry 不重复发送同一事件。
- Codex usage protection 恢复不重复写状态。
- rate limit/overload 恢复不互相覆盖。
- 清理任务幂等。
- 任务失败后锁能释放。
- 锁过期后任务可被其他实例接管。

输出：

- task execution log。
- lock acquisition log。
- duplicated event count。
- task id / instance id / duration。

### 4.10 L6 real upstream smoke

real upstream smoke 只做少量测试：

- 每个平台至少 1 个成功请求。
- 每个平台至少 1 个流式请求，若该平台生产会使用流式。
- OpenAI OAuth refresh 1 次。
- DeepSeek 真实 chat 1 次。
- Partner API 不需要真实 upstream。

这些结果不用于证明计费精确一致，只证明真实链路可用。

### 4.11 差异报告格式

每次测试输出 diff report，建议包含：

| 字段 | 说明 |
| --- | --- |
| `run_id` | 本次测试 id |
| `sample_version` | 样本版本 |
| `code_version` | sub2api commit |
| `pricing_version` | 价格版本 |
| `started_at` / `finished_at` | 时间 |
| `total_cases` | 总用例数 |
| `passed_cases` | 通过数 |
| `failed_cases` | 失败数 |
| `blocked_items` | P0 阻断项 |
| `warnings` | 非阻断差异 |
| `case_diffs` | 每个用例 diff |

单个 case diff 建议包含：

```json
{
  "case_id": "REQ-DEEP-001",
  "priority": "P0",
  "status": "failed",
  "diffs": [
    {
      "path": "usage.cache_read_tokens",
      "crs": 600,
      "sub2api": 0,
      "severity": "blocker"
    }
  ]
}
```

### 4.12 切换前测试 gate

进入生产短窗口全量切换前，必须满足：

- L0 数据迁移校验通过。
- L1 API replay P0 全部通过。
- L2 计费对账 P0 全部通过。
- L3 Partner API P0 全部通过。
- L4 外部同步契约 P0 全部通过。
- L5 分布式后台任务 P0 全部通过。
- L6 real upstream smoke 无阻断问题。
- 所有 P1 未通过项已有风险确认和兜底方案。

## 5. 后续落地产物

建议后续继续拆成三份可执行产物：

1. `compatibility-matrix.csv`：从本文第 2 章抽取为可跟踪矩阵。
2. `golden-samples-manifest.json`：定义样本库版本和覆盖率。
3. `compatibility-test-report.json`：每次测试自动生成差异报告。

正式切换前，迁移验收报告应引用上述三个产物，并给出是否满足全量 cutover gate 的结论。
