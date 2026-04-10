# OpenAI 账号使用量自动停止调度功能

## Context

在 OpenAI（Codex）账号上添加三个独立的自动停止调度保护配置，类似 Claude 账号的 `autoStopOnWarning`：

1. **5小时限额 95% 触发**：primary 窗口使用量 ≥ 95% 时停止，等 primary 重置后恢复
2. **周限额 95% 触发**：secondary 窗口使用量 ≥ 95% 时停止，等 secondary 重置后恢复
3. **周限额按日均摊限流（指数递减）**：将周限额按5天+指数递减分配，若当日消耗超出当日上限则停止调度到次日本地时区零点恢复

数据来源：OpenAI Codex API 响应头 `x-codex-primary-used-percent` / `x-codex-secondary-used-percent` 及对应的 `resetAfterSeconds` / `windowMinutes`，已由 `extractCodexUsageHeaders()`（`openaiRoutes.js:57`）提取并通过 `updateCodexUsageSnapshot()`（`openaiAccountService.js:1198`）存入 Redis 的 `codex*` 字段。

时区：统一使用已有的 `redis.getDateInTimezone()` / `redis.getNextResetTime()`（`src/models/redis.js:8,86`），配置来自 `config.system.timezoneOffset`（`config/config.js:135`，默认 UTC+8）。

---

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/account/openaiAccountService.js` | 账户服务，添加检查+停止+恢复逻辑 |
| `src/routes/openaiRoutes.js` | 每次请求后调用 `updateCodexUsageSnapshot()`，在此后触发检查（约第 448 行） |
| `src/services/scheduler/unifiedOpenAIScheduler.js` | `_ensureAccountReadyForScheduling()`（第55行），添加自动恢复检查 |
| `src/routes/admin/openaiAccounts.js` | 创建/更新 API，接收三个新配置参数 |
| `web/admin-spa/src/components/accounts/AccountForm.vue` | 前端表单，`platform==='openai'` 区域添加三个 checkbox |

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

| 天次 | 当日预算 | 累计上限 |
|------|----------|----------|
| 第1天 | 32% | 32% |
| 第2天 | 24% | 56% |
| 第3天 | 20% | 76% |
| 第4天 | 14% | 90% |
| 第5天 | 10% | 100% |
| 第6、7天 | 0%（不再分配，靠前5天余量） | 100% |

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
const offset = config.system.timezoneOffset || 8
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

在 `_ensureAccountReadyForScheduling()`（第 62-88 行）的 `schedulable=false` 分支中，在现有限流恢复检查后追加：

```js
if (account.usageLimitAutoStopped === 'true') {
  const reason = account.usageLimitStopReason || ''
  const updatedAt = account.codexUsageUpdatedAt
  const now = Date.now()
  let canResume = false

  if (reason.includes('5小时')) {
    // 5小时限额：实时计算重置时间
    const resetAfter = parseFloat(account.codexPrimaryResetAfterSeconds)
    if (updatedAt && !isNaN(resetAfter)) {
      canResume = now >= new Date(updatedAt).getTime() + resetAfter * 1000
    }
  } else if (reason.includes('周限')) {
    // 周限额：实时计算重置时间
    const resetAfter = parseFloat(account.codexSecondaryResetAfterSeconds)
    if (updatedAt && !isNaN(resetAfter)) {
      canResume = now >= new Date(updatedAt).getTime() + resetAfter * 1000
    }
  } else if (reason.includes('日限')) {
    // 日均摊：固定次日时区零点
    const resumeAt = account.usageLimitResumeAt ? new Date(account.usageLimitResumeAt) : null
    canResume = resumeAt && now >= resumeAt.getTime()
  }

  if (canResume) {
    await openaiAccountService.updateAccount(accountId, {
      schedulable: 'true',
      usageLimitAutoStopped: 'false',
      usageLimitStoppedAt: '',
      usageLimitStopReason: '',
      usageLimitResumeAt: ''
    })
    return { canUse: true }
  }
  return { canUse: false, reason: 'usage_limit_stopped' }
}
```

注意：5小时和周限额的 `codexPrimaryResetAfterSeconds` / `codexSecondaryResetAfterSeconds` 会随每次请求后的响应头实时刷新，因此恢复判断始终使用 Redis 中最新值，无需在停止时存入固定恢复时间。

### Step 4：`openaiAccounts.js`

参考 `claudeAccounts.js` 第 621、681 行的 `autoStopOnWarning` 处理，在创建/更新接口中接收并传递：
- `autoStopOnFiveHourLimit`
- `autoStopOnWeeklyLimit`
- `autoStopOnDailyOveruse`

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
