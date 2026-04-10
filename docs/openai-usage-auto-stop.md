# OpenAI 账号使用量自动停止调度功能

## Context

在 OpenAI（Codex）账号上添加三个独立的自动停止调度保护配置，类似 Claude 账号的 `autoStopOnWarning`：

1. **5小时限额 95% 触发**：primary 窗口使用量 ≥ 95% 时停止，等 primary 重置后恢复
2. **周限额 95% 触发**：secondary 窗口使用量 ≥ 95% 时停止，等 secondary 重置后恢复
3. **周限额按日均摊限流（指数递减）**：将周限额按5天+指数递减分配，若当日消耗超出当日上限则停止调度到次日本地时区零点恢复

数据来源：OpenAI Codex API 响应头 `x-codex-primary-used-percent` / `x-codex-secondary-used-percent` 及对应的 `resetAfterSeconds` / `windowMinutes`，已由 `extractCodexUsageHeaders()`（`openaiRoutes.js:57`）提取并通过 `updateCodexUsageSnapshot()`（`openaiAccountService.js:1198`）存入 Redis 的 `codex*` 字段。

时区：统一使用已有的 `redis.getDateInTimezone()` / `redis.getNextResetTime()`（`src/models/redis.js:8,86`），配置来自 `config.system.timezoneOffset`（`config/config.js:135`，默认 UTC+8）。

---

## 已发现问题与修复要求

本功能在评审后确认有 3 个需要一并修复的问题：

1. **限流恢复会绕过使用量停调**
   - 当账号同时存在 `schedulable=false`、`usageLimitAutoStopped=true` 和 `rateLimitStatus=limited` 时，原调度逻辑会先按限流恢复处理，可能直接把账号恢复成可调度，绕过使用量停调判断。
   - 修复要求：`usageLimitAutoStopped` 的恢复判断必须独立于 `rateLimitStatus`，即使账号带有限流标记，也要先检查使用量停调是否仍然生效。

2. **关闭保护开关后不会立即解除已触发的停调**
   - 管理员在后台取消对应保护开关并保存后，原实现只更新开关字段，不清理 `usageLimitAutoStopped` / `usageLimitStopReason` / `usageLimitResumeAt`，导致账号仍然被卡住。
   - 修复要求：当当前停调原因对应的保护开关被关闭时，更新接口要立即清理 usage-limit stop state，并恢复 `schedulable`。

3. **UTC（`timezoneOffset=0`）部署下恢复时间计算错误**
   - 原代码使用 `config.system.timezoneOffset || 8`，会把合法的 `0` 当成 falsy，从而错误回退到 `8`。
   - 修复要求：使用 `?? 8` 或显式 `undefined` 判断，保留 `0`。

---

## 关键文件

| 文件                                                    | 职责                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/services/account/openaiAccountService.js`          | 账户服务，添加检查+停止+恢复逻辑                                           |
| `src/routes/openaiRoutes.js`                            | 每次请求后调用 `updateCodexUsageSnapshot()`，在此后触发检查（约第 448 行） |
| `src/services/scheduler/unifiedOpenAIScheduler.js`      | `_ensureAccountReadyForScheduling()`（第55行），添加自动恢复检查           |
| `src/routes/admin/openaiAccounts.js`                    | 创建/更新 API，接收三个新配置参数                                          |
| `web/admin-spa/src/components/accounts/AccountForm.vue` | 前端表单，`platform==='openai'` 区域添加三个 checkbox                      |

---

## 新增账号字段（Redis 存储）

```
autoStopOnFiveHourLimit     'true'/'false'   启用：5小时限额达到95%停止
autoStopOnWeeklyLimit       'true'/'false'   启用：周限额达到95%停止
autoStopOnDailyOveruse   'true'/'false'   启用：周限额按日均摊超限停止

