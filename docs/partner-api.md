# 合作伙伴 API 文档

## 概览

Partner API 提供给外部合作方做 API Key 管理和用量查询，统一挂载在 `/partner` 下，全部使用 `POST`，请求体为 `application/json`。

当前主文档覆盖个人版 Key 和企业版 Key 共用的通用接口；企业版专属接口见 [partner-api-enterprise.md](partner-api-enterprise.md)。

## 接口清单

| 接口                                        | 说明                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /partner/api-key/create`              | 创建个人版 API Key                                                            |
| `POST /partner/api-key/usage`               | 查询一个或多个 Key 的用量汇总                                                 |
| `POST /partner/api-key/usage-details`       | 查询近 30 天聚合用量明细                                                      |
| `POST /partner/api-key/detail`              | 查询一个或多个 Key 的详情                                                     |
| `POST /partner/api-key/:keyId/update`       | 更新单个 Key 的配置                                                           |
| `POST /partner/api-key/:keyId/expiration`   | 更新单个 Key 的过期时间，或手动激活 activation Key                            |
| `POST /partner/api-key/update-config`       | 批量更新多个 Key 的倍率，且可统一切换绑定账号                                 |
| `POST /partner/enterprise/key/batch-create` | 企业版批量创建，见 [partner-api-enterprise.md](partner-api-enterprise.md)     |
| `POST /partner/enterprise/key/members/set`  | 企业版成员全量覆盖，见 [partner-api-enterprise.md](partner-api-enterprise.md) |

## 验签机制

### 参与签名的参数

- 必须包含 `sign`
- 只有 `query + body` 参与签名
- URL 路径参数不参与签名
  - 例如 `/partner/api-key/:keyId/update` 和 `/partner/api-key/:keyId/expiration` 中的 `keyId` 不参与签名
- `sign` 自身不参与签名

### 算法

1. 取请求的 `query + body`
2. 移除 `sign`
3. 按 key 字母顺序排序
4. 拼接为 `key=value&key2=value2`
5. 对数组和对象使用 `JSON.stringify()`，不带空格
6. 在拼接字符串末尾追加密钥
7. 计算 `SHA256`
8. 转为大写十六进制

示例：

```text
原始参数:
{
  "key_ids": ["key-1", "key-2"],
  "timestamp": "1710000000"
}

排序后拼接:
key_ids=["key-1","key-2"]&timestamp=1710000000

追加密钥:
key_ids=["key-1","key-2"]&timestamp=1710000000YOUR_SECRET

