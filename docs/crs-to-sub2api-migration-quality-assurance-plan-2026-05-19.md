# CRS 迁移到 sub2api 功能一致性保障方案

> 状态：讨论稿。用于保证 CRS 迁移到 sub2api 后，外部行为、计费结果和业务同步契约尽可能与原始项目保持一致。

## 1. 目标和原则

迁移目标不应简单写成“代码完全一致”，而应拆成：

- 外部行为必须一致：API 响应、错误码、计费结果、权限判断、限额行为、账号状态、Partner API、外部同步字段。
- 内部实现可以不同：数据库结构、调度实现、日志落库方式、后台任务实现、价格同步实现。
- 历史数据可分层处理：余额、额度、累计成本需要迁移；完整历史请求明细保留 CRS 只读归档。

核心原则：

- CRS 当前线上行为作为事实源。
- 所有迁移功能都必须有样本、预期结果和差异报告。
- 迁移前 dry-run，迁移中测试环境 replay/计费验证，迁移后短窗口全量切换和回滚。
- 不靠人工点测判断迁移是否完成。
- 由于 CRS 和 sub2api 计费事实源不同，生产环境不做请求级灰度、不做 shadow、不做默认 Key 级灰度；默认采用测试环境充分验证后的短窗口全量切换。

## 2. 功能兼容矩阵

先建立功能兼容矩阵，逐项标记优先级和验收方式。

| 类型 | 范围 | 要求 |
| --- | --- | --- |
| 必须完全一致 | API Key 认证、计费、Partner API、权限、倍率、5h/7d 限额、DeepSeek usage、外部同步字段 | 响应和数据结果需与 CRS 对齐 |
| 可实现不同但结果一致 | 内部数据结构、调度实现、日志落库方式、价格同步机制 | 外部契约一致即可 |
| 可延后 | 思考链翻译、部分后台 UI 细节、非核心 debug 日志 | 明确为二期或可选能力 |
| 明确不迁移 | CRS Redis 内部 key 结构、完整历史请求明细导入 | 保留 CRS 只读归档 |

每个功能点至少记录：

- CRS 当前行为。
- sub2api 目标行为。
- 迁移方式。
- 验收样本。
- 允许差异范围。
- 回滚方案。

重点功能点包括：

- 同一个 `cr_...` Key 跨 Claude/OpenAI/Gemini/DeepSeek/Kimi/GLM/MiniMax。
- 外部业务系统原始 Key 导入。
- 不同平台不同倍率计费。
- Partner API 签名、字段、错误格式。
- DeepSeek cache hit/miss 计费。
- Kimi/GLM Anthropic 协议路由和格式转换。
- GLM/MiniMax 分层计费（按 context 大小分档，GLM 含国内定价÷7 换算 USD）。
- 账户级模型映射（DeepSeek/Kimi/GLM/MiniMax）。
- 5h/7d 限额。
- `externalUid` 自动切换。
- OpenAI Codex 用量保护。
- 账号同步和业务系统读取。
- 分布式部署下后台任务只执行一次。
- 价格同步从 `mal0130/sub2api` fork 指定分支读取。

## 3. Golden Test 样本库

从 CRS 线上或 staging 导出一批真实但脱敏的样本，作为迁移后的黄金样本。

### 3.1 API Key 样本

- 普通套餐 Key。
- 资源包 Key。
- 带 `externalUid` 的多个 Key。
- 不同平台倍率的 Key。
- DeepSeek binding Key。
- Kimi binding Key。
- GLM binding Key。
- MiniMax binding Key。
- 过期、禁用、额度不足、限额命中的 Key。

### 3.2 请求样本

- Claude Messages。
- OpenAI Chat/Responses/Codex。
- Gemini。
- DeepSeek Chat Completions。
- DeepSeek Anthropic-compatible。
- Kimi Chat Completions（OpenAI 格式）。
- Kimi Anthropic-compatible。
- GLM Chat Completions（OpenAI 格式）。
- GLM Anthropic-compatible。
- GLM 分层计费边界（不同 context 大小档位）。
- MiniMax Chat Completions。
- MiniMax M3 512K 分层计费边界。
- 账户级模型映射（精确命中/通配符命中/未命中透传）。
- 流式和非流式。
- 有 cache usage 的请求。
- 请求失败、上游 401/429/529、prompt too long。

