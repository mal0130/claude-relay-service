# Redis Key 清单整理

生成时间：2026-06-01

## 说明

本文档整理了项目中 Redis 使用到的主要 key 模式、类型、内部内容和用途。

说明：

- 绝大多数 key 定义集中在 `src/models/redis.js`
- 少量业务模块会直接通过 `getClient()` / `getClientSafe()` 拼接和访问 key
- 同一类 key 通常会配套出现 `:index`、`:empty`、`:temp` 等辅助 key
- 下文中的 `{keyId}`、`{accountId}`、`{model}`、`{date}` 等均表示动态占位符
- `Hash` 一般表示多个字段的对象；`String` 有时保存简单标量，有时保存 JSON 字符串

## 1. API Key 相关

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `apikey:{keyId}` | Hash | API Key 主记录；常见字段包括 `id`、`name`、`key`(哈希后)、`permissions`、`modelRestrictions`、`serviceRates`、`rateLimit`、`rateLimits`、`dailyCostLimit`、`totalCostLimit`、`weeklyCostLimit`、`expiresAt`、`isEnabled`、`tags`、`userId`、`externalUid`、`accountBindings`、`packMode`、`memberUids` 等 | API Key 的主数据来源，认证、权限判断、限额检查、账号绑定、后台展示都依赖它 |
| `apikey:hash_map` | Hash | `hashedKey -> keyId` 映射 | 收到明文 API Key 后，先做 SHA-256，再通过该映射快速定位 `keyId` |
| `apikey_hash:{hashedKey}` | Hash | 旧版哈希映射，通常仍保存 `keyId` 或兼容字段 | 兼容旧数据或迁移逻辑 |
| `apikey:tags:all` | Set | 所有出现过的标签字符串 | 后台筛选、标签下拉、批量管理时使用 |
| `apikey:idx:all` | Set | 全部 API Key ID | 全量遍历、重建索引、后台分页的基础集合 |
| `apikey:index:version` | String | 当前 API Key 二级索引版本号 | 判断分页/筛选索引是否可直接使用，避免反复全量扫描 |
| `apikey:index:*` | Set / String | API Key 索引服务生成的辅助索引、分页游标或缓存标记 | 提高后台 API Key 列表筛选和排序效率 |
| `apikey:idx:*` | Set | 某类筛选条件下的 Key ID 集合，如某标签、某状态、某归属用户等 | 支撑 API Key 列表快速过滤 |
| `apikey:set:*` | Set | 业务语义分组后的 Key ID 集合 | 保存某类 Key 的集合，如可切换集合、可用集合 |
| `apikey:set:active` | Set | 当前活跃 API Key ID 集合 | Partner API 等场景直接拿活跃 Key 集合做批量操作 |

补充：

- `apikey:{keyId}` 的字段会随功能扩展继续增长，但总体上都属于“配置 + 权限 + 限额 + 绑定关系 + 状态”这几类。
- 该类 key 是整个系统最核心的数据入口之一。

## 2. API Key 使用量统计

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `usage:{keyId}` | Hash | API Key 总累计统计；常见字段有 `requests`、`inputTokens`、`outputTokens`、`cacheCreateTokens`、`cacheReadTokens`、`allTokens`，部分场景还会带 `totalRequests`、`totalInputTokens`、`totalOutputTokens` 等累计字段 | 展示某个 Key 的总使用量，也是很多报表和限额判断的基础数据 |
| `usage:daily:{keyId}:{YYYY-MM-DD}` | Hash | 某 Key 某天的统计字段集合 | 日维度报表、每日额度、趋势统计 |
| `usage:monthly:{keyId}:{YYYY-MM}` | Hash | 某 Key 某月的统计字段集合 | 月报表、月度账单汇总 |
| `usage:hourly:{keyId}:{YYYY-MM-DD:HH}` | Hash | 某 Key 某小时的统计字段集合 | 小时级趋势、排障和局部分析 |
| `usage:records:{keyId}` | List | 最近请求记录列表，每一项通常是 JSON 字符串，包含时间、模型、tokens、费用、请求摘要等 | 给后台或诊断接口提供最近请求明细；默认保留最近固定条数并设置较长 TTL |
| `usage:global:total` | Hash | 全局累计统计字段 | 展示系统总体使用量 |
| `usage:global:daily:{YYYY-MM-DD}` | Hash | 全局某日统计字段 | 全局日维度趋势和统计面板 |
| `usage:global:monthly:{YYYY-MM}` | Hash | 全局某月统计字段 | 全局月度汇总 |

