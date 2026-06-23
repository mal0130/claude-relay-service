# Fork 相对上游修改整理

生成时间：2026-05-12（Asia/Singapore）

## 比较基准

- 当前分支：`main`
- 当前 HEAD：`79ac410f07d6`
- 上游分支：`upstream/main`
- 上游 HEAD：`477c3ec5ac6a`
- Merge base：`477c3ec5ac6a`
- 比较命令：`git diff upstream/main...HEAD`
- 提交差异：当前 fork 领先上游 `190` 个提交，落后上游 `0` 个提交
- 提交构成：共 `190` 个提交，其中非 merge `134` 个，merge/sync `56` 个
- 文件统计：`120 files changed, 18704 insertions(+), 2520 deletions(-)`
- 生成本文档前工作区状态：`干净`

> 说明：本报告统计的是写入本文档前 `HEAD` 与已 fetch 的 `upstream/main` 的差异，不包含本文档本身。

## 总览

当前 fork 不是简单的小修补，而是在上游基础上形成了一套面向多平台、合作伙伴、套餐计费和运维发布的定制版本。主要改动集中在 DeepSeek 平台接入、合作伙伴 API、API Key 套餐/限额/切换体系、OpenAI Codex 使用量保护、用量明细采集、后台统计 UI、LDAP 登录和部署脚本。

## 目录级统计

| 目录             | 文件数 | 新增行 | 删除行 |
| ---------------- | -----: | -----: | -----: |
| `.agents`        |      4 |    361 |      0 |
| `.github`        |      2 |    124 |    148 |
| `config`         |      2 |     32 |      1 |
| `docs`           |      6 |   3171 |      0 |
| `root`           |      7 |    208 |      1 |
| `scripts`        |      4 |   1181 |     54 |
| `src/app.js`     |      1 |     22 |     14 |
| `src/handlers`   |      1 |     71 |      0 |
| `src/middleware` |      3 |    903 |    219 |
| `src/models`     |      1 |     65 |      2 |
| `src/routes`     |     16 |   3420 |    172 |
| `src/services`   |     28 |   3771 |    188 |
| `src/utils`      |      8 |    747 |     11 |
| `tests`          |      8 |   1511 |     20 |
| `web/admin-spa`  |     29 |   3117 |   1690 |

## 主要改动详述

### 1. DeepSeek 平台支持

- 新增 DeepSeek 账户实体、加密存储、状态管理和调度：`src/services/account/deepseekAccountService.js`、`src/services/scheduler/unifiedDeepSeekScheduler.js`。
- 新增 DeepSeek 转发服务和路由：`src/services/relay/deepseekRelayService.js`、`src/routes/deepseekRoutes.js`，支持 `/deepseek/v1/chat/completions` 与 `/deepseek/anthropic/v1/messages`。
- 新增 DeepSeek 平台描述、模型标准化、URL 构建和 usage 归一化：`src/services/deepseekPlatform.js`。
- 后台管理新增 DeepSeek 账户 CRUD、测试、启停、重置限流状态等接口：`src/routes/admin/deepseekAccounts.js`，并接入 `src/routes/admin/index.js`。
- API Key 权限、账户绑定、分组、解绑和统计全部扩展到 `deepseek`：`src/services/apiKeyService.js`、`src/services/accountGroupService.js`、`src/routes/admin/accountGroups.js`、`src/routes/admin/usageStats.js`、`src/services/requestDetailService.js`。
- 前端账户页、API Key 创建/编辑/批量编辑、账号选择器和 Dashboard 增加 DeepSeek 入口与展示：`web/admin-spa/src/views/AccountsView.vue`、`web/admin-spa/src/components/accounts/AccountForm.vue`、`web/admin-spa/src/components/apikeys/CreateApiKeyModal.vue`、`web/admin-spa/src/components/apikeys/EditApiKeyModal.vue`、`web/admin-spa/src/views/DashboardView.vue`。
- 定价系统加入 DeepSeek 官方价格抓取、fallback 价格和 cache hit/miss 成本计算：`src/services/pricingService.js`、`scripts/update-model-pricing.js`、`tests/pricingService.test.js`、`tests/costCalculator.test.js`。

### 2. 合作伙伴 Partner API

- 新增签名认证中间件：`src/middleware/partnerAuth.js`，按参数排序拼接后使用 SHA-256 校验 `sign`，并记录签名计算过程以便排查。
- 新增合作伙伴路由：`src/routes/partner.js`，覆盖 API Key 创建、更新、批量更新、过期时间更新、用量汇总和近 30 天用量明细查询。
- 合作伙伴接口支持 `claude_account_id`、`openai_account_id`、`deepseek_account_id`、`kimi_account_id`、`glm_account_id`、`minimax_account_id` 绑定，支持账号组绑定，支持 `claude_rate`、`openai_rate`、`deepseek_rate`、`kimi_rate`、`glm_rate`、`minimax_rate` 和兼容字段 `rate`。
- 合作伙伴接口支持 `rateLimits` 多窗口限制、`pack_consent` 标签、`user_id`/`externalUid` 多 Key 切换索引。
- `config/config.example.js` 增加 `partnerApi.secret` 和默认 Claude 账号配置；`src/app.js` 挂载 `/partner` 路由。
- 新增 Partner API 文档和测试：`docs/partner-api.md`、`tests/partnerApi.simple.test.js`。
- 2026-05-12 之后进一步扩展出企业版 Partner API：新增企业 Key 批量创建、成员全量覆盖接口，以及 `memberUids`、`packMode=enterprise`、`enterprise_pack_member:{uid}` 反向索引等能力，详见 `docs/partner-api-enterprise.md` 与 `docs/enterprise-pack-design.md`。

### 3. API Key 套餐、限额和自动切换

- API Key 数据模型新增 `rateLimits`、`accountBindings`、`translateReasoning`、`externalUid`，并在 Redis 序列化/反序列化和列表查询中兼容旧字段。
- 认证链路抽出完整限制检查：`src/middleware/auth.js` 增加多窗口请求/费用限制、每日费用、总费用、Claude 周费用、AI 修复资源包限制。
- 多窗口限制使用 `rate_limit:window_start:{keyId}`、`rate_limit:requests:{keyId}`、`rate_limit:cost:{keyId}` 等 Redis key；创建 Key 时立即启动窗口，更新限制时仅在窗口结构变化时重置窗口。
- 新增 `externalUid` 索引：`src/models/redis.js` 中的 `uid_keys:{externalUid}`，用于同一用户多个 Key 之间自动切换。
- 自动切换逻辑按资源类型排序：AI 修复包、套餐、其他 Key、资源包；资源包切换需要 `pack_consent`，资源包之间可直接切换。
- 2026-05-12 之后新增企业版切换模式：通过 `uni_agent_subscription_type=enterprise` + `uni_agent_subscription_user_id` 从 `enterprise_pack_member:{uid}` 索引中筛选候选 Key，企业 Key 与个人 Key 切换链路完全隔离，且企业模式下不再依赖 `pack_consent`。
- 2026-05-12 之后继续补充企业资源包、个人请求过滤企业 Key、`packMode` 返回值和切换提示语优化等规则调整。
- 过期、禁用、费用超限、窗口超限等错误提示改成面向套餐/资源包的中文提示，并保留 402/403/429 等状态含义。
- 前端 API Key 创建、编辑、批量编辑支持多窗口限制、服务倍率、标签、`pack_consent`、DeepSeek 绑定和 `externalUid`：`web/admin-spa/src/components/apikeys/*.vue`、`web/admin-spa/src/views/ApiKeysView.vue`。