### 3.3 Partner API 样本

- 创建 Key。
- 更新 Key。
- 批量更新。
- 更新过期时间。
- 查询 usage。
- 查询 usage details。
- 签名错误。
- 字段缺失。

### 3.4 账号样本

- Claude/OpenAI/Gemini/DeepSeek active。
- Kimi/GLM/MiniMax active（含模型映射配置）。
- rate limited。
- disabled。
- Codex usage protection 命中。
- refresh failed。

### 3.5 样本内容

每个样本应保存：

- 请求输入。
- CRS 输出。
- CRS Redis 状态变化。
- CRS usage/cost 结果。
- CRS 日志/错误结果。
- 期望 sub2api 输出。

## 4. 兼容性测试套件

迁移需要专门的 compatibility test，而不只是普通单元测试。

测试模型：

```text
CRS sample input
  -> CRS expected output
  -> sub2api migrated output
  -> diff report
```

重点比对项：

- HTTP status code。
- response JSON 字段。
- error code / message。
- usage token breakdown。
- raw cost。
- actual cost。
- rate multiplier。
- API Key 扣费。
- 5h/7d window usage。
- account status change。
- request log 字段。
- Partner API 返回字段。
- Webhook event。

计费需要做到精确一致或有明确容忍范围。例如：

```text
CRS:
  total_cost = 0.0123
  service_rate = 1.2
  key_platform_rate = 1.5
  actual_cost = 0.02214

sub2api:
  total_cost = 0.0123
  rate_multiplier = 1.8
  actual_cost = 0.02214
```

如果 sub2api 多乘一次 group/user multiplier，兼容测试必须能直接发现。

## 5. 数据迁移 dry-run 和对账

正式迁移前，迁移工具必须支持 dry-run。

### 5.1 dry-run 报告

报告至少包含：

- API Key 总数。
- 成功映射数量。
- 缺少外部业务系统原始 `cr_...` Key 的数量。
- `legacy key id -> sub2api api_key_id` 映射。
- `externalUid -> key list` 映射。
- `serviceRates` 映射结果。
- 5h/7d 限额映射结果。
- account binding 映射结果。
- DeepSeek 账号映射结果。
- Kimi/GLM/MiniMax 账号映射结果。
- 模型映射（`modelMapping`）字段迁移结果。
- 价格缺失模型列表。
- 无法迁移字段列表。

### 5.2 迁移后对账

| 对账项 | 要求 |
| --- | --- |
| Key 数量 | CRS + 外部系统 = sub2api |
| 原始 Key | 外部业务系统保存的 `cr_...` 可在 sub2api 认证 |
| legacy id | 每个 CRS key/account 都能反查 |
| 余额/额度 | 与 CRS 当前口径一致 |
| 累计成本 | 与 CRS Redis 汇总一致 |
| 5h/7d 限额 | 配置一致 |
| 平台倍率 | Claude/OpenAI/Gemini/DeepSeek/Kimi/GLM/MiniMax 逐项一致 |
| 账号状态 | active/disabled/rate limited 等一致 |

没有 dry-run 和对账，不建议切流。

## 6. 测试环境计费验证和迁移演练

由于生产 shadow 会导致大模型请求翻倍、额外消耗账号限额，并且大模型输出天然不确定，不能作为精确计费一致性验证手段。因此验证重点放在测试环境。

### 6.1 mock upstream 精确计费验证

在测试环境同时部署 CRS staging 和 sub2api staging，并让两边指向固定响应的 mock upstream。

建议 mock upstream 覆盖：

- Claude mock upstream。
- OpenAI/Codex mock upstream。
- Gemini mock upstream。
- DeepSeek OpenAI-compatible mock upstream。
- DeepSeek Anthropic-compatible mock upstream。
- Kimi OpenAI-compatible mock upstream。
- Kimi Anthropic-compatible mock upstream。
- GLM OpenAI-compatible mock upstream（含分层计费触发响应）。
- GLM Anthropic-compatible mock upstream。
- MiniMax OpenAI-compatible mock upstream（含 M3 512K 分层计费触发响应）。
- MiniMax Anthropic-compatible mock upstream。

mock 响应必须固定：