这些统计通常包含：

- `requests`
- `inputTokens`
- `outputTokens`
- `cacheCreateTokens`
- `cacheReadTokens`
- `allTokens`
- 部分总量 key 还会包含 `totalRequests`、`totalInputTokens` 等累计字段

## 3. 按模型统计的使用量

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `usage:model:daily:{model}:{YYYY-MM-DD}` | Hash | 全局某模型某日的 tokens / 请求数统计 | 看某模型在全系统范围内的日消耗 |
| `usage:model:monthly:{model}:{YYYY-MM}` | Hash | 全局某模型某月统计 | 看模型月度成本和流量 |
| `usage:model:hourly:{model}:{YYYY-MM-DD:HH}` | Hash | 全局某模型某小时统计 | 细粒度排障和高峰期分析 |
| `usage:{keyId}:model:daily:{model}:{YYYY-MM-DD}` | Hash | 某个 API Key 在某模型上的日统计 | Key 维度 + 模型维度联合分析 |
| `usage:{keyId}:model:monthly:{model}:{YYYY-MM}` | Hash | 某个 API Key 在某模型上的月统计 | 账单拆分、套餐分析 |
| `usage:{keyId}:model:hourly:{model}:{YYYY-MM-DD:HH}` | Hash | 某个 API Key 在某模型上的小时统计 | 问题时段追踪 |
| `usage:{keyId}:model:alltime:{model}` | Hash | 某个 API Key 对某模型的长期累计统计 | 看某 Key 在某模型上的历史总消耗 |

## 4. 使用量索引 Key

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `usage:daily:index:{date}` | Set | 当天有使用记录的 `keyId` 集合 | 避免为生成日报而扫描全部 Key |
| `usage:hourly:index:{hour}` | Set | 某小时有使用记录的 `keyId` 集合 | 小时统计时快速定位活跃 Key |
| `usage:model:daily:index:{date}` | Set | 某天出现过的模型名集合 | 只遍历当天实际出现过的模型 |
| `usage:model:hourly:index:{hour}` | Set | 某小时出现过的模型名集合 | 小时模型统计索引 |
| `usage:model:monthly:index:{month}` | Set | 某月出现过的模型名集合 | 月度模型汇总索引 |
| `usage:model:monthly:months` | Set | 所有出现过的月份字符串集合 | 月度模型统计时先知道有哪些月份可查 |
| `usage:keymodel:daily:index:{date}` | Set | 当天出现过的 `keyId:model` 组合 | 精细化重建或查询 key-model 日统计 |
| `usage:keymodel:hourly:index:{hour}` | Set | 某小时出现过的 `keyId:model` 组合 | 精细化小时统计索引 |
| `*:empty` | String | 通常值为简单标记，如 `1` / `true` | 表示某次扫描结果为空，防止重复回退到全量 SCAN |

## 5. API Key 费用统计

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `usage:cost:daily:{keyId}:{YYYY-MM-DD}` | String | 某 Key 某天按倍率折算后的费用数字字符串 | 用于面向客户/套餐的计费统计 |
| `usage:cost:monthly:{keyId}:{YYYY-MM}` | String | 某 Key 某月倍率后费用 | 月账单展示 |
| `usage:cost:hourly:{keyId}:{YYYY-MM-DD:HH}` | String | 某 Key 某小时倍率后费用 | 小时趋势和排障 |
| `usage:cost:total:{keyId}` | String | 某 Key 的倍率后总费用 | 总费用限制、总账单展示 |
| `usage:cost:real:daily:{keyId}:{YYYY-MM-DD}` | String | 某 Key 某天真实成本数字字符串 | 对账、毛利分析 |
| `usage:cost:real:total:{keyId}` | String | 某 Key 的真实总成本 | 对账和内部核算 |

补充：

- 这里的 `String` 通常就是一个可转成 `Number` 的金额字符串。
- `rated cost` 面向业务计费，`real cost` 面向内部真实成本。

## 6. Opus 周费用统计

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `usage:opus:weekly:{keyId}:{period}` | String | 某个结算周期内的 Opus 倍率费用 | 周套餐/周额度限制 |
| `usage:opus:total:{keyId}` | String | Opus 倍率总费用 | 长期累计统计 |
| `usage:opus:real:weekly:{keyId}:{period}` | String | 某周期 Opus 真实费用 | 对账与成本分析 |
| `usage:opus:real:total:{keyId}` | String | Opus 真实总费用 | 长期真实成本统计 |