最终签名:
SHA256(...).toUpperCase()
```

### 配置项

| 配置                                | 说明                                                   |
| ----------------------------------- | ------------------------------------------------------ |
| `PARTNER_API_SECRET`                | Partner API 验签密钥                                   |
| `PARTNER_DEFAULT_CLAUDE_ACCOUNT_ID` | 未传 `claude_account_id` 时创建 Key 的默认 Claude 账号 |

### 认证失败响应

缺少 `sign`：

```json
{
  "code": 401,
  "msg": "Missing authentication parameter: sign",
  "data": null
}
```

签名错误：

```json
{
  "code": 401,
  "msg": "Invalid signature",
  "data": null
}
```

## 公共字段语义

### 账号绑定字段

| 请求字段              | 支持格式                                    | 内部落库语义                                                           |
| --------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `claude_account_id`   | 普通账号 ID、`group:{id}`                   | 普通 ID 写入 `claudeConsoleAccountId`；`group:` 写入 `claudeAccountId` |
| `openai_account_id`   | 普通账号 ID、`group:{id}`、`responses:{id}` | 写入 `openaiAccountId`                                                 |
| `deepseek_account_id` | 普通账号 ID、`group:{id}`                   | 写入 `accountBindings.deepseek = { mode: 'shared', accountId }`        |
| `minimax_account_id`  | 普通账号 ID、`group:{id}`                   | 写入 `accountBindings.minimax = { mode: 'shared', accountId }`         |
| `glm_account_id`      | 普通账号 ID、`group:{id}`                   | 写入 `accountBindings.glm = { mode: 'shared', accountId }`             |
| `kimi_account_id`     | 普通账号 ID、`group:{id}`                   | 写入 `accountBindings.kimi = { mode: 'shared', accountId }`            |

补充说明：

- 创建时如果未传 `claude_account_id`，会回退到 `PARTNER_DEFAULT_CLAUDE_ACCOUNT_ID`
- `detail` 接口会返回 `geminiAccountId`，但当前 Partner 写接口不提供 `gemini` 的创建和更新字段
- 新增平台绑定时，会自动把对应平台加入 `permissions`

### 倍率字段

| 请求字段        | 校验规则                       | `detail` 返回位置       |
| --------------- | ------------------------------ | ----------------------- |
| `claude_rate`   | 正数，最多 1 位小数            | `serviceRates.claude`   |
| `openai_rate`   | 正数，最多 1 位小数            | `serviceRates.codex`    |
| `deepseek_rate` | 正数，最多 1 位小数            | `serviceRates.deepseek` |
| `minimax_rate`  | 正数，最多 1 位小数            | `serviceRates.minimax`  |
| `glm_rate`      | 正数，最多 1 位小数            | `serviceRates.glm`      |
| `kimi_rate`     | 正数，最多 1 位小数            | `serviceRates.kimi`     |
| `rate`          | 兼容旧字段，等价 `claude_rate` | `serviceRates.claude`   |

### 限流字段

`rateLimits` 为数组，每一项格式如下：

| 字段       | 类型    | 说明                                 |
| ---------- | ------- | ------------------------------------ |
| `window`   | integer | 窗口时长，单位分钟，必须为正整数     |
| `requests` | integer | 窗口内请求数限制，可选，必须为正整数 |
| `cost`     | number  | 窗口内费用限制，可选，必须为非负数   |

规则：

- 每条规则至少要提供 `requests` 或 `cost` 其中一个
- `rateLimits: []` 可用于清空限流配置
- `usage` 接口会把当前窗口状态返回为 `windowLimits`

### 过期与附加字段

| 字段             | 说明                                                   |
| ---------------- | ------------------------------------------------------ |
| `totalCostLimit` | 总费用限制，非负数，`0` 表示不限                       |
| `expirationMode` | `fixed` 或 `activation`                                |
| `expiresAt`      | ISO 8601 时间字符串；空字符串可用于清空                |
| `activationDays` | `activation` 模式下的有效时长数值，必须为正整数        |
| `activationUnit` | `activation` 模式下的单位，支持 `hours` 或 `days`      |
| `user_id`        | 外部用户标识，内部写入 `externalUid`，用于多 Key 切换  |
| `pack_consent`   | `true` 时添加 `pack_consent` 标签，`false` 时移除      |
| `reset_window`   | 仅更新接口支持；`1` 重置限流窗口，`2` 或省略表示不重置 |

### 通用校验规则

- `name` 必须是非空字符串，长度不超过 100
- `key_ids`、`keys`、`configs` 单次最多 100 项
- `totalCostLimit`、`dailyCostLimit`、`rateLimits[].cost` 必须是非负数
- 所有倍率字段必须是正数，且最多 1 位小数
- `expirationMode=activation` 时：
  - 必须同时传 `activationDays` 和 `activationUnit`
  - 不能同时传 `expiresAt`
- `usage`、`usage-details`、`detail` 对不存在的 `keyId` 会直接跳过，不报错

## 1. 创建个人版 Key

`POST /partner/api-key/create`

### 请求体

```json
{
  "name": "MyApp",
  "totalCostLimit": 100,
  "claude_account_id": "group:claude-group-id",
  "openai_account_id": "responses:openai-responses-account-id",
  "deepseek_account_id": "group:deepseek-group-id",
  "minimax_account_id": "minimax-account-id",
  "glm_account_id": "glm-account-id",
  "kimi_account_id": "kimi-account-id",
  "claude_rate": 2.1,
  "openai_rate": 1.8,
  "deepseek_rate": 1.2,
  "minimax_rate": 1.3,
  "glm_rate": 1.4,
  "kimi_rate": 1.5,
  "rateLimits": [
    { "window": 300, "cost": 500 },
    { "window": 60, "requests": 120 }
  ],
  "expirationMode": "fixed",
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "user_id": "user_123",
  "pack_consent": true,
  "sign": "ABC123..."
}
```

### 字段说明

| 字段                                                              | 必填 | 说明                     |
| ----------------------------------------------------------------- | ---- | ------------------------ |
| `name`                                                            | 是   | Key 名称                 |
| `totalCostLimit`                                                  | 否   | 总费用限制               |
| `claude_account_id` ~ `kimi_account_id`                           | 否   | 见“账号绑定字段”         |
| `claude_rate` ~ `kimi_rate`、`rate`                               | 否   | 见“倍率字段”             |
| `rateLimits`                                                      | 否   | 见“限流字段”             |
| `expirationMode`、`expiresAt`、`activationDays`、`activationUnit` | 否   | 见“过期与附加字段”       |
| `user_id`                                                         | 否   | 写入 `externalUid`       |
| `pack_consent`                                                    | 否   | 控制 `pack_consent` 标签 |
| `sign`                                                            | 是   | 验签字段                 |

### 创建行为

- 自动写入 `description: "Created by partner API"`
- 自动带上 `uni-agent` 标签
- `pack_consent=true` 时额外带上 `pack_consent`
- 默认 `isActive=true`
- 默认至少包含 `claude` 权限；传其他平台绑定时会自动补充对应权限
- 只在本次响应里返回完整明文 `apiKey`

### 成功响应

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "key-id",
    "keyName": "MyApp",
    "apiKey": "cr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

## 2. 查询用量汇总

`POST /partner/api-key/usage`

### 请求体

```json
{
  "key_ids": ["key-1", "key-2"],
  "sign": "ABC123..."
}
```

### 成功响应

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "key-1": {
      "keyId": "key-1",
      "keyName": "MyApp",
      "totalCost": 12.34,
      "totalCostLimit": 100,
      "windowLimits": [
        {
          "windowMinutes": 300,
          "windowStartTime": 1760000000000,
          "windowEndTime": 1760018000000,
          "remainingSeconds": 3600,
          "requests": null,
          "cost": {
            "current": 123.45,
            "limit": 500,
            "percentage": 24.69
          }
        }
      ]
    }
  }
}
```