- token usage 固定。
- cache hit/miss 固定。
- 错误响应固定。
- 流式 chunk 和最终 usage chunk 固定。
- 响应耗时和断开场景可控。

重点验证：

- 相同请求是否选择正确平台。
- 是否写入正确 `api_key_id`、`group_id`、`account_id`。
- usage token breakdown 是否一致。
- raw cost 是否一致。
- service rate / Key 平台倍率是否一致。
- actual cost 是否一致。
- 5h/7d 限额是否按 `actual_cost` 消耗。
- Partner API usage 聚合是否一致。
- DeepSeek cache hit/miss 是否一致。
- GLM 分层计费档位和 USD 换算是否一致。
- MiniMax M3 512K 分层计费档位是否一致。
- 账户级模型映射是否正确（精确命中/通配符/未命中）。
- 错误码、错误文案和 request detail 是否一致。

### 6.2 real upstream 小样本连通验证

真实上游请求只用于验证链路可用，不作为精确计费对账依据。

适合验证：

- OAuth token refresh。
- 代理和网络连通。
- SSE 传输。
- 实际账号是否可用。
- OpenAI/Claude/Gemini/DeepSeek/Kimi/GLM/MiniMax 基础转发。
- DeepSeek/OpenAI-compatible provider 的真实响应格式。

要求：

- 使用测试账号。
- 样本数量少。
- 不影响生产账号限额。
- 不用于证明计费完全一致。

### 6.3 生产全量迁移演练

正式切换前，使用生产快照做至少一次完整演练，但不接真实生产流量。

演练步骤：

1. 从 CRS Redis 导出 API Key metadata、计费状态、账号状态和 usage 汇总。
2. 从外部业务系统导出原始 `cr_...` Key。
3. 导入 sub2api staging 或预生产环境。
4. 执行 migration dry-run 和正式导入模拟。
5. 执行兼容测试和计费对账。
6. 验证 Partner API、外部同步 API/view/Webhook。
7. 生成迁移验收报告。

演练通过后，才能进入生产短窗口全量切换。

## 7. 分布式部署专项验证

分布式部署必须单独验证，否则后台任务可能重复执行或互相覆盖。

### 7.1 后台任务清单

- 价格同步。
- OpenAI token refresh。
- Codex usage protection 自动恢复。
- rate limit / overload 状态恢复。
- webhook 重试。
- usage 聚合。
- 过期 Key/账号状态维护。
- Redis/cache 清理。
- 外部同步任务。
- 从 `mal0130/sub2api` fork 指定分支同步价格。

### 7.2 任务运行要求

| 字段 | 要求 |
| --- | --- |
| 是否允许多实例并发 | 大多数不允许 |
| 是否需要分布式锁 | 是 |
| 锁 key | 固定命名 |
| 锁超时 | 防止 worker 死锁 |
| 幂等性 | 必须支持重复执行 |
| 失败重试 | 指数退避或队列 |
| 执行日志 | 必须带 task id |
| 是否独立 worker | 重要任务建议独立 worker |

推荐方案：

- Web API 实例只处理请求。
- 后台任务由独立 worker 跑。
- 如果暂时不拆 worker，则每个 cron job 必须加 Redis/Postgres advisory lock。
- 所有任务必须幂等，避免重复扣费、重复通知、重复恢复账号。
- 价格同步固定读取 `mal0130/sub2api` fork 指定分支，不直接跟随 `Wei-Shaw/sub2api` 上游。

## 8. 短窗口全量切换和回滚

当前 Nginx 直接把请求转发到后端，不负责解析 API Key 或维护 Key 白名单。按 Key 灰度需要额外建设 gateway/Lua/njs/auth_request 等能力，工作量和风险较高。结合 CRS Redis 与 sub2api 计费事实源不同，默认采用短窗口全量切换。

### 8.1 禁止的切换方式

- 不做请求级灰度：同一个 `cr_...` Key 不能一部分请求走 CRS、一部分请求走 sub2api。
- 不做生产 shadow：避免大模型请求翻倍、成本翻倍和账号限额被额外消耗。
- 不做默认 Key 级灰度：除非后续专门建设可按 Key 路由且能同步业务读路径的 gateway。
- 不允许 CRS 和 sub2api 同时作为同一批 Key 的真实计费事实源。

### 8.2 全量切换前置条件