## 7. 账号维度使用统计

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `account_usage:{accountId}` | Hash | 账号累计请求数、tokens、缓存 tokens 等统计字段 | 看“上游账号”本身的总消耗 |
| `account_usage:daily:{accountId}:{YYYY-MM-DD}` | Hash | 账号日统计字段 | 账号日维度趋势 |
| `account_usage:monthly:{accountId}:{YYYY-MM}` | Hash | 账号月统计字段 | 账号月报表 |
| `account_usage:hourly:{accountId}:{YYYY-MM-DD:HH}` | Hash | 账号小时统计字段 | 账号高峰期和异常分析 |
| `account_usage:model:daily:{accountId}:{model}:{YYYY-MM-DD}` | Hash | 某账号某模型日统计 | 细分账号下不同模型的负载 |
| `account_usage:model:monthly:{accountId}:{model}:{YYYY-MM}` | Hash | 某账号某模型月统计 | 月度模型分摊 |
| `account_usage:model:hourly:{accountId}:{model}:{YYYY-MM-DD:HH}` | Hash | 某账号某模型小时统计 | 精细化追踪 |
| `account_usage:daily:index:{date}` | Set | 当天有使用的账号 ID 集合 | 账号日报索引 |
| `account_usage:hourly:index:{hour}` | Set | 某小时有使用的账号 ID 集合 | 账号小时统计索引 |
| `account_usage:model:daily:index:{date}` | Set | 当天出现的 `accountId:model` 组合 | 账号模型日统计索引 |
| `account_usage:model:hourly:index:{hour}` | Set | 某小时出现的 `accountId:model` 组合 | 账号模型小时统计索引 |

## 8. 各平台账号主数据

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `claude:account:{accountId}` | Hash | Claude 官方账号字段，常见包括 `id`、`name`、`email`、加密后的 token/refreshToken、状态、限流状态、调度标记、代理配置等 | Claude 官方账号管理与调度 |
| `claude:account:index` | Set | 全部 Claude 官方账号 ID | 列表和调度遍历 |
| `droid:account:{accountId}` | Hash | Droid 账号主数据 | Droid 调度与管理 |
| `droid:account:index` | Set | 全部 Droid 账号 ID | 列表和调度遍历 |
| `openai:account:{accountId}` | Hash | OpenAI 账号主数据；除基础字段外还可能包含 Codex 使用量快照字段、自动保护状态等 | OpenAI 调度、限额保护和后台管理 |
| `openai:account:index` | Set | 全部 OpenAI 账号 ID | 列表和调度遍历 |
| `openai_responses_account:{accountId}` | Hash | OpenAI Responses 账号主数据 | OpenAI Responses 专用调度与后台管理 |
| `openai_responses_account:index` | Set | 全部 OpenAI Responses 账号 ID | 列表和调度遍历 |
| `azure_openai:account:{accountId}` | Hash | Azure OpenAI 账号主数据 | Azure OpenAI 调度与管理 |
| `azure_openai:account:index` | Set | 全部 Azure OpenAI 账号 ID | 列表和调度遍历 |
| `ccr_account:{accountId}` | Hash | CCR 账号主数据 | CCR 调度与管理 |
| `ccr_account:index` | Set | 全部 CCR 账号 ID | 列表和调度遍历 |

补充：

- 这类主数据通常都会保存账号基本信息、启用状态、调度开关、错误状态、加密后的敏感凭据、代理或模型相关配置。
- Gemini / Bedrock / DeepSeek 等平台也遵循类似模式，通常为：
  - `{platform}:account:{id}`
  - `{platform}:account:index`
  - 或 `{platform}_account:{id}` / `{platform}_account:index`