usageLimitAutoStopped    'true'/'false'   已触发停止标记
usageLimitStoppedAt      ISO string       触发时间
usageLimitStopReason     string           停止原因（中文，见下）
usageLimitResumeAt       ISO string       预计恢复时间（仅 daily_overuse 使用，固定次日时区零点）
```

停止原因文案：

- `'5小时限额使用量接近上限，已自动停止调度'`
- `'周限额使用量接近上限，已自动停止调度'`
- `'周限额当日均摊用量已超限，已自动停止调度'`

---

## 功能 1：5小时限额 95%（autoStopOnFiveHourLimit）

- **触发**：`codexPrimaryUsedPercent >= 95`
- **恢复判断**（调度器实时计算，不存固定时间）：
  ```
  resetAt = new Date(codexUsageUpdatedAt).getTime() + codexPrimaryResetAfterSeconds * 1000
  if Date.now() >= resetAt → 恢复调度，清除停止标记
  ```
  每次调度时从 Redis 读最新的 `codexUsageUpdatedAt` + `codexPrimaryResetAfterSeconds` 重新计算，账号重置后这两个值会随下一次请求更新，自然触发恢复。

---

## 功能 2：周限额 95%（autoStopOnWeeklyLimit）

- **触发**：`codexSecondaryUsedPercent >= 95`
- **恢复判断**（同上，实时计算）：
  ```
  resetAt = new Date(codexUsageUpdatedAt).getTime() + codexSecondaryResetAfterSeconds * 1000
  if Date.now() >= resetAt → 恢复调度，清除停止标记
  ```

---

## 功能 3：周限额按日均摊——指数递减 5 天（autoStopOnDailyOveruse）

### 每日预算上限（累计）

周限额 100% 分5天，按指数递减（公比约0.75）：

| 天次     | 当日预算                    | 累计上限 |
| -------- | --------------------------- | -------- |
| 第1天    | 32%                         | 32%      |
| 第2天    | 24%                         | 56%      |
| 第3天    | 20%                         | 76%      |
| 第4天    | 14%                         | 90%      |
| 第5天    | 10%                         | 100%     |
| 第6、7天 | 0%（不再分配，靠前5天余量） | 100%     |

实现为硬编码常量数组：`const DAILY_BUDGET_CUMULATIVE = [32, 56, 76, 90, 100]`

### 触发条件计算

```
secondaryWindowMinutes  = codexSecondaryWindowMinutes  // 约10080（1周）
elapsedMinutes          = secondaryWindowMinutes - (codexSecondaryResetAfterSeconds / 60)
elapsedDays             = elapsedMinutes / (24 * 60)   // 本周已过多少天（含小数）

dayIndex = Math.min(Math.floor(elapsedDays), 4)        // 0-4，第6/7天 clamp 为4
dailyBudgetMax = DAILY_BUDGET_CUMULATIVE[dayIndex]     // 当前天结束时的累计上限

if (codexSecondaryUsedPercent > dailyBudgetMax) → 触发停止
```

### 恢复时间：次日本地时区零点

使用已有的 `redis.getDateInTimezone()` + `config.system.timezoneOffset`：

```js
const redis = require('../models/redis')
const config = require('../../config/config')
const now = new Date()
const tzNow = redis.getDateInTimezone(now)
// 次日零点（时区本地）
const tzTomorrow = new Date(tzNow)
tzTomorrow.setUTCDate(tzNow.getUTCDate() + 1)
tzTomorrow.setUTCHours(0, 0, 0, 0)
// 转回真实 UTC
const offset = config.system.timezoneOffset ?? 8
const resumeAt = new Date(tzTomorrow.getTime() - offset * 3600000)
```

### 防重复触发

- 若 `usageLimitAutoStopped === 'true'` 已存在，跳过全部检查

---

## 实现步骤

### Step 1：`openaiAccountService.js`

1. **`createAccount()`**：参数解构添加三个新字段（默认 `false`），存入 Redis
2. **新增 `checkAndApplyUsageLimitStop(accountId, accountData)` 函数**：
   - 先判断 `usageLimitAutoStopped === 'true'` → 直接 return
   - 依次检查功能 1、2、3 触发条件（任一满足即执行停止，不叠加）
   - 触发时：更新 `schedulable=false`、`usageLimitAutoStopped=true`、`usageLimitStoppedAt`、`usageLimitStopReason`、`usageLimitResumeAt`
   - 发送 Webhook，复用 `webhookNotifier.sendAccountAnomalyNotification()`，`errorCode` 使用 `'OPENAI_USAGE_LIMIT_WARNING'`
3. **导出** `checkAndApplyUsageLimitStop`

### Step 2：`openaiRoutes.js`

在 `updateCodexUsageSnapshot(accountId, usageSnapshot)` 调用后（约第 448 行），追加：

```js
if (usageSnapshot) {
  const latestAccount = await openaiAccountService.getAccount(accountId)
  if (latestAccount) {
    await openaiAccountService.checkAndApplyUsageLimitStop(accountId, latestAccount)
  }
}
```

### Step 3：`unifiedOpenAIScheduler.js`

在 `_ensureAccountReadyForScheduling()` 中，`usageLimitAutoStopped` 的恢复判断不能再依赖 `hasRateLimitFlag === false`。应调整为：

- 只要 `usageLimitAutoStopped === 'true'`，就先判断 usage-limit 是否可恢复
- 若仍未到恢复时间，直接返回 `usage_limit_stopped`
- 若已达到恢复条件，先清理 usage-limit stop state，再继续后续限流检查
- 即使账号同时还带有旧的限流标记，也不能跳过 usage-limit 判断

可以抽出类似 `getUsageLimitResumeState(account)` 的辅助函数：

```js
const usageLimitState = getUsageLimitResumeState(account)