### 返回字段说明

| 字段                      | 说明                                                    |
| ------------------------- | ------------------------------------------------------- |
| `totalCost`               | Key 累计费用                                            |
| `totalCostLimit`          | Key 总费用限制                                          |
| `windowLimits`            | 当前生效限流窗口列表                                    |
| `windowLimits[].requests` | 请求数窗口状态；如果该窗口未配置请求数限制，则为 `null` |
| `windowLimits[].cost`     | 费用窗口状态；如果该窗口未配置费用限制，则为 `null`     |

## 3. 查询近 30 天用量明细

`POST /partner/api-key/usage-details`

### 请求体

```json
{
  "key_ids": ["key-1", "key-2"],
  "sign": "ABC123..."
}
```

### 响应特点

- 返回的是所有命中 Key 的聚合视图，不是按 `keyId` 分组的 map
- 固定返回：
  - `keyId: "aggregated"`
  - `keyName: "Aggregated View"`
  - `period: "last_30_days"`

### 成功响应

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "aggregated",
    "keyName": "Aggregated View",
    "period": "last_30_days",
    "totalStats": {
      "requests": 100,
      "inputTokens": 1000,
      "outputTokens": 2000,
      "cacheCreateTokens": 0,
      "cacheReadTokens": 0,
      "totalTokens": 3000,
      "cost": 12.34
    },
    "dailyUsage": [],
    "modelStats": []
  }
}
```

### 数据结构

| 字段                    | 说明                               |
| ----------------------- | ---------------------------------- |
| `totalStats`            | 近 30 天总请求数、总 token、总费用 |
| `dailyUsage[]`          | 按天汇总，日期倒序                 |
| `dailyUsage[].models[]` | 当天按模型拆分                     |
| `modelStats[]`          | 近 30 天按模型汇总                 |

## 4. 查询 Key 详情

`POST /partner/api-key/detail`

### 请求体

```json
{
  "key_ids": ["key-1", "key-2"],
  "sign": "ABC123..."
}
```

### 成功响应

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "key-1": {
      "keyId": "key-1",
      "keyName": "MyApp",
      "description": "Created by partner API",
      "isActive": true,
      "expiresAt": "2026-12-31T23:59:59.000Z",
      "expirationMode": "fixed",
      "isActivated": true,
      "activationDays": 0,
      "activationUnit": "days",
      "activatedAt": "2026-06-01T00:00:00.000Z",
      "createdAt": "2026-06-01T00:00:00.000Z",
      "lastUsedAt": "2026-06-26T12:00:00.000Z",
      "permissions": ["claude", "glm", "kimi"],
      "rateLimits": [],
      "totalCostLimit": 100,
      "dailyCostLimit": 0,
      "serviceRates": {
        "claude": 2.1,
        "glm": 1.4,
        "kimi": 1.5
      },
      "tags": ["uni-agent", "pack_consent"],
      "claudeAccountId": "group:claude-group-id",
      "claudeConsoleAccountId": null,
      "openaiAccountId": "responses:openai-responses-account-id",
      "geminiAccountId": null,
      "accountBindings": {
        "glm": {
          "mode": "shared",
          "accountId": "glm-account-id"
        },
        "kimi": {
          "mode": "shared",
          "accountId": "kimi-account-id"
        }
      },
      "externalUid": "user_123",
      "packMode": "personal",
      "memberUids": []
    }
  }
}
```