### 4. OpenAI Codex 使用量自动保护

- OpenAI 账户新增 Codex usage snapshot：5 小时窗口、周窗口、reset 秒数、窗口分钟数、超周均摊比例等字段。
- `src/routes/openaiRoutes.js` 从上游响应头提取 `x-codex-*` 使用量信息并写回 OpenAI 账户。
- `src/services/account/openaiAccountService.js` 新增 `updateCodexUsageSnapshot` 和自动停止调度判断：5 小时接近上限、周限额接近上限、周限额日均摊超限。
- `src/services/scheduler/unifiedOpenAIScheduler.js` 支持自动恢复调度：按 5 小时/周 reset 时间或日均摊的下一个本地零点恢复。
- 管理接口和前端账户表单加入自动保护开关与状态展示：`src/routes/admin/openaiAccounts.js`、`web/admin-spa/src/components/accounts/OpenAIUsageProtectionFields.vue`、`web/admin-spa/src/components/accounts/AccountForm.vue`。
- 新增 OpenAI mock 账号脚本和测试：`scripts/mock-openai-account.js`、`tests/openaiAccountService.usageLimit.test.js`、`tests/openaiRoutes.usageLimit.test.js`、`tests/unifiedOpenAIScheduler.usageLimit.test.js`、`docs/openai-mock-account-testing.md`、`docs/openai-usage-auto-stop.md`。

### 5. 用量明细、日志和请求追踪

- 新增请求 ID 中间件：`src/middleware/requestId.js`，并在 `src/app.js` 中提前注册，方便全链路日志追踪。
- 请求日志从 body 解析后再注册，记录请求体时会剔除 `tools` 和图片/base64 等大媒体内容，避免日志爆炸。
- 新增 `src/utils/userInputExtractor.js`，从 Anthropic/OpenAI/Gemini 请求中提取用户输入、developer/system 内容、用户 IP、进程类型和项目类型。
- `apiKeyService.recordUsage()` 和相关转发服务在 `ENABLE_USAGE_DETAIL=true` 时写入 sessionId、rawSessionId、userInput、userIp、processType、projectType、assistantContent 等扩展字段。
- OpenAI Responses、Claude、Gemini、Azure OpenAI、Droid、CCR 等转发服务补充 usage extra、请求元信息和断开清理逻辑。
- Redis usage record 默认保留数从 200 调整为 50，减少单 Key 明细占用。
- 增加流式 chunk 日志开关和更详细的上游响应日志，同时通过脱敏/截断策略避免输出图片 base64。
- 2026-05-12 之后又补充了 `tools` 字段存储、`user_id` 入 Redis、DeepSeek 场景下 `rawSessionId` 修正、请求完成后再记录 token 用量，以及 `x-request-id` 优先透传等细节修正。
- OpenAI `server_is_overloaded` 场景和错误日志采集也在后续提交中继续补强，说明这一块在原始汇总之后仍在迭代。

### 6. 思考链翻译

- 新增 `src/services/reasoningTranslationService.js`：对 reasoning delta 做增量翻译，按句子边界并发发起翻译并按原始顺序输出。
- 新增 `src/utils/reasoningTranslationTransformer.js`：拦截 OpenAI 风格 SSE，把翻译后的 `reasoning_content` 注入到流中，并把翻译 token usage 合并进 usage chunk。
- API Key 新增 `translateReasoning` 开关，前后端和 Redis 解析均支持该字段。
- OpenAI/兼容路由记录 reasoning、thinking、assistant output，支持中文化展示和费用统计附加字段。

### 7. 错误处理、通知和上游保护

- 上游错误归一化增强：`src/utils/upstreamErrorHelper.js`、`src/utils/errorSanitizer.js` 处理 400、401、402、429、529、上下文超长、Prompt too long 等场景。
- 对 OpenAI 账号 refresh 失败、限流、未授权、状态重置等事件发送 webhook 异常通知。
- `No available accounts` 增加每日一次提醒，减少重复告警。
- API 层优化错误返回文案，去除部分冗余提示，补充上下文过长识别并将 Prompt too long 映射为 413。
- `src/utils/rateLimitHelper.js` 支持多个窗口计数器，按倍率后成本更新窗口费用。

### 8. 统计和后台 UI

- Dashboard 增加 DeepSeek 账号统计、昨日快捷筛选、API Key 标签筛选、请求数/Token 指标切换、Top 50 图表和可排序分页统计表。
- API Key 趋势接口支持 `startDate`/`endDate`、`metric`、`tag` 参数，并返回 `apiKeyStats` 完整统计列表。
- 用户侧用量统计改成聚合所有 Key 的 daily/model 数据，补充 cache create/read tokens，移除季度选项并增加日志。
- 账号用量历史、账号趋势和请求明细支持 DeepSeek，明细响应补充 session、用户输入、项目类型、assistant 内容等扩展字段。
- 前端页面改动覆盖 `DashboardView.vue`、`ApiKeysView.vue`、`UserUsageStats.vue`、`UserApiKeysManager.vue`、`UserDashboardView.vue` 等。

### 9. LDAP 登录增强

- LDAP 支持直接绑定模式：新增 `LDAP_BIND_DN_PATTERN`，可跳过管理员绑定，直接用用户名模板构建用户 DN。
- LDAP 属性提取改为大小写不敏感，支持 Buffer 转字符串，并允许通过配置映射用户名。
- LDAP client 默认关闭自动重连，避免 API 请求中无限重连。
- 文档新增 `docs/ldap/configuration.md`，`.env.example` 增加直接绑定示例。
- 用户登录 IP 限流放宽：`src/routes/userRoutes.js` 将短期/长期 IP 限额提高到 300/1000。

### 10. 运维、发布和自动同步

- `scripts/manage.sh` 增强 PM2 支持：`--instances N|max`、保留/重建 cluster 模式、`--log-output`、`rotate-log`、更新/重启参数透传、Redis 密码引号修复。
- 新增 `scripts/sync-upstream.sh`，用于检查 upstream、比较版本、创建备份分支、合并上游、推送和触发发布。
- 新增 Codex agent skills：`.agents/skills/relay-service-manager/*` 和 `.agents/skills/sync-upstream/SKILL.md`。
- 自动发布 workflow 改为使用 `VERSION` 文件版本、不自动递增，禁用 Docker 镜像构建推送，并修复前端构建分支的 git 用户配置。
- 模型价格同步 workflow 改为在 `price-mirror` 分支生成价格镜像，`scripts/update-model-pricing.js` 增加 DeepSeek 价格镜像和 hash 输出。
- `Dockerfile` 增加 Alpine 编译工具，便于原生模块构建。