if (usageLimitState) {
  if (!usageLimitState.canResume) {
    return { canUse: false, reason: 'usage_limit_stopped' }
  }

  await openaiAccountService.updateAccount(accountId, {
    schedulable: 'true',
    usageLimitAutoStopped: 'false',
    usageLimitStoppedAt: '',
    usageLimitStopReason: '',
    usageLimitResumeAt: ''
  })
}
```

注意：5小时和周限额的 `codexPrimaryResetAfterSeconds` / `codexSecondaryResetAfterSeconds` 会随每次请求后的响应头实时刷新，因此恢复判断始终使用 Redis 中最新值，无需在停止时存入固定恢复时间。

### Step 4：`openaiAccounts.js`

参考 `claudeAccounts.js` 第 621、681 行的 `autoStopOnWarning` 处理，在创建/更新接口中接收并传递：

- `autoStopOnFiveHourLimit`
- `autoStopOnWeeklyLimit`
- `autoStopOnDailyOveruse`

另外，更新接口需要补一段“人工解除 usage-limit stop”逻辑：如果当前停调原因对应的保护开关被关闭，则立即清理：

```js
if (
  currentAccount.usageLimitAutoStopped === 'true' &&
  isUsageStopDisabled(currentAccount.usageLimitStopReason, nextUsageProtectionFlags)
) {
  updateData.schedulable = true
  updateData.usageLimitAutoStopped = false
  updateData.usageLimitStoppedAt = ''
  updateData.usageLimitStopReason = ''
  updateData.usageLimitResumeAt = ''
}
```

### Step 5：前端 `AccountForm.vue`

在 `platform === 'openai'` 的条件区域（参考 Claude 的 `autoStopOnWarning` 控件，第 1821 行），添加三个独立 checkbox：

1. **`autoStopOnFiveHourLimit`** — "5小时限额使用量达到 95% 时自动停止调度"
   - 说明：检测到 Codex 5小时限额使用量达到 95% 时自动暂停，等当前时间窗口重置后自动恢复
2. **`autoStopOnWeeklyLimit`** — "周限额使用量达到 95% 时自动停止调度"
   - 说明：检测到周限额使用量达到 95% 时自动暂停，等周限额重置后自动恢复
3. **`autoStopOnDailyOveruse`** — "周限额消耗过快时按日均摊限流（指数递减5天）"
   - 说明：将周限额按5天指数递减分配（第1天32%、第2天24%、第3天20%、第4天14%、第5天10%），当日消耗超出均摊上限时停止调度，次日（服务器时区零点）自动恢复

form 初始化追加：

```js
autoStopOnFiveHourLimit: props.account?.autoStopOnFiveHourLimit || false,
autoStopOnWeeklyLimit: props.account?.autoStopOnWeeklyLimit || false,
autoStopOnDailyOveruse: props.account?.autoStopOnDailyOveruse || false,
```

---

## 格式化

修改文件后运行：

```
npx prettier --write src/services/account/openaiAccountService.js src/routes/openaiRoutes.js src/services/scheduler/unifiedOpenAIScheduler.js src/routes/admin/openaiAccounts.js web/admin-spa/src/components/accounts/AccountForm.vue
```

---

## 验证方案

1. 创建 OpenAI 账号勾选三项 → Redis 中对应字段为 `'true'`
2. 手动写入 `codexPrimaryUsedPercent=96` → 触发请求 → 验证 `schedulable=false`、`usageLimitStopReason='5小时限额使用量接近上限，已自动停止调度'`
3. 同上测 `codexSecondaryUsedPercent=96`
4. 构造 `codexSecondaryUsedPercent=35`、`codexSecondaryWindowMinutes=10080`、`codexSecondaryResetAfterSeconds=8640000`（约第0天初）→ 35% > 32% 触发日均摊停止
5. 将 `usageLimitResumeAt` 设为过去时间 → 发起请求 → 验证自动恢复（`schedulable=true`）
6. `npm run lint` 通过