### 返回字段说明

| 字段                                         | 说明                                                   |
| -------------------------------------------- | ------------------------------------------------------ |
| `permissions`                                | 当前启用的平台权限列表                                 |
| `rateLimits`                                 | 当前限流规则                                           |
| `dailyCostLimit`                             | 企业版创建接口才支持写入；个人版通常为 `0`             |
| `serviceRates`                               | 已生效的倍率配置；`openai_rate` 对应返回字段是 `codex` |
| `tags`                                       | 当前标签列表                                           |
| `claudeAccountId` / `claudeConsoleAccountId` | Claude 分组绑定和普通绑定二选一                        |
| `accountBindings`                            | DeepSeek、MiniMax、GLM、Kimi 等共享平台绑定            |
| `externalUid`                                | 外部用户标识                                           |
| `packMode`                                   | `personal` 或 `enterprise`                             |
| `memberUids`                                 | 企业版成员列表；个人版通常为空数组                     |

## 5. 更新单个 Key

`POST /partner/api-key/:keyId/update`

`keyId` 在 URL 路径中，不参与签名。

### 请求体

```json
{
  "name": "MyApp-New",
  "glm_account_id": "glm-account-id",
  "glm_rate": 1.7,
  "kimi_rate": 1.8,
  "rateLimits": [{ "window": 60, "requests": 100 }],
  "pack_consent": false,
  "reset_window": 1,
  "sign": "ABC123..."
}
```

### 支持字段

- 支持与创建接口相同的大部分字段：
  - `name`
  - `totalCostLimit`
  - `claude_account_id` ~ `kimi_account_id`
  - `claude_rate` ~ `kimi_rate`
  - `rate`
  - `rateLimits`
  - `expiresAt`
  - `expirationMode`
  - `activationDays`
  - `activationUnit`
  - `user_id`
  - `pack_consent`
  - `reset_window`

### 更新行为

- 只更新本次传入的字段，未传字段保持原值
- 平台倍率会合并到现有 `serviceRates`
- 平台绑定会合并到现有 `accountBindings`
- 若本次传了平台绑定，会自动把对应平台加入 `permissions`
- `rateLimits: []` 可清空限流规则
- `expiresAt: ""` 可清空过期时间
- `user_id: ""` 可清空 `externalUid`
- `pack_consent: false` 会移除 `pack_consent` 标签
- `reset_window=1` 会按当前生效的 `rateLimits` 重置窗口计数
- `reset_window=2` 或不传表示不重置
- 如果本次设置了非空 `expiresAt`，且 Key 之前尚未激活，会自动补 `isActivated=true` 和 `activatedAt`