### 11. 文档和测试

- 新增/扩展文档：`docs/partner-api.md`、`docs/multi-platform-api-key-billing-plan.md`、`docs/multi-key-switching.md`、`docs/openai-usage-auto-stop.md`、`docs/openai-mock-account-testing.md`、`docs/ldap/configuration.md`。
- 2026-05-12 之后继续新增企业版相关文档：`docs/enterprise-pack-design.md`、`docs/partner-api-enterprise.md`，以及 CRS → sub2api 迁移相关文档。
- 新增测试覆盖 Partner API、OpenAI 使用量保护、OpenAI 路由使用量快照、统一 OpenAI 调度器保护、DeepSeek/缓存定价等。
- 2026-05-12 之后继续补充测试用例，并围绕企业版切换、日志采集和返回字段修正持续迭代。
- 现有测试同步更新成本计算、OpenAI Responses payload toggle、账户余额等场景。

## 新增接口清单

### DeepSeek

| 方法     | 路径                                              | 说明                                             |
| -------- | ------------------------------------------------- | ------------------------------------------------ |
| `POST`   | `/deepseek/v1/chat/completions`                   | DeepSeek OpenAI-compatible Chat Completions 转发 |
| `POST`   | `/deepseek/anthropic/v1/messages`                 | DeepSeek Anthropic Messages 兼容转发             |
| `GET`    | `/admin/deepseek-accounts`                        | DeepSeek 账号列表                                |
| `POST`   | `/admin/deepseek-accounts`                        | 创建 DeepSeek 账号                               |
| `GET`    | `/admin/deepseek-accounts/:id`                    | 查询 DeepSeek 账号                               |
| `PUT`    | `/admin/deepseek-accounts/:id`                    | 更新 DeepSeek 账号                               |
| `DELETE` | `/admin/deepseek-accounts/:id`                    | 删除 DeepSeek 账号                               |
| `PUT`    | `/admin/deepseek-accounts/:id/toggle-schedulable` | 切换是否参与调度                                 |
| `PUT`    | `/admin/deepseek-accounts/:id/toggle`             | 切换启用状态                                     |
| `POST`   | `/admin/deepseek-accounts/:id/reset-rate-limit`   | 重置限流状态                                     |
| `POST`   | `/admin/deepseek-accounts/:id/reset-status`       | 重置异常状态                                     |
| `POST`   | `/admin/deepseek-accounts/:accountId/test`        | 测试 DeepSeek 账号连通性                         |

### Partner API

| 方法   | 路径                                 | 说明                                                   |
| ------ | ------------------------------------ | ------------------------------------------------------ |
| `POST` | `/partner/api-key/usage`             | 查询一个或多个 API Key 用量汇总                        |
| `POST` | `/partner/api-key/usage-details`     | 查询近 30 天每日和模型维度用量明细                     |
| `POST` | `/partner/api-key/create`            | 创建 API Key，支持账户绑定、倍率、限额、资源包同意标签 |
| `POST` | `/partner/api-key/:keyId/update`     | 更新 API Key 配置                                      |
| `POST` | `/partner/api-key/:keyId/expiration` | 更新过期时间/手动激活                                  |
| `POST` | `/partner/api-key/update-config`     | 批量更新多个 API Key 配置                              |
| `POST` | `/partner/enterprise/key/batch-create` | 批量创建企业版 API Key                                 |
| `POST` | `/partner/enterprise/key/members/set`  | 全量覆盖企业版成员列表并同步维护成员反向索引           |

### Kimi

> 2026-05-12 之后新增

| 方法   | 路径                                             | 说明                                          |
| ------ | ------------------------------------------------ | --------------------------------------------- |
| `POST` | `/kimi/v1/chat/completions`                      | Kimi OpenAI-compatible Chat Completions 转发  |
| `POST` | `/kimi/anthropic/v1/messages`                    | Kimi Anthropic Messages 兼容转发              |
| `GET`  | `/admin/kimi-accounts`                           | Kimi 账号列表                                 |
| `POST` | `/admin/kimi-accounts`                           | 创建 Kimi 账号                                |
| `GET`  | `/admin/kimi-accounts/:id`                       | 查询 Kimi 账号                                |
| `PUT`  | `/admin/kimi-accounts/:id`                       | 更新 Kimi 账号                                |
| `DELETE` | `/admin/kimi-accounts/:id`                     | 删除 Kimi 账号                                |
| `PUT`  | `/admin/kimi-accounts/:id/toggle-schedulable`    | 切换是否参与调度                              |
| `PUT`  | `/admin/kimi-accounts/:id/toggle`                | 切换启用状态                                  |
| `POST` | `/admin/kimi-accounts/:id/reset-rate-limit`      | 重置限流状态                                  |
| `POST` | `/admin/kimi-accounts/:id/reset-status`          | 重置异常状态                                  |
| `POST` | `/admin/kimi-accounts/:accountId/test`           | 测试 Kimi 账号连通性                          |

### GLM

> 2026-05-12 之后新增

| 方法   | 路径                                            | 说明                                              |
| ------ | ----------------------------------------------- | ------------------------------------------------- |
| `POST` | `/glm/v1/chat/completions`                      | GLM (智谱AI) OpenAI-compatible Chat Completions 转发 |
| `POST` | `/glm/anthropic/v1/messages`                    | GLM Anthropic Messages 兼容转发                   |
| `GET`  | `/admin/glm-accounts`                           | GLM 账号列表                                      |
| `POST` | `/admin/glm-accounts`                           | 创建 GLM 账号                                     |
| `GET`  | `/admin/glm-accounts/:id`                       | 查询 GLM 账号                                     |
| `PUT`  | `/admin/glm-accounts/:id`                       | 更新 GLM 账号                                     |
| `DELETE` | `/admin/glm-accounts/:id`                     | 删除 GLM 账号                                     |
| `PUT`  | `/admin/glm-accounts/:id/toggle-schedulable`    | 切换是否参与调度                                  |
| `PUT`  | `/admin/glm-accounts/:id/toggle`                | 切换启用状态                                      |
| `POST` | `/admin/glm-accounts/:id/reset-rate-limit`      | 重置限流状态                                      |
| `POST` | `/admin/glm-accounts/:id/reset-status`          | 重置异常状态                                      |
| `POST` | `/admin/glm-accounts/:accountId/test`           | 测试 GLM 账号连通性                               |

### MiniMax

> 2026-05-12 之后新增