- 测试环境 mock upstream 计费测试通过。
- real upstream 小样本连通验证通过。
- Partner API 兼容测试通过。
- DeepSeek usage/cache hit/miss 解析测试通过。
- Kimi/GLM/MiniMax 路由和 Anthropic 协议适配测试通过。
- GLM/MiniMax 分层计费测试通过。
- 账户级模型映射测试通过（DeepSeek/Kimi/GLM/MiniMax）。
- 5h/7d 限额测试通过。
- `externalUid` 自动切换测试通过。
- OpenAI Codex 用量保护测试通过。
- 生产数据 dry-run 无阻断项。
- 价格模型无缺失，且价格同步源已固定为 `mal0130/sub2api` fork 指定分支。
- 原始 `cr_...` Key 导入覆盖率达标。
- 外部业务系统已完成读源切换准备。
- sub2api 分布式后台任务不会重复执行。
- Nginx 全量切换脚本已演练。
- 回滚脚本和补偿流程已演练。

### 8.3 正式切换步骤

建议在低峰期执行短暂停流量窗口。

```text
T-1：提前做一次生产全量导入演练
T0：Nginx 进入维护/暂停新请求
T1：等待 CRS in-flight 请求结束，或达到最大等待时间
T2：冻结 CRS API Key/账号/Partner API 写入
T3：导出 CRS Redis 最终状态
T4：导出外部业务系统原始 Key
T5：导入 sub2api
T6：执行迁移校验和对账
T7：校验通过后 Nginx upstream 全量切到 sub2api
T8：恢复流量
T9：CRS 进入只读归档
```

SSE 或长连接请求需要提前定义 drain 策略：

- 等待最长 N 分钟 drain。
- 或维护窗口开始后中断长连接。
- 或选择低峰期切换，降低长连接数量。

### 8.4 Nginx 切换方式

不建议让 Nginx 做 Key 级判断。推荐 blue-green upstream：

```text
切换前：Nginx -> CRS
切换后：Nginx -> sub2api
```

可选实现：

- 修改 Nginx upstream 指向。
- 切换服务发现目标。
- 切换 LB target group。
- Kubernetes Service selector 切换。

不使用 50/50 权重切换。

### 8.5 外部业务系统同步切换

全量切换需要同时切 API 流量和业务数据源：

- API 请求入口切到 sub2api。
- Partner API 地址切到 sub2api。
- 外部业务系统 usage 同步源切到 sub2api。
- AI 平台账号同步源切到 sub2api。
- CRS Redis 标记为只读归档。
- CRS 管理后台禁止继续修改 Key/账号。

如果 API 已切 sub2api，但业务系统仍读 CRS Redis，会出现用量不增长或账务不同步。

### 8.6 回滚策略

回滚分两类。

**切换前校验失败**

- 如果导入 sub2api 后校验不通过，且还没有恢复流量，则不切换，Nginx 继续指向 CRS。

**切换后短时间发现问题**

sub2api 已产生新 usage，不能无脑切回 CRS。可选策略：

1. 短窗口人工补偿：暂停流量，导出 sub2api 期间 usage，人工或脚本补偿业务账，再切回 CRS。
2. 补写 CRS Redis：把 sub2api 期间 usage/cost 补写回 CRS Redis，再切回 CRS；需要可靠补账工具。
3. 向前修复：如果不是核心计费问题，例如 UI、部分日志字段、非核心统计，保持 sub2api 为事实源并热修。

建议定义：切换后前 15 分钟为强回滚窗口；超过强回滚窗口后，除非核心计费错误，否则优先向前修复。

## 9. 建议产物

建议把迁移质量保障落成三类产物：

1. 兼容矩阵：逐项列出 CRS 行为、sub2api 方案、验收方式。
2. Golden Samples：脱敏请求、Key、账号、usage、Partner API 样本。
3. 迁移验收报告：每次 dry-run、测试环境 replay、计费对账、全量切换演练都产出差异报告。

最终判断标准：

```text
核心兼容矩阵 100% 有验收
Golden tests 全通过
计费对账通过
Partner API 对账通过
数据迁移 dry-run 无阻断项
测试环境 mock upstream 计费验证通过
生产全量切换演练通过
短窗口回滚和补偿流程可执行
```