### 成功响应

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "key-1",
    "keyName": "MyApp-New"
  }
}
```

## 6. 更新过期时间 / 手动激活

`POST /partner/api-key/:keyId/expiration`

`keyId` 在 URL 路径中，不参与签名。

### 方式 A：直接改过期时间

```json
{
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "sign": "ABC123..."
}
```

### 方式 B：手动激活 activation Key

```json
{
  "activateNow": true,
  "sign": "ABC123..."
}
```

### 行为说明

- `activateNow=true` 仅适用于：
  - `expirationMode=activation`
  - `isActivated=false`
- 传非空 `expiresAt` 时：
  - 会更新过期时间
  - 若此前未激活，会自动标记为已激活
- `expiresAt: ""` 可清空过期时间
- 不能同时依赖 `activateNow=true` 和 `expiresAt` 更新；`activateNow=true` 优先走手动激活逻辑

### 成功响应

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "key-1",
    "keyName": "MyApp"
  }
}
```

## 7. 批量更新倍率 / 统一切换绑定

`POST /partner/api-key/update-config`

### 请求体

```json
{
  "claude_account_id": "group:claude-group-id",
  "glm_account_id": "glm-account-id",
  "configs": [
    {
      "key_id": "key-1",
      "claude_rate": 2.1,
      "glm_rate": 1.9
    },
    {
      "key_id": "key-2",
      "rate": 1.8,
      "kimi_rate": 2.0
    }
  ],
  "sign": "ABC123..."
}
```

### 字段说明

| 字段                                            | 必填 | 说明                                            |
| ----------------------------------------------- | ---- | ----------------------------------------------- |
| `configs`                                       | 是   | 要处理的 Key 列表，长度 1-100                   |
| `configs[].key_id`                              | 是   | 目标 Key ID                                     |
| `configs[].claude_rate` ~ `configs[].kimi_rate` | 否   | 本 Key 的倍率更新                               |
| `configs[].rate`                                | 否   | 兼容旧字段，等价本 Key 的 `claude_rate`         |
| `claude_account_id` ~ `kimi_account_id`         | 否   | 顶层账号绑定，若传入则对本次所有 `configs` 生效 |
| `sign`                                          | 是   | 验签字段                                        |

### 行为说明

- `configs[]` 内只负责每个 Key 的倍率
- 账号绑定字段只能放在顶层，且会统一应用到本次所有 `configs`
- 会把新的倍率合并到每个 Key 当前的 `serviceRates`
- 会把新的统一绑定合并到每个 Key 当前的 `accountBindings`
- 如果某个 `key_id` 不存在，不中断整体批量任务，而是记入 `failedDetails`

### 成功响应

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "total": 2,
    "success": 1,
    "failed": 1,
    "failedDetails": [
      {
        "key_id": "missing-key",
        "reason": "API Key not found"
      }
    ]
  }
}
```

## 企业版补充

- 企业版 Key 的批量创建和成员维护见 [partner-api-enterprise.md](partner-api-enterprise.md)
- 企业版 Key 创建成功后，仍然使用本页通用接口查询：
  - `detail`
  - `usage`
  - `usage-details`
  - `:keyId/update`
  - `:keyId/expiration`
- `detail` 返回中可通过 `packMode=enterprise` 判断是否为企业版

## 错误码

同一个业务码在不同接口里可能复用，建议以 HTTP 状态码 + `msg` 一起判断。

| HTTP 状态 | `code` | 典型场景                              |
| --------- | ------ | ------------------------------------- |
| `401`     | `401`  | 缺少 `sign` 或签名错误                |
| `400`     | `1001` | 参数校验失败                          |
| `404`     | `1003` | 企业成员接口里 Key 不存在             |
| `404`     | `1004` | `update` / `expiration` 时 Key 不存在 |
| `400`     | `1004` | 企业成员接口里传入的不是企业版 Key    |
| `500`     | `1003` | 大多数业务接口内部异常                |
| `500`     | `500`  | 验签中间件内部异常                    |