| 方法   | 路径                                               | 说明                                          |
| ------ | -------------------------------------------------- | --------------------------------------------- |
| `POST` | `/minimax/v1/chat/completions`                     | MiniMax OpenAI-compatible Chat Completions 转发 |
| `POST` | `/minimax/anthropic/v1/messages`                   | MiniMax Anthropic Messages 兼容转发           |
| `GET`  | `/admin/minimax-accounts`                          | MiniMax 账号列表                              |
| `POST` | `/admin/minimax-accounts`                          | 创建 MiniMax 账号                             |
| `GET`  | `/admin/minimax-accounts/:id`                      | 查询 MiniMax 账号                             |
| `PUT`  | `/admin/minimax-accounts/:id`                      | 更新 MiniMax 账号                             |
| `DELETE` | `/admin/minimax-accounts/:id`                    | 删除 MiniMax 账号                             |
| `PUT`  | `/admin/minimax-accounts/:id/toggle-schedulable`   | 切换是否参与调度                              |
| `PUT`  | `/admin/minimax-accounts/:id/toggle`               | 切换启用状态                                  |
| `POST` | `/admin/minimax-accounts/:id/reset-rate-limit`     | 重置限流状态                                  |
| `POST` | `/admin/minimax-accounts/:id/reset-status`         | 重置异常状态                                  |
| `POST` | `/admin/minimax-accounts/:accountId/test`          | 测试 MiniMax 账号连通性                       |

## 新增或扩展的数据字段

| 对象             | 字段                              | 说明                                                |
| ---------------- | --------------------------------- | --------------------------------------------------- |
| API Key          | `rateLimits`                      | 多窗口限制数组，元素含 `window`、`requests`、`cost` |
| API Key          | `accountBindings`                 | 新式平台绑定对象，目前用于 DeepSeek 账号/分组绑定   |
| API Key          | `serviceRates`                    | Key 级服务倍率覆盖，扩展到 Claude/Codex/DeepSeek    |
| API Key          | `externalUid`                     | 外部用户 ID，用于同一用户多个 Key 自动切换          |
| API Key          | `translateReasoning`              | 是否启用思考链翻译                                  |
| API Key          | `tags`                            | 标签筛选、`pack_consent` 切换资源包授权             |
| API Key          | `packMode` / `memberUids`         | 企业版标识与成员列表，支持共享 Key                  |
| Enterprise Index | `enterprise_pack_member:{uid}`    | 成员 uid → 企业 Key 列表的 Redis Set 反向索引       |
| OpenAI Account   | `codexPrimaryUsedPercent`         | Codex 5 小时窗口使用百分比                          |
| OpenAI Account   | `codexSecondaryUsedPercent`       | Codex 周窗口使用百分比                              |
| OpenAI Account   | `codexPrimaryResetAfterSeconds`   | 5 小时窗口 reset 剩余秒数                           |
| OpenAI Account   | `codexSecondaryResetAfterSeconds` | 周窗口 reset 剩余秒数                               |
| OpenAI Account   | `usageLimitAutoStopped`           | 使用量保护自动停止调度标记                          |
| Usage Record     | `sessionId` / `rawSessionId`      | 会话追踪 ID                                         |
| Usage Record     | `userInput`                       | 请求中的用户输入摘要                                |
| Usage Record     | `assistantContent`                | AI 回复/思考内容摘要                                |
| Usage Record     | `processType`                     | `uni_agent_agent_type` 进程类型                     |
| Usage Record     | `projectType`                     | `uni-app` / `uni-app-x` / `other` 项目分类          |
| DeepSeek Account | `apiKey`                          | AES 加密保存的 DeepSeek API Key                     |
| DeepSeek Account | `baseApi`                         | DeepSeek 上游地址，默认 `https://api.deepseek.com`  |
| DeepSeek Account | `rateLimitStatus`                 | 限流状态、重置时间和剩余分钟数                      |
| DeepSeek Account | `modelMapping`                    | 请求模型名 → 平台实际模型名的映射表，支持通配符（2026-05-12 之后新增） |
| Kimi Account     | `apiKey`                          | AES 加密保存的 Kimi API Key（2026-05-12 之后新增）  |
| Kimi Account     | `modelMapping`                    | 请求模型名 → Kimi 实际模型名映射表，支持通配符      |
| GLM Account      | `apiKey`                          | AES 加密保存的 GLM API Key（2026-05-12 之后���增）   |
| GLM Account      | `modelMapping`                    | 请求模型名 → GLM 实际模型名映射表，支持通配符       |
| MiniMax Account  | `apiKey`                          | AES 加密保存的 MiniMax API Key（2026-05-12 之后新增） |
| MiniMax Account  | `modelMapping`                    | 请求模型名 → MiniMax 实际模型名映射表，支持通配符   |

## 新增/变更配置与命令

| 位置                              | 名称                                      | 说明                                    |
| --------------------------------- | ----------------------------------------- | --------------------------------------- |
| `config/config.example.js`        | `partnerApi.secret`                       | Partner API 签名密钥                    |
| `config/config.example.js`        | `partnerApi.defaultClaudeAccountId`       | Partner API 创建 Key 时默认 Claude 账号 |
| `.env.example`                    | `LDAP_BIND_DN_PATTERN`                    | LDAP 直接绑定 DN 模板                   |
| `package.json`                    | `npm run mock:openai-account`             | 运行 OpenAI mock 账号脚本               |
| HTTP 请求头                       | `uni_agent_subscription_type` / `uni_agent_subscription_user_id` | 企业版与个人版切换模式及实际使用者标识  |
| `scripts/manage.sh`               | `start/restart/update --instances N\|max` | PM2 多实例/cluster 管理                 |
| `scripts/manage.sh`               | `--log-output` / `--no-log-output`        | 控制直启时是否写入 `logs/service.log`   |
| `scripts/manage.sh`               | `rotate-log`                              | 无需重启轮转 `service.log`              |
| `scripts/sync-upstream.sh`        | 新脚本                                    | 自动检查和同步 upstream                 |
| `scripts/update-model-pricing.js` | `--mirror --output-dir`                   | 生成价格镜像文件和 hash                 |

## 2026-05-12 之后的增量更新

> 以下内容不属于本文生成当时的 `git diff upstream/main...HEAD` 统计结果，而是对 2026-05-12 之后继续演进的功能补充说明，用于帮助读者快速理解“当前仓库”相对本文快照又发生了哪些变化。

### Kimi / GLM / MiniMax 新渠道接入

- 新增 Kimi（月之暗面）渠道：账户实体、AES 加密 API Key、状态管理和调度器（`src/services/account/kimiAccountService.js`、`src/services/scheduler/unifiedKimiScheduler.js`）；OpenAI-compatible 转发 + Anthropic 协议适配（`src/services/relay/kimiRelayService.js`、`src/routes/kimiRoutes.js`），支持 `/kimi/v1/chat/completions` 与 `/kimi/anthropic/v1/messages`。
- 新增 GLM（智谱 AI）渠道：结构与 Kimi 相同（`glmAccountService.js`、`unifiedGlmScheduler.js`、`glmRelayService.js`、`glmRoutes.js`），支持 `/glm/v1/chat/completions` 与 `/glm/anthropic/v1/messages`；价格采用国内人民币定价÷7 换算 USD，并按请求 context 大小分层计费（小 context 低单价、大 context 高单价）。
- 新增 MiniMax 渠道：结构相同（`minimaxAccountService.js`、`unifiedMinimaxScheduler.js`、`minimaxRelayService.js`、`minimaxRoutes.js`），支持 `/minimax/v1/chat/completions` 与 `/minimax/anthropic/v1/messages`；MiniMax M3 512K 模型按 ≤32K / ≤512K context 窗口大小分两档定价。
- 三平台后台管理 CRUD 同结构：账号列表、创建、更新、删除、toggle-schedulable、toggle、reset-rate-limit、reset-status、连通性测试（`src/routes/admin/kimiAccounts.js`、`glmAccounts.js`、`minimaxAccounts.js`）。
- Partner API 扩展支持三平台：新增 `kimi_account_id`、`glm_account_id`、`minimax_account_id` 绑定字段和 `kimi_rate`、`glm_rate`、`minimax_rate` 倍率字段，语义与 `deepseek_account_id`/`deepseek_rate` 等价（`src/routes/partner.js`）。
- `pricingService.js` 补充 Kimi/GLM/MiniMax 各模型价格抓取与 fallback 定价；GLM/MiniMax 分层计费逻辑集成其中。