## 9. 登录、会话与 OAuth

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `session:{sessionId}` | Hash | 通用 session 对象，常见是管理员登录态或后台会话数据 | 后台登录认证、会话续期 |
| `session:admin_credentials` | Hash | 管理员凭据缓存或初始化后的账号信息 | 启动时初始化/读取管理员凭据 |
| `oauth:{sessionId}` | Hash | OAuth 临时会话字段，如 state、codeVerifier、来源信息、过期时间等 | 完成 OAuth 登录流程中的中间态保存 |
| `sticky_session:{sessionHash}` | String | 值通常是被绑定到的 `accountId` | 通用粘性会话：同一会话 hash 尽量复用同一账号 |
| `unified_claude_session_mapping:{sessionHash}` | String | 映射到 Claude 调度器选中的账号 ID | Claude 统一调度中的粘性绑定 |
| `unified_openai_session_mapping:{sessionHash}` | String | 映射到 OpenAI 调度器选中的账号 ID | OpenAI 统一调度中的粘性绑定 |
| `unified_gemini_session_mapping:{sessionHash}` | String | 映射到 Gemini 调度器选中的账号 ID | Gemini 统一调度中的粘性绑定 |
| `unified_gemini_session_mapping:{normalized}:{sessionHash}` | String | 更细粒度的 Gemini 会话账号映射 | 让不同归一化维度下的会话维持稳定账号 |
| `deepseek_session_mapping:{sessionHash}` | String | 映射到 DeepSeek 选中账号 ID | DeepSeek 粘性绑定 |
| `openai_session_account_mapping:{sessionHash}` | String | OpenAI 服务使用的 session -> accountId 绑定 | OpenAI 专用会话绑定 |
| `gemini_session_account_mapping:{sessionHash}` | String | Gemini 服务使用的 session -> accountId 绑定 | Gemini 专用会话绑定 |
| `azure_openai_session_account_mapping:{sessionId}` | String | Azure OpenAI 会话 -> accountId 绑定 | Azure OpenAI 专用会话绑定 |

## 10. 并发控制

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `concurrency:{apiKeyId}` | ZSet | 成员通常是 `requestId`，score 是该请求租约的过期时间戳 | 记录某个 API Key 当前占用中的并发请求，并用过期时间做租约清理 |
| `concurrency:queue:{apiKeyId}` | String | 当前排队数，通常是计数值 | 统计正在等待该 Key 并发槽位的请求数 |
| `concurrency:queue:stats:{apiKeyId}` | Hash | 如 `entered`、`success`、`timeout`、`cancelled` 等计数字段 | 排队效果统计和调优依据 |
| `concurrency:queue:wait_times:{apiKeyId}` | List | 该 Key 的等待时间样本，通常是毫秒值字符串 | 计算平均等待时间、观察是否拥堵 |
| `concurrency:queue:wait_times:global` | List | 全局等待时间样本 | 看整个系统的排队体验 |

补充：Claude Console 账号并发控制在实现上复用了 `concurrency:` 结构，只是逻辑 key 会组合成 `console_account:{accountId}` 再交给统一并发方法处理。

## 11. 速率限制

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `rate_limit:requests:{keyId}{suffix}` | String | 当前窗口内请求次数计数 | 控制某 Key 在某窗口内最多能发多少请求 |
| `rate_limit:tokens:{keyId}` | String | 当前窗口内 token 数累计值 | 控制窗口内 token 消耗 |
| `rate_limit:cost:{keyId}{suffix}` | String | 当前窗口内费用累计值 | 控制窗口内金额额度 |
| `rate_limit:window_start:{keyId}{suffix}` | String | 当前窗口起始时间戳或时间标记 | 判断当前计数属于哪个窗口 |
| `ratelimit:*` | 多种 | 旧版命名下的限流计数和窗口记录 | 兼容老逻辑和清理任务 |

补充：

- `{suffix}` 可能对应不同窗口配置，因此同一 Key 可以同时维护多个窗口。
- 这类 key 通常都带 TTL，使窗口自然过期。

## 12. 分布式锁与刷新锁

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `token_refresh_lock:{platform}:{accountId}` | String | 锁值通常是随机请求 ID 或锁拥有者标识 | 防止同一账号同时触发多次 token 刷新 |
| `user_msg_queue_lock:{accountId}` | String | 当前持有消息处理权的 `requestId` | 保证某账户的用户消息串行处理 |
| `user_msg_queue_last:{accountId}` | String | 最近一条消息完成的时间戳 | 节流和锁释放后的时间控制 |
| `lock:*` / 自定义 `lockKey` | String | 简单锁值，通常是随机 token / requestId / `1` | 保护迁移、初始化、排行重建等一次性任务 |