### 账户级模型映射

- DeepSeek/Kimi/GLM/MiniMax 四平台账户新增 `modelMapping` 配置字段：以 JSON 对象保存"请求模型名 → 平台实际模型名"映射，支持精确匹配和通配符匹配。
- 转发服务在调度选账户后、构建请求体前查询 `modelMapping`：精确命中优先，其次通配符；命中时将请求体 `model` 字段替换为平台实际模型名；未命中或 mapping 为空时完全透传原始模型名。
- 管理界面账户表单同步增加模型映射编辑入口（`web/admin-spa/src/components/accounts/AccountForm.vue`）。
- 调度器（`unifiedDeepSeekScheduler.js`、`unifiedKimiScheduler.js`、`unifiedGlmScheduler.js`、`unifiedMinimaxScheduler.js`）同步扩展，支持带 modelMapping 字段的账户对象。

### 计费修复

- 三方 DeepSeek 计费兼容：修复上游 usage 不含 `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` 字段时的计费异常，兼容无缓存字段的纯 OpenAI-compatible DeepSeek 响应。
- Claude 4.6 计费修复：修复 4.6 系列模型费用无法计入的问题，以及缓存相关计费 bug。

### 企业版共享 Key / 企业资源包
- 鉴权链路新增企业模式：请求可通过 `uni_agent_subscription_type=enterprise` 与 `uni_agent_subscription_user_id` 进入企业版切换逻辑，只在 `enterprise_pack_member:{uid}` 索引对应的企业 Key 集合中切换。
- Partner API 新增企业版接口：`/partner/enterprise/key/batch-create` 与 `/partner/enterprise/key/members/set`，用于批量创建企业 Key 和全量维护成员列表。
- 切换规则继续细化：个人请求会过滤企业 Key，企业模式不依赖 `pack_consent`，并补充了 `packMode` 返回值和相关提示语优化。
- 在企业版基础上继续扩展企业资源包，用于支持企业侧的套餐/资源包组合场景。

### 日志、追踪与错误处理补充

- 请求追踪继续细化：后续提交补充了 `x-request-id` 透传优先级调整、`user_id` 入 Redis、DeepSeek 请求 `rawSessionId` 修正等改动。
- 日志采集继续增强：补充 `tools` 存储、请求完成后再记录 token 用量、使用账号信息补充，以及更多错误日志采集。
- OpenAI 上游保护继续补强：额外拦截 `server_is_overloaded` 等错误场景，减少将原始上游异常直接暴露给客户端。

### 文档状态说明

- 本文仍然适合作为 2026-05-12 的 fork 差异快照。
- 如需了解当前最新的企业版能力，应结合 `docs/enterprise-pack-design.md`、`docs/partner-api-enterprise.md` 与 2026-05-12 之后的提交记录一起阅读。
- 如需了解 Kimi/GLM/MiniMax 三平台接入、账户级模型映射和分层计费，参见本文"2026-05-12 之后的增量更新"中的对应专节。

## 完整文件差异清单

| 状态 | 文件                                                                    | 新增行 | 删除行 |
| ---- | ----------------------------------------------------------------------- | -----: | -----: |
| 新增 | `.agents/skills/relay-service-manager/SKILL.md`                         |     95 |      0 |
| 新增 | `.agents/skills/relay-service-manager/scripts/frontend.sh`              |    111 |      0 |
| 新增 | `.agents/skills/relay-service-manager/scripts/manage.sh`                |     83 |      0 |
| 新增 | `.agents/skills/sync-upstream/SKILL.md`                                 |     72 |      0 |
| 修改 | `.env.example`                                                          |      3 |      0 |
| 修改 | `.github/workflows/auto-release-pipeline.yml`                           |     99 |    132 |
| 修改 | `.github/workflows/sync-model-pricing.yml`                              |     25 |     16 |
| 修改 | `.gitignore`                                                            |      1 |      0 |
| 新增 | `AGENTS.md`                                                             |    190 |      0 |
| 修改 | `CLAUDE.md`                                                             |      1 |      0 |
| 修改 | `Dockerfile`                                                            |      3 |      0 |
| 修改 | `config/config.example.js`                                              |     14 |      0 |
| 修改 | `config/models.js`                                                      |     18 |      1 |
| 新增 | `docs/ldap/configuration.md`                                            |    147 |      0 |
| 新增 | `docs/multi-key-switching.md`                                           |    454 |      0 |
| 新增 | `docs/multi-platform-api-key-billing-plan.md`                           |    647 |      0 |
| 新增 | `docs/openai-mock-account-testing.md`                                   |     86 |      0 |
| 新增 | `docs/openai-usage-auto-stop.md`                                        |    262 |      0 |
| 新增 | `docs/partner-api.md`                                                   |   1575 |      0 |
| 修改 | `package-lock.json`                                                     |      8 |      0 |
| 修改 | `package.json`                                                          |      2 |      1 |
| 修改 | `scripts/manage.sh`                                                     |    351 |     40 |
| 新增 | `scripts/mock-openai-account.js`                                        |    393 |      0 |
| 新增 | `scripts/sync-upstream.sh`                                              |    291 |      0 |
| 修改 | `scripts/update-model-pricing.js`                                       |    146 |     14 |
| 修改 | `src/app.js`                                                            |     22 |     14 |
| 修改 | `src/handlers/geminiHandlers.js`                                        |     71 |      0 |
| 修改 | `src/middleware/auth.js`                                                |    766 |    219 |
| 新增 | `src/middleware/partnerAuth.js`                                         |    125 |      0 |
| 新增 | `src/middleware/requestId.js`                                           |     12 |      0 |
| 修改 | `src/models/redis.js`                                                   |     65 |      2 |
| 修改 | `src/routes/admin/accountGroups.js`                                     |      7 |      0 |
| 修改 | `src/routes/admin/apiKeys.js`                                           |    455 |     98 |
| 修改 | `src/routes/admin/dashboard.js`                                         |     17 |      0 |
| 新增 | `src/routes/admin/deepseekAccounts.js`                                  |    324 |      0 |
| 修改 | `src/routes/admin/index.js`                                             |      2 |      0 |
| 修改 | `src/routes/admin/openaiAccounts.js`                                    |     76 |      2 |
| 修改 | `src/routes/admin/usageStats.js`                                        |    113 |     27 |
| 修改 | `src/routes/api.js`                                                     |    144 |     27 |
| 修改 | `src/routes/azureOpenaiRoutes.js`                                       |     67 |     11 |
| 新增 | `src/routes/deepseekRoutes.js`                                          |     78 |      0 |
| 修改 | `src/routes/openaiClaudeRoutes.js`                                      |    144 |      2 |
| 修改 | `src/routes/openaiGeminiRoutes.js`                                      |     14 |      0 |
| 修改 | `src/routes/openaiRoutes.js`                                            |    182 |      3 |
| 新增 | `src/routes/partner.js`                                                 |   1766 |      0 |
| 修改 | `src/routes/unified.js`                                                 |     14 |      0 |
| 修改 | `src/routes/userRoutes.js`                                              |     17 |      2 |
| 修改 | `src/services/account/accountBalanceService.js`                         |      6 |      3 |
| 修改 | `src/services/account/claudeConsoleAccountService.js`                   |     10 |     12 |
| 新增 | `src/services/account/deepseekAccountService.js`                        |    426 |      0 |
| 修改 | `src/services/account/openaiAccountService.js`                          |    123 |      0 |
| 修改 | `src/services/accountGroupService.js`                                   |     37 |     12 |
| 修改 | `src/services/anthropicGeminiBridgeService.js`                          |    148 |     14 |
| 修改 | `src/services/apiKeyService.js`                                         |    516 |     29 |
| 修改 | `src/services/balanceProviders/index.js`                                |      1 |      0 |
| 新增 | `src/services/deepseekPlatform.js`                                      |    119 |      0 |
| 修改 | `src/services/ldapService.js`                                           |    141 |     63 |
| 修改 | `src/services/modelService.js`                                          |      5 |      0 |
| 修改 | `src/services/pricingService.js`                                        |    470 |      9 |
| 新增 | `src/services/reasoningTranslationService.js`                           |    186 |      0 |
| 修改 | `src/services/relay/antigravityRelayService.js`                         |     26 |      2 |
| 修改 | `src/services/relay/azureOpenaiRelayService.js`                         |     12 |      3 |
| 修改 | `src/services/relay/ccrRelayService.js`                                 |     26 |      2 |
| 修改 | `src/services/relay/claudeConsoleRelayService.js`                       |     74 |      4 |
| 修改 | `src/services/relay/claudeRelayService.js`                              |     19 |      1 |
| 新增 | `src/services/relay/deepseekRelayService.js`                            |    800 |      0 |
| 修改 | `src/services/relay/droidRelayService.js`                               |     50 |      5 |
| 修改 | `src/services/relay/geminiRelayService.js`                              |     14 |      1 |
| 修改 | `src/services/relay/openaiResponsesRelayService.js`                     |    213 |     24 |
| 修改 | `src/services/requestDetailService.js`                                  |      3 |      0 |
| 修改 | `src/services/scheduler/unifiedClaudeScheduler.js`                      |      9 |      0 |
| 新增 | `src/services/scheduler/unifiedDeepSeekScheduler.js`                    |    259 |      0 |
| 修改 | `src/services/scheduler/unifiedOpenAIScheduler.js`                      |     58 |      1 |
| 修改 | `src/services/serviceRatesService.js`                                   |      8 |      2 |
| 修改 | `src/services/userService.js`                                           |     12 |      1 |
| 修改 | `src/utils/errorSanitizer.js`                                           |      9 |      1 |
| 修改 | `src/utils/logger.js`                                                   |     25 |      2 |
| 修改 | `src/utils/rateLimitHelper.js`                                          |     18 |      6 |
| 新增 | `src/utils/reasoningTranslationTransformer.js`                          |    257 |      0 |
| 新增 | `src/utils/requestContext.js`                                           |     14 |      0 |
| 修改 | `src/utils/requestDetailHelper.js`                                      |      6 |      1 |
| 修改 | `src/utils/upstreamErrorHelper.js`                                      |      2 |      1 |
| 新增 | `src/utils/userInputExtractor.js`                                       |    416 |      0 |
| 修改 | `tests/accountBalanceService.test.js`                                   |      1 |      0 |
| 修改 | `tests/costCalculator.test.js`                                          |     27 |      0 |
| 新增 | `tests/openaiAccountService.usageLimit.test.js`                         |    412 |      0 |
| 修改 | `tests/openaiResponsesPayloadToggles.test.js`                           |     33 |     20 |
| 新增 | `tests/openaiRoutes.usageLimit.test.js`                                 |    150 |      0 |
| 新增 | `tests/partnerApi.simple.test.js`                                       |    636 |      0 |
| 修改 | `tests/pricingService.test.js`                                          |     59 |      0 |
| 新增 | `tests/unifiedOpenAIScheduler.usageLimit.test.js`                       |    193 |      0 |
| 修改 | `web/admin-spa/package-lock.json`                                       |     83 |    794 |
| 修改 | `web/admin-spa/src/components/accounts/AccountForm.vue`                 |    303 |      7 |
| 修改 | `web/admin-spa/src/components/accounts/AccountUsageDetailModal.vue`     |      1 |      0 |
| 修改 | `web/admin-spa/src/components/accounts/GroupManagementModal.vue`        |     33 |     25 |
| 新增 | `web/admin-spa/src/components/accounts/OpenAIUsageProtectionFields.vue` |     86 |      0 |
| 修改 | `web/admin-spa/src/components/apikeys/BatchEditApiKeyModal.vue`         |     53 |      3 |
| 修改 | `web/admin-spa/src/components/apikeys/CreateApiKeyModal.vue`            |    217 |    101 |
| 修改 | `web/admin-spa/src/components/apikeys/EditApiKeyModal.vue`              |    287 |    108 |
| 修改 | `web/admin-spa/src/components/apikeys/LimitProgressBar.vue`             |     15 |      4 |
| 修改 | `web/admin-spa/src/components/apistats/ModelUsageStats.vue`             |      1 |      0 |
| 修改 | `web/admin-spa/src/components/apistats/ServiceCostCards.vue`            |      3 |      1 |
| 修改 | `web/admin-spa/src/components/apistats/StatsOverview.vue`               |      2 |      1 |
| 修改 | `web/admin-spa/src/components/common/AccountSelector.vue`               |     12 |      5 |
| 修改 | `web/admin-spa/src/components/common/UnifiedTestModal.vue`              |      7 |      0 |
| 修改 | `web/admin-spa/src/components/settings/ModelPricingSection.vue`         |     27 |      1 |
| 修改 | `web/admin-spa/src/components/tutorial/ClaudeCodeTutorial.vue`          |    133 |      6 |
| 修改 | `web/admin-spa/src/components/tutorial/CodexTutorial.vue`               |      3 |      6 |
| 修改 | `web/admin-spa/src/components/user/UserApiKeysManager.vue`              |     41 |     35 |
| 修改 | `web/admin-spa/src/components/user/UserUsageStats.vue`                  |    417 |    134 |
| 修改 | `web/admin-spa/src/stores/accounts.js`                                  |     32 |     23 |
| 修改 | `web/admin-spa/src/stores/dashboard.js`                                 |     43 |      5 |
| 修改 | `web/admin-spa/src/utils/http_apis.js`                                  |      8 |      0 |
| 修改 | `web/admin-spa/src/views/AccountsView.vue`                              |     89 |     15 |
| 修改 | `web/admin-spa/src/views/ApiKeysView.vue`                               |    296 |    176 |
| 修改 | `web/admin-spa/src/views/DashboardView.vue`                             |    848 |    184 |
| 修改 | `web/admin-spa/src/views/SettingsView.vue`                              |      8 |      4 |
| 修改 | `web/admin-spa/src/views/UserDashboardView.vue`                         |     56 |     36 |
| 修改 | `web/admin-spa/src/views/UserLoginView.vue`                             |     12 |     15 |
| 修改 | `web/admin-spa/vite.config.js`                                          |      1 |      1 |