## 13. 用户消息队列

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `user_msg_queue_lock:{accountId}` | String | 当前处理中请求的 `requestId` | 判断该账号是否正在处理消息 |
| `user_msg_queue_last:{accountId}` | String | 上一条消息完成时间戳 | 做串行节流和延迟判定 |

这部分主要由 `src/services/userMessageQueueService.js` 使用。

## 14. 账户余额与脚本配置

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `account_balance:{platform}:{accountId}` | Hash | 远端接口返回的余额信息，如余额数值、币种、更新时间、额外原始字段 | 缓存上游余额查询结果，减少频繁请求 |
| `account_balance_local:{platform}:{accountId}` | Hash | 本地估算余额数据，如推算剩余额度、更新时间等 | 当上游余额不好取时给出本地估算值 |
| `account_balance_script:{platform}:{accountId}` | String | 余额查询脚本配置，通常为脚本内容或配置字符串 | 支持对某些平台自定义余额获取逻辑 |

## 15. 账户测试相关

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `account:test_history:{platform}:{accountId}` | List | 最近测试结果列表，每项通常是测试结果 JSON 字符串 | 保存账户测试历史，便于后台查看最近连通性结果 |
| `account:test_config:{platform}:{accountId}` | Hash | 定时测试配置字段，如开关、周期、模型、参数等 | 控制定时测试行为 |
| `account:last_test:{platform}:{accountId}` | String | 上次测试时间戳或时间字符串 | 判断最近一次测试时间 |

## 16. 账户分组

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `account_groups` | Set | 所有分组 ID 集合 | 获取全部分组列表 |
| `account_group:{groupId}` | Hash | 分组元数据字段，如 `id`、`name`、`platform`、`description`、`createdAt`、`updatedAt` | 保存账户分组本身的信息 |
| `account_group_members:{groupId}` | Set | 该分组下的账号 ID 列表 | 表示某个分组包含哪些账号 |
| `account_groups_reverse:{platform}:{accountId}` | Set | 某账号所属的分组 ID 集合 | 反向查询某个账号被哪些分组引用 |
| `account_groups_reverse:migrated` | String | 通常为 `true` | 表示反向索引回填是否已完成 |

## 17. 请求明细与查询快照

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `request_detail:item:{requestId}` | String | 单条请求明细 JSON；常见字段有 `requestId`、`timestamp`、`endpoint`、`method`、`statusCode`、`stream`、`apiKeyId`、`accountId`、`accountType`、`model`、`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheCreateTokens`、`totalTokens`、`cost`、`realCost`、`durationMs`、`requestBodySnapshot`、`reasoningDisplay` 等 | 保存请求级别的详细记录，供后台明细查询 |
| `request_detail:index:day:{YYYY-MM-DD}` | ZSet | 成员是 `requestId`，score 是请求时间毫秒时间戳 | 用日期维度索引请求明细，支持按时间范围取明细 |
| `request_detail:query_snapshot:{snapshotId}` | String | 查询快照 JSON，包含 `filterSignature`、拍平后的 `matchedPointers`、`availableFilters`、`summary`、`filters`、`createdAt` 等 | 将一次复杂查询的匹配结果短暂缓存，供翻页复用，避免每页都重新全量扫描 |

补充：

- 明细项和查询快照都有 TTL。
- `request_detail:item:*` 存的是 JSON 字符串，不是 Hash。

## 18. 费用排行

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `cost_rank:{timeRange}` | ZSet | 成员是 `keyId`，score 是对应时间范围内的费用 | 预计算 API Key 费用排行 |
| `cost_rank:{timeRange}:temp:{timestamp}` | ZSet | 重建排行过程中的临时排序数据 | 用于原子替换正式排行 key，避免读到半成品 |
| `cost_rank_meta:{timeRange}` | Hash | 排行元信息，如 `status`、`updatedAt`、`processedKeys`、`durationMs` 等 | 记录排行重建状态和元数据 |
| `cost_rank_lock:{timeRange}` | String | 简单锁值，通常为 `1` | 防止同一时间范围被重复并发重建 |

## 19. Claude Code 与请求头缓存

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `claude_code_headers:{accountId}` | String | JSON 字符串，结构通常为 `{ headers, version, updatedAt }`；`headers` 内保存 `x-stainless-*`、`user-agent`、`x-app` 等请求头 | 为某账号缓存更高版本的 Claude Code 请求头，后续转发可复用相同头部特征 |
| `claude_code_user_agent:daily` | String | 当日统一 User-Agent 字符串 | 给当天生成的请求复用统一 UA |
| `fmt_claude_req:stainless_headers:{accountId}` | String | 仅保存 Stainless 指纹 JSON，如 `x-stainless-lang`、`x-stainless-os`、`x-stainless-runtime-version` 等 | 持久化某账号的请求指纹，后续补齐或重写请求头，保持与真实客户端一致 |