## 完整提交清单

### 非 merge 提交（134 个）

```text
79ac410f fix: 修复 OpenAI 账号周限额自动停止调度部分账号不生效的问题
7e75aaf2 feat: Partner API 支持 DeepSeek 账号绑定和倍率配置
fa4b7109 fix: 修复免费赠送资源包切换逻辑
d4950720 fix: 流信息日志增加开关
16eaa3a3 fix: prepare config for pricing sync workflow
364de7f1 feat: 增加流式chunk块日志
6e6ea7e8 fix: 过期或禁用的key也进入切换key逻辑
6876dc85 feat: add deepseek anthropic endpoint
c7c44e03 fix: classify deepseek costs in stats
aa1ee148 fix: move DeepSeek pricing sync to mirror
116929a3 fix: polish deepseek account management
c108353a fix: polish deepseek account UI
c7a9dd51 feat: refresh deepseek pricing from official docs
bda2889b feat: add deepseek platform support
868fc343 docs: refine deepseek platform expansion plan
9c1f670a docs: add multi-platform api key billing plan
67011c6d fix: 修改key被禁用的提示，禁用现在就是到期到自动禁用的
a828c537 fix: 强制开启 Standard Responses Codex adaptation，修复备用 Key 字段缺失
c71dd6a5 fix: 当前过期时间大于当前时自动激活
2e0214d2 feat: 加个错误400的日志
8cfa6ad4 fix: preserve pm2 cluster mode during update
e6ae1df9 fix: stabilize pm2 process lifecycle and logs
8def063b fix: 调整请求参数日志位置
6db0f32b fix: use compatible pm2 cluster start flags
0309a02c feat: support pm2 cluster instances in manage script
346153fa fix: 去除日志中的图片base64内容
465725d1 fix: pass log flags through update restart flow
1d090d3d feat: add log output flag for direct service start
191ef042 fix: req 日志中 input 保留最后50个
804503c3 fix: resolve openai usage auto-stop review issues
9c3be2b9 test: add openai mock account testing tools
fcf14b8a feat: add openai usage auto-stop protection
c934b5cf style: format backend files
4b8339ed chore: add codex agent skills
bac04580 feat: 补充日志sessionId以及所有上游返回信息
58f3203f feat: 新增 rotate-log 子命令，支持日志轮转无需重启服务
6661fd8d fix: 增加配置荐处理是否截取
4879e149 fix: 去除日志截取，保存完整的日志
a753e3e5 fix: redis 单key存储调整为50条
59a0b314 feat: 增加重置窗口限制参数 rest_window
01e340eb feat: 存储所有输入，包括提示词
76d1a9eb fix: 有套餐时不管使用的哪个key优先使用套餐提示（在都限制的情况下）
b3fa15bf fix: 修复openai 时思考不存问题
7b998ca9 fix: 思考链翻译也存储
f7b66518 feat: 增加思考链存储
8773f69c fix: 修复5H/周限一直需要启动
5fe43a0b fix: 方案优化
a34a6e53 fix: 重试问题
1a549388 fix: 打印切换后的keyID
c42412e9 fix: key 超限切换问题
d61be77e fix: 文案优化
b482587f fix: 超限规则返回调整
cea7334a fix: 请求拦截位置使用倍率后的费用
41d9826a fix: 接口使用情况展示
1b7150f0 fix: 窗口不展示计费问题
fe0b7aa3 fix: 修改限制文案
fdbc9c45 fix: 文案调整，套餐300改为360
4662723d fix: 修复 每日费用限制使用倍率后的
8a679643 fix: 窗口限制只修改金额时不重置
3230adee feat: 增加key创建成功后立即启动窗口限制
532bb2d4 feat: 增加api-key平滑切换，当一个key用完后自动切换别一个key
b02bd2ed feat: 修改额度不足的文案
7c34db82 fix: 代码格式化
58361f77 feat: 增加ai回复存储，用户输入不限条数存储，新增key的更新接口
e4850aad feat: 补充codex系列模型思考链路输出为英文时，通过其它模型进行翻译成中文
d573fcc1 fix: ESLint错误
652ba443 fix: ESLint错误
6e21a0ba feat: 日志reqId，补充原始sessionId，接口增加限制窗口参数
63682c68 feat: 修改限流后自动恢复
f891b999 feat: api-key 的窗口限制
30c97748 feat: 增加窗口限制
4ea40922 fix: 不截取长度，最多取5条
b47614f4 feat: 增加日志查询问题
c55251ef fix: openai日志不全问题
750b9ba9 feat: 更新项目类型判断，打印headers信息
ea6f89ee feat: 增加用户输出日志
57f04f94 fix: 用户输入内容只提取前10条
c6859f4b fix: ESLint 变量定义未使用错误
c0ac344e feat: 增加ENABLE_USAGE_DETAIL是否启动扩展信息
13cc44c8 feat: 存储记录增加sessionId/项目类型/用户输入内容
cce82f62 fix(auth): 更新配额不足错误信息
4421bac8 fix: req未定义bug
29a63e79 feat: 增加openai报错，优化已有错误提示
f7823b59 fix(错误处理): 将E016错误消息改为"Prompt is too long"并更新状态码为413
b35c6286 feat(错误处理): 添加上下文超长错误的识别和处理
ffa94802 fix: update-config 接口 permissions 改为合并逻辑，修复 serviceRates 字符串展开问题
7d01dcbc feat: 完善合作伙伴 API Key 配置能力
be7a7119 feat: 扩展合作伙伴 API Key 创建接口的账户绑定能力
0cef5fc8 fix(users): /users接口暂时屏蔽获取内容，现获取太慢数量稍多就打不开
bec9e8e4 fix: 修复部分异常不提示，增加 No available accounts 每日只提醒一次
bf27e0da fix: 错误重复发送，删除无用的stack
71212a27 fix: 调整 rate 参数验证规则，支持整数或最多 1 位小数
a561cb7f feat: 去除api.js中的错误提示
04c45fa1 docs: 增加备注信息
0e8269ff feat: 增加处理后的错误信息提示
fe004c50 fix: 显示出账号id
0ef84fd8 feat: 合作伙伴 API 创建接口支持 claude_account_id 和 rate 参数
3a232e7a fix: 使用webhook发送错误通知
a60a909b feat: 增加im提醒
be123438 refactor: 简化 API Key 服务倍率更新逻辑
5c3a70b1 feat: 在合作伙伴签名校验时输出完整的签名计算过程
5110c932 feat: 在合作伙伴签名校验失败时输出期望和接收到的签名值
3a385f97 fix: 修复 manage.sh 中 Redis 密码参数的引号问题
76cb880a feat: 新增合作伙伴 API 批量更新配置接口
f4b185e8 fix: api-keys-usage-trend 天粒度支持 startDate/endDate 参数
44ad32c6 chore: update admin-spa package-lock.json
bbc32018 feat: Dashboard增加昨日快捷筛选和API Keys标签筛选功能
9d223f4b refactor: 合作伙伴API usage/usage-details接口移除key_id/key_name参数，统一使用key_ids
91af32e3 fix: 修复绑定 Claude 账号不正确的问题。
2a50ad95 refactor: 优化合作伙伴API接口响应格式和代码结构
0e82a12f feat: 优化合作伙伴API接口支持key_id查询
cfb2341e fix: 修复合作伙伴API接口的Redis键名和账户查询逻辑
c87a0403 feat: 新增合作伙伴API接口
2ed662ba feat: 新增合作伙伴用量查询接口
25aaed27 docs(tutorial): 优化 Claude Code 和 Codex 配置教程
9c37d9b6 perf(auth): 放宽登录IP速率限制
2cdea806 feat(usage-stats): 添加缓存 token 统计到用户使用明细
b18527cb docs: 更新项目指导文档
514ebed6 perf(api-key): 优化使用统计查询性能
681c239c refactor(ui): 移除用户使用统计中的季度选项
b53ddb07 fix(vite): 修复开发环境代理连接失败问题
ca7abca9 feat: 增强用户统计日志与界面本地化
59e89296 docs: ldap 访问地址
f9c0c013 fix: resolve undefined apiClient in DashboardView.vue
c3f7b52a feat: 增强 LDAP 认证功能并添加文档
8e2a0f0f feat: 增强仪表板 API Key 统计功能
76f566ed fix: 移除 heapdump 依赖并添加 Docker 编译工具支持
4a648989 feat: 添加同步上游版本的自动化脚本
4c871814 chore: 修改版本号策略，使用 VERSION 文件版本而不自动递增
6bd14e42 fix: 添加 git 用户配置以修复前端构建推送失败 [force release]
9f6d728e fix: 添加 git 用户配置以修复前端构建推送失败
b04cd029 chore: 适配 fork 仓库配置
e6e81736 feat: 缓存 api keys 页面的排序规则。
04b8417d feat: 优化仪表板 API keys 统计报表。
```