补充：

- `fmt_claude_req:stainless_headers:{accountId}` 使用 `SET key serialized NX` 持久化，首次写入后通常不会反复覆盖。
- 这两类 key 都偏“请求身份拟合”用途，不直接参与业务计费。

## 20. 用户体系

这部分主要在 `src/services/userService.js` 中直接拼接 key。

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `user:{userId}` | String | 用户对象 JSON，常见字段包括 `id`、`username`、`email`、`displayName`、`firstName`、`lastName`、`role`、`isActive`、`createdAt`、`updatedAt`、`lastLoginAt`、`apiKeyCount`、`totalUsage`、`deletedAt` 等 | 保存用户主数据 |
| `username:{username}` | String | 值就是对应的 `userId` | 通过用户名快速反查用户 ID |
| `user:index` | Set | 全部用户 ID | 管理员分页和用户统计 |
| `user_session:{sessionToken}` | String | 用户 session JSON，如 `token`、`userId`、`createdAt`、`expiresAt` 以及额外会话字段 | 用户后台登录会话 |

## 21. externalUid 与企业成员索引

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `uid_keys:{externalUid}` | Set | 该 externalUid 绑定的全部 `keyId` | 同一外部用户多个 Key 之间切换或查询时快速定位候选 Key |
| `enterprise_pack_member:{memberUid}` | Set | 某企业成员可使用的企业版 `keyId` 集合 | 企业版共享 Key 场景下，用成员 uid 找到允许使用的企业 Key |

## 22. 系统级 Key

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `system:migration:usage_index_v2` | String | 迁移完成标记，通常是版本号或 `true` | 标记 usage 索引迁移是否完成 |
| `system:migration:alltime_model_stats_v1` | String | 迁移完成标记 | 标记 alltime 模型统计迁移是否完成 |
| `system:migrated:version` | String | 当前应用已执行到的数据迁移版本号 | 启动时判断是否还需要跑迁移 |
| `system:metrics:minute:{minuteTs}` | Hash | 某分钟的系统实时指标，如请求数、错误数、延迟等聚合数据 | 系统分钟级监控面板或诊断 |
| `version_check_cache` | String / Hash | 版本检查结果缓存，可能是版本号、时间戳或结果对象 | 减少重复的版本检查请求 |

## 23. 其他业务配置与缓存

| Key 模式 | 类型 | 里面是什么内容 | 用途 |
| --- | --- | --- | --- |
| `oem:settings` | Hash | OEM 相关后台配置字段 | 控制 OEM 展示或行为配置 |
| `claude_account:{accountId}:401_errors` | String | 某 Claude 账号近期 401 错误计数 | 用于识别账号异常、触发告警或限流保护 |

## 24. 常见辅助后缀说明

| 后缀 | 说明 |
| --- | --- |
| `:index` | 索引集合，用于避免全量扫描 |
| `:empty` | 空结果标记，避免重复 SCAN |
| `:temp` | 临时 key，通常用于重建/切换 |
| `:daily` / `:monthly` / `:hourly` | 时间维度统计 |
| `:real` | 真实费用或真实值 |
| `:global` | 全局汇总维度 |

## 25. 代码位置参考

核心定义与封装主要位于：

- `src/models/redis.js`

额外存在直接访问 Redis key 的模块主要包括：

- `src/services/requestDetailService.js`
- `src/services/costRankService.js`
- `src/services/accountGroupService.js`
- `src/services/userService.js`
- `src/services/tokenRefreshService.js`
- `src/services/claudeCodeHeadersService.js`
- `src/services/requestIdentityService.js`
- `src/routes/partner.js`
- `src/routes/admin/system.js`

## 26. 补充说明

- 本文以“项目实际使用到的 Redis key 模式”为主，不是 Redis 命令清单
- 表中个别 key 的底层类型可能会因兼容逻辑略有差异，但以当前主实现为准
- 若后续需要进一步下钻，可以继续补一版“每个 Hash 的 field 列表”和“每个 String JSON 的示例结构”