### Merge / sync 提交（56 个）

```text
8d1dca88 Merge branch 'main' into lee_pack_free
a77406b4 Merge branch 'main' of https://github.com/mal0130/claude-relay-service
cb1fbefa Merge branch 'codex/multi-platform-billing-plan' into main
00fbd6cc Merge branch 'main' of https://github.com/mal0130/claude-relay-service
d0187db3 Merge branch 'main' into codex/merge-upstream-20260416
53b3b130 Merge branch 'main' into codex/merge-upstream-20260416
8ff604f2 Merge upstream/main into codex/merge-upstream-20260416
e6bb0d0c Merge branch 'main' of https://github.com/mal0130/claude-relay-service
e6971894 Merge branch 'main' of https://github.com/mal0130/claude-relay-service
bc7af89c Merge branch 'main' of github.com:mal0130/claude-relay-service
7b225712 Merge branch 'lee_thinking'
3a23e8d7 Merge remote-tracking branch 'upstream/main'
63ac032b Merge branch 'main' of https://github.com/mal0130/claude-relay-service
b5b8dddd Merge pull request #15 from lyc7751/lee_dev
280c4be2 Merge branch 'main' into lee_dev
8f5d57d0 Merge branch 'main' of https://github.com/mal0130/claude-relay-service
a62125e9 Merge pull request #14 from lyc7751/lee_dev
60660c6b Merge pull request #13 from lyc7751/lee_dev
63aedbe2 Merge pull request #12 from lyc7751/lee_dev
7de2035d Merge pull request #11 from lyc7751/lee_dev
10450719 Merge pull request #10 from lyc7751/lee_dev
850cdf84 Merge pull request #9 from lyc7751/lee_dev
fe23c633 Merge pull request #8 from lyc7751/lee_dev
35def707 chore: 同步上游版本 1.1.295
a2aa7e68 Merge pull request #7 from 912456294/fix/error-code-mapping
b84f4eee Merge pull request #1 from mal0130/main
29498dba Merge pull request #6 from lyc7751/lee_im
2c333656 Merge branch 'main' of https://github.com/lyc7751/claude-relay-service into lee_im
b380ac38 Merge pull request #5 from 912456294/fix/error-code-mapping
aede9da1 chore: merge upstream v1.1.292 - add GPT-5 models, service_tier pricing, fix team account detection
25f5efb8 Merge pull request #4 from lyc7751/lee_im
6b6c46bb Merge pull request #3 from lyc7751/lee_im
90aeb239 Merge pull request #2 from lyc7751/lee_im
2ff55c35 Merge branch 'lee_im' of https://github.com/lyc7751/claude-relay-service into lee_im
1838e2d6 Merge branch 'mal0130:main' into lee_im
e2c8921b Merge branch 'main' of github.com:mal0130/claude-relay-service
4c42d699 chore: 同步上游版本 1.1.290
6cbcb888 Merge pull request #1 from lyc7751/lee_im
967f673f Merge branch 'main' of https://github.com/mal0130/claude-relay-service into lee_im
e0752f8c chore: 同步上游版本 1.1.289
b865f91a chore: 同步上游版本 1.1.287
d3b46a68 chore: 同步上游版本 1.1.286
cd613df7 chore: 同步上游版本 1.1.283
e36f34ca chore: 同步上游版本 1.1.282
f51ef54f chore: 同步上游版本 1.1.274
f11f7fe1 chore: 同步上游版本 1.1.272
a0e7ca1c chore: 同步上游版本 1.1.271
5c67599e chore: 同步上游版本 1.1.268
41fb4a57 Merge remote-tracking branch 'upstream/main'
063c721f chore: 同步上游版本 1.1.266
a3ecf5fd chore: 同步上游版本 1.1.265
3111d20b chore: 同步上游版本 1.1.264
6bca92a0 chore: 同步上游版本 1.1.259
aa6bbbcf chore: 同步上游版本 1.1.258
dccff2ce Merge branch 'main' of https://github.com/mal0130/claude-relay-service
366e381d Merge remote-tracking branch 'upstream/main'
```
