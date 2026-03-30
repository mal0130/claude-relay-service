# 合作伙伴 API 使用文档

## 概述

本文档介绍如何使用合作伙伴 API 查询 API Key 的用量信息。该接口使用 SHA256 签名验证，确保请求的安全性和完整性。

## 接口信息

### 1. 创建 API Key

- **接口地址**: `POST /partner/api-key/create`
- **认证方式**: SHA256 签名验证
- **Content-Type**: `application/json`
- **功能说明**: 创建新的 API Key，自动绑定到 FoxCode 账户

### 2. 查询 API Key 用量汇总

- **接口地址**: `POST /partner/api-key/usage`
- **认证方式**: SHA256 签名验证
- **Content-Type**: `application/json`
- **功能说明**: 查询 API Key 的总费用和费用限制

### 3. 查询 API Key 用量明细

- **接口地址**: `POST /partner/api-key/usage-details`
- **认证方式**: SHA256 签名验证
- **Content-Type**: `application/json`
- **功能说明**: 查询 API Key 近 30 天的详细用量数据，包含每日用量和按模型维度的统计

### 4. 批量更新 API Key 配置

- **接口地址**: `POST /partner/api-key/update-config`
- **认证方式**: SHA256 签名验证
- **Content-Type**: `application/json`
- **功能说明**: 批量更新 API Key 的配置信息，包括 Claude/OpenAI 服务倍率及绑定账户


### 5. 更新 API Key

- **接口地址**: `POST /partner/api-key/:keyId/update`
- **认证方式**: SHA256 签名验证
- **Content-Type**: `application/json`
- **功能说明**: 更新单个 API Key 的配置，支持与创建时相同的所有参数

### 6. 更新 API Key 过期时间

- **接口地址**: `POST /partner/api-key/:keyId/expiration`
- **认证方式**: SHA256 签名验证
- **Content-Type**: `application/json`
- **功能说明**: 更新单个 API Key 的过期时间，或手动激活 activation 模式的 API Key

## 验签机制

### 签名算法

使用 SHA256 算法对请求进行签名，算法步骤：

1. **参数排序**: 将所有请求参数（query + body）按 key 字母顺序排序
2. **参数拼接**: 按 `key1=value1&key2=value2` 格式拼接
   - 对象/数组类型：使用 `JSON.stringify()` 序列化（无空格）
   - 字符串/数字：直接拼接
3. **追加密钥**: 在拼接字符串末尾追加 API 密钥
4. **计算哈希**: 对整个字符串进行 SHA256 哈希
5. **转大写**: 将哈希结果转为大写

**示例**：

```
参数: { key_name: "MyApp", timestamp: "1707456789" }
排序: key_name, timestamp
拼接: key_name=MyApp&timestamp=1707456789
追加密钥: key_name=MyApp&timestamp=1707456789YOUR_SECRET_KEY
SHA256: abc123...
大写: ABC123...
```

### 必需的请求参数

| 参数         | 说明                        | 示例             |
| ------------ | --------------------------- | ---------------- |
| sign         | SHA256 签名（大写十六进制） | `ABC123...`      |
| 其他业务参数 | 根据接口要求传递            | `key_name=MyApp` |

### 安全规则

1. **签名密钥**: 使用环境变量 `PARTNER_API_SECRET` 配置
2. **参数完整性**: 所有参数都参与签名计算，确保数据完整性
3. **大小写不敏感**: 签名验证时不区分大小写

## 接口详情

### 接口 1: 创建 API Key

#### 请求参数

**请求体**

```json
{
  "name": "MyApp",
  "totalCostLimit": 100.0,
  "claude_account_id": "group:381cb540-f33e-49d1-8fda-80348f8c456f",
  "openai_account_id": "responses:openai-responses-account-uuid",
  "claude_rate": 2.1,
  "openai_rate": 1.8,
  "rateLimits": [
    { "window": 300, "cost": 500 },
    { "window": 3000, "cost": 5000 }
  ],
  "expirationMode": "fixed",
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "user_id": "user_123",
  "pack_consent": true,
  "sign": "ABC123..."
}
```

| 参数              | 类型   | 必填 | 说明                                                                                              |
| ----------------- | ------ | ---- | ------------------------------------------------------------------------------------------------- |
| name              | string | 是   | API Key 的名称                                                                                    |
| totalCostLimit    | number | 否   | 总费用限制（美元）                                                                                |
| claude_account_id | string | 否   | 绑定的 Claude 账户 ID；普通 ID 写入 `claudeConsoleAccountId`，`group:` 格式写入 `claudeAccountId` |
| openai_account_id | string | 否   | 绑定的 OpenAI 账户 ID；支持普通 ID、`group:...`、`responses:...`，内部映射到 `openaiAccountId`    |
| claude_rate       | number | 否   | Claude 服务倍率，内部映射到 `serviceRates.claude`                                                 |
| openai_rate       | number | 否   | OpenAI/Codex 服务倍率，内部映射到 `serviceRates.codex`                                            |
| rate              | number | 否   | 兼容旧参数，等同于 `claude_rate`；若同时提供则 `claude_rate` 优先                                 |
| rateLimits        | array  | 否   | 多窗口速率限制配置；每项至少包含 `window`，并提供 `requests` 或 `cost` 之一                       |
| expirationMode    | string | 否   | 过期模式，支持 `fixed`（固定时间）或 `activation`（首次使用后激活）                               |
| expiresAt         | string | 否   | 固定过期时间，ISO 8601 格式；`expirationMode=fixed` 时可传                                         |
| activationDays    | number | 否   | `activation` 模式下的有效时长数值，必须为正整数                                                   |
| activationUnit    | string | 否   | `activation` 模式下的时间单位，支持 `hours` 或 `days`                                             |
| user_id           | string | 否   | 外部用户ID，用于多Key自动切换，相同 user_id 的 Key 可自动切换                                      |
| pack_consent      | boolean| 否   | 是否同意使用资源包，为 true 时会在标签中添加 pack_consent，允许套餐超限后切换到资源包              |
| sign              | string | 是   | SHA256 签名（大写十六进制）                                                                       |

**rateLimits 字段说明**

| 字段     | 类型   | 必填 | 说明                                   |
| -------- | ------ | ---- | -------------------------------------- |
| window   | number | 是   | 限制窗口，单位：分钟                   |
| requests | number | 否   | 窗口内请求次数限制，正整数             |
| cost     | number | 否   | 窗口内费用限制，单位：美元，非负数字   |

示例说明：

- `rateLimits` 支持配置多条窗口规则，例如 `300` 分钟限制 `500` 美元、`3000` 分钟限制 `5000` 美元
- `expirationMode=fixed` 时可直接传 `expiresAt`
- `expirationMode=activation` 时需传 `activationDays` 与 `activationUnit`，且不能同时传 `expiresAt`
- 所有新增参数在传入时也必须参与签名计算

示例说明：

- `claude_account_id` 示例使用了 `group:` 分组绑定格式；如果传普通账户 ID，则会写入 `claudeConsoleAccountId`
- `openai_account_id` 示例使用了 `responses:` 前缀；实际也支持普通账户 ID 和 `group:...` 前缀
- 可参考的典型格式：
  - `claude_account_id`: `claude-console-account-uuid` / `group:group-uuid`
  - `openai_account_id`: `openai-account-uuid` / `group:group-uuid` / `responses:openai-responses-account-uuid`

#### 响应格式

**成功响应**

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "xxx-xxx-xxx",
    "keyName": "MyApp",
    "apiKey": "cr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

**响应字段说明**

| 字段         | 类型   | 说明                               |
| ------------ | ------ | ---------------------------------- |
| code         | number | 状态码，0表示成功，其他值表示错误  |
| msg          | string | 消息，成功时为"success"            |
| data         | object | 业务数据                           |
| data.keyId   | string | API Key ID                         |
| data.keyName | string | API Key 名称                       |
| data.apiKey  | string | 完整的 API Key（仅创建时返回一次） |

**错误响应**

```json
{
  "code": 1001,
  "msg": "name is required and must be a non-empty string",
  "data": null
}
```

**说明**

- 标签自动设置为 `uni-agent`
- 未传 `claude_account_id` 时，会自动绑定默认 Claude 账户
- `claude_account_id` 为普通 ID 时写入 `claudeConsoleAccountId`；为 `group:` 格式时写入 `claudeAccountId`
- `claudeAccountId` 与 `claudeConsoleAccountId` 只会有一个字段有值
- 传入 `openai_account_id` 时，会额外写入 `openaiAccountId`
- 默认权限包含 `claude`；传入 `openai_account_id` 时，`permissions` 会额外包含 `openai`
- 传入 `claude_rate` / `openai_rate` 时，会分别写入 `serviceRates.claude` / `serviceRates.codex`
- 旧 `rate` 参数仍兼容，但建议迁移到 `claude_rate`
- 所有新增参数在传入时也必须参与签名计算
- API Key 创建后自动激活

---

### 接口 2: 查询 API Key 用量汇总

#### 请求参数

**请求体**

```json
{
  "key_ids": ["xxx-xxx-xxx", "yyy-yyy-yyy"],
  "sign": "ABC123..."
}
```

| 参数    | 类型   | 必填 | 说明                           |
| ------- | ------ | ---- | ------------------------------ |
| key_ids | array  | 是   | API Key ID 列表（最多 100 个） |
| sign    | string | 是   | SHA256 签名（大写十六进制）    |

#### 响应格式

**成功响应**

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "xxx-xxx-xxx": {
      "keyId": "xxx-xxx-xxx",
      "keyName": "MyApp",
      "totalCost": 12.34,
      "totalCostLimit": 100.0,
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
        },
        {
          "windowMinutes": 3000,
          "windowStartTime": 1759900000000,
          "windowEndTime": 1760080000000,
          "remainingSeconds": 86400,
          "requests": null,
          "cost": {
            "current": 987.65,
            "limit": 5000,
            "percentage": 19.75
          }
        }
      ]
    },
    "yyy-yyy-yyy": {
      "keyId": "yyy-yyy-yyy",
      "keyName": "MyApp2",
      "totalCost": 5.67,
      "totalCostLimit": 50.0,
      "windowLimits": []
    }
  }
}
```

### 响应字段说明

| 字段                                          | 类型   | 说明                                           |
| --------------------------------------------- | ------ | ---------------------------------------------- |
| code                                          | number | 状态码，0表示成功，其他值表示错误              |
| msg                                           | string | 消息，成功时为"success"，失败时为错误信息    |
| data                                          | object | 业务数据，key 为 API Key ID                    |
| data[keyId].keyId                             | string | API Key ID                                     |
| data[keyId].keyName                           | string | API Key 名称                                   |
| data[keyId].totalCost                         | number | 总费用（美元）                                 |
| data[keyId].totalCostLimit                    | number | 总费用限制（美元）                             |
| data[keyId].windowLimits                      | array  | 多窗口限制的当前用量信息；未配置时为空数组     |
| data[keyId].windowLimits[].windowMinutes      | number | 限制窗口，单位：分钟                           |
| data[keyId].windowLimits[].windowStartTime    | number | 当前窗口开始时间（毫秒时间戳），无窗口时为 null |
| data[keyId].windowLimits[].windowEndTime      | number | 当前窗口结束时间（毫秒时间戳），无窗口时为 null |
| data[keyId].windowLimits[].remainingSeconds   | number | 当前窗口剩余秒数；窗口未开始时可能为 null      |
| data[keyId].windowLimits[].requests           | object | 请求数限制详情；未配置请求限制时为 null        |
| data[keyId].windowLimits[].requests.current   | number | 当前窗口内已使用请求数                         |
| data[keyId].windowLimits[].requests.limit     | number | 当前窗口请求数总限制                           |
| data[keyId].windowLimits[].requests.percentage| number | 当前窗口请求数已用百分比                       |
| data[keyId].windowLimits[].cost               | object | 费用限制详情；未配置费用限制时为 null          |
| data[keyId].windowLimits[].cost.current       | number | 当前窗口内已使用费用（美元）                   |
| data[keyId].windowLimits[].cost.limit         | number | 当前窗口费用总限制（美元）                     |
| data[keyId].windowLimits[].cost.percentage    | number | 当前窗口费用已用百分比                         |

**说明**

- `windowLimits` 按 API Key 上配置的 `rateLimits` 顺序返回
- 例如配置 `300` 分钟限制 `500` 美元、`3000` 分钟限制 `5000` 美元时，会返回两条窗口记录
- 你可以直接使用 `windowLimits[].cost.percentage` 或 `windowLimits[].requests.percentage` 计算使用进度
- 窗口已过期但 Redis 尚未清理时，接口会按 `0` 已用量返回
- 同时兼容新版 `rateLimits` 多规则和旧版单窗口 `rateLimitWindow/rateLimitCost/rateLimitRequests`

**错误响应**

```json
{
  "code": 1001,
  "msg": "key_ids is required",
  "data": null
}
```

---

### 接口 3: 查询 API Key 用量明细

#### 请求参数

**请求体**

```json
{
  "key_ids": ["xxx-xxx-xxx", "yyy-yyy-yyy"],
  "sign": "ABC123..."
}
```

| 参数    | 类型   | 必填 | 说明                           |
| ------- | ------ | ---- | ------------------------------ |
| key_ids | array  | 是   | API Key ID 列表（最多 100 个） |
| sign    | string | 是   | SHA256 签名（大写十六进制）    |

#### 响应格式

**成功响应**

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "aggregated",
    "keyName": "Aggregated View",
    "period": "last_30_days",
    "totalStats": {
      "requests": 1500,
      "inputTokens": 50000,
      "outputTokens": 30000,
      "cacheCreateTokens": 10000,
      "cacheReadTokens": 5000,
      "totalTokens": 95000,
      "cost": 12.345678
    },
    "dailyUsage": [
      {
        "date": "2026-02-09",
        "requests": 100,
        "inputTokens": 3500,
        "outputTokens": 2000,
        "cacheCreateTokens": 800,
        "cacheReadTokens": 400,
        "totalTokens": 6700,
        "cost": 0.856789,
        "models": [
          {
            "model": "claude-3-5-sonnet-20241022",
            "requests": 60,
            "inputTokens": 2100,
            "outputTokens": 1200,
            "cacheCreateTokens": 500,
            "cacheReadTokens": 250,
            "totalTokens": 4050,
            "cost": 0.534567
          },
          {
            "model": "claude-3-5-haiku-20241022",
            "requests": 40,
            "inputTokens": 1400,
            "outputTokens": 800,
            "cacheCreateTokens": 300,
            "cacheReadTokens": 150,
            "totalTokens": 2650,
            "cost": 0.322222
          }
        ]
      }
    ],
    "modelStats": [
      {
        "model": "claude-3-5-sonnet-20241022",
        "requests": 800,
        "inputTokens": 28000,
        "outputTokens": 16000,
        "cacheCreateTokens": 5000,
        "cacheReadTokens": 2500,
        "totalTokens": 51500,
        "cost": 6.789012
      }
    ]
  }
}
```

**响应字段说明**

| 字段                                         | 类型   | 说明                                      |
| -------------------------------------------- | ------ | ----------------------------------------- |
| code                                         | number | 状态码，0表示成功，其他值表示错误         |
| msg                                          | string | 消息，成功时为"success"，失败时为错误信息 |
| data                                         | object | 业务数据                                  |
| data.keyId                                   | string | API Key ID                                |
| data.keyName                                 | string | API Key 名称                              |
| data.period                                  | string | 统计周期（固定为 "last_30_days"）         |
| data.totalStats                              | object | 总计统计数据                              |
| data.totalStats.requests                     | number | 总请求次数                                |
| data.totalStats.inputTokens                  | number | 总输入 Token 数                           |
| data.totalStats.outputTokens                 | number | 总输出 Token 数                           |
| data.totalStats.cacheCreateTokens            | number | 总缓存创建 Token 数                       |
| data.totalStats.cacheReadTokens              | number | 总缓存读取 Token 数                       |
| data.totalStats.totalTokens                  | number | 总 Token 数（所有类型之和）               |
| data.totalStats.cost                         | number | 总费用（美元）                            |
| data.dailyUsage                              | array  | 每日用量明细数组（按日期倒序）            |
| data.dailyUsage[].date                       | string | 日期（YYYY-MM-DD 格式）                   |
| data.dailyUsage[].requests                   | number | 当日请求次数                              |
| data.dailyUsage[].inputTokens                | number | 当日输入 Token 数                         |
| data.dailyUsage[].outputTokens               | number | 当日输出 Token 数                         |
| data.dailyUsage[].cacheCreateTokens          | number | 当日缓存创建 Token 数                     |
| data.dailyUsage[].cacheReadTokens            | number | 当日缓存读取 Token 数                     |
| data.dailyUsage[].totalTokens                | number | 当日总 Token 数                           |
| data.dailyUsage[].cost                       | number | 当日费用（美元）                          |
| data.dailyUsage[].models                     | array  | 当日各模型的用量明细（按请求数倒序）      |
| data.dailyUsage[].models[].model             | string | 模型名称                                  |
| data.dailyUsage[].models[].requests          | number | 该模型当日请求次数                        |
| data.dailyUsage[].models[].inputTokens       | number | 该模型当日输入 Token 数                   |
| data.dailyUsage[].models[].outputTokens      | number | 该模型当日输出 Token 数                   |
| data.dailyUsage[].models[].cacheCreateTokens | number | 该模型当日缓存创建 Token 数               |
| data.dailyUsage[].models[].cacheReadTokens   | number | 该模型当日缓存读取 Token 数               |
| data.dailyUsage[].models[].totalTokens       | number | 该模型当日总 Token 数                     |
| data.dailyUsage[].models[].cost              | number | 该模型当日费用（美元）                    |
| data.modelStats                              | array  | 按模型维度的统计数组（按请求数倒序）      |
| data.modelStats[].model                      | string | 模型名称                                  |
| data.modelStats[].requests                   | number | 该模型的请求次数                          |
| data.modelStats[].inputTokens                | number | 该模型的输入 Token 数                     |
| data.modelStats[].outputTokens               | number | 该模型的输出 Token 数                     |
| data.modelStats[].cacheCreateTokens          | number | 该模型的缓存创建 Token 数                 |
| data.modelStats[].cacheReadTokens            | number | 该模型的缓存读取 Token 数                 |
| data.modelStats[].totalTokens                | number | 该模型的总 Token 数                       |
| data.modelStats[].cost                       | number | 该模型的费用（美元）                      |

**错误响应**

```json
{
  "code": 1001,
  "msg": "key_ids is required",
  "data": null
}
```

---

### 接口 4: 批量更新 API Key 配置

#### 请求参数

**请求体**

```json
{
  "configs": [
    {
      "key_id": "xxx-xxx-xxx",
      "claude_rate": 2.1,
      "openai_rate": 1.8
    },
    {
      "key_id": "yyy-yyy-yyy",
      "rate": 2.7
    },
    {
      "key_id": "zzz-zzz-zzz",
      "claude_rate": 3.2
    }
  ],
  "claude_account_id": "group:381cb540-f33e-49d1-8fda-80348f8c456f",
  "openai_account_id": "responses:openai-responses-account-uuid",
  "sign": "ABC123..."
}
```

| 参数                  | 类型   | 必填 | 说明                                                                                                    |
| --------------------- | ------ | ---- | ------------------------------------------------------------------------------------------------------- |
| configs               | array  | 是   | 配置数组，每个元素至少包含 `key_id`，可按 key 单独传费率配置                                            |
| configs[].key_id      | string | 是   | API Key ID                                                                                              |
| configs[].claude_rate | number | 否   | Claude 服务倍率，内部映射到 `serviceRates.claude`                                                       |
| configs[].openai_rate | number | 否   | OpenAI/Codex 服务倍率，内部映射到 `serviceRates.codex`                                                  |
| configs[].rate        | number | 否   | 兼容旧参数，等同于 `configs[].claude_rate`；若同时提供则 `configs[].claude_rate` 优先                   |
| claude_account_id     | string | 否   | 所有 key 共用的 Claude 绑定；普通 ID 写入 `claudeConsoleAccountId`，`group:` 格式写入 `claudeAccountId` |
| openai_account_id     | string | 否   | 所有 key 共用的 OpenAI 绑定；支持普通 ID、`group:...`、`responses:...`，写入 `openaiAccountId`          |
| sign                  | string | 是   | SHA256 签名（大写十六进制）                                                                             |

**参数验证规则**

1. `configs`: 必填，必须是数组，长度 1-100
2. `configs[].key_id`: 必填，必须是有效的 API Key ID
3. `configs[].claude_rate` / `configs[].openai_rate`: 可选，提供时必须是正数，且最多 1 位小数
4. `configs[].rate`: 兼容旧参数，语义等同于 `configs[].claude_rate`
5. `claude_account_id`: 可选，普通 ID 会校验 Claude Console 账户；`group:` 格式会校验 Claude 分组
6. `openai_account_id`: 可选，支持普通 ID、`group:...`、`responses:...`，会按对应类型校验

示例说明：

- `claude_account_id` 示例使用了 `group:` 分组绑定格式；如果传普通账户 ID，则会写入 `claudeConsoleAccountId`
- `openai_account_id` 示例使用了 `responses:` 前缀；实际也支持普通账户 ID 和 `group:...` 前缀
- 每个 `configs[]` 元素可独立设置 `claude_rate` / `openai_rate`
- 如果提供 `claude_account_id` 或 `openai_account_id`，会批量更新所有目标 API Key 的绑定字段
- `claudeAccountId` 与 `claudeConsoleAccountId` 只会有一个字段有值
- 所有新增参数在传入时也必须参与签名计算

**兼容说明**

- 旧的 `configs[].rate` 仍可使用，但建议迁移到 `configs[].claude_rate`
- 未提供某个服务的费率时，不会覆盖该服务现有的 `serviceRates` 配置
- 更新 OpenAI 绑定时，会确保权限中包含 `openai`
- 更新 Claude 绑定时，会确保权限中包含 `claude`

**响应格式**

**成功响应**

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "total": 3,
    "success": 2,
    "failed": 1,
    "failedDetails": [
      {
        "key_id": "zzz-zzz-zzz",
        "reason": "API Key not found"
      }
    ]
  }
}
```

**响应字段说明**

| 字段                        | 类型   | 说明                                                 |
| --------------------------- | ------ | ---------------------------------------------------- |
| code                        | number | 状态码，0表示成功（部分成功也返回0），其他值表示错误 |
| msg                         | string | 消息，成功时为"success"                              |
| data                        | object | 业务数据                                             |
| data.total                  | number | 处理的总条数                                         |
| data.success                | number | 成功更新的条数                                       |
| data.failed                 | number | 失败的条数                                           |
| data.failedDetails          | array  | 失败详情列表                                         |
| data.failedDetails[].key_id | string | 失败的 API Key ID                                    |
| data.failedDetails[].reason | string | 失败原因                                             |

**错误响应**

```json
{
  "code": 1001,
  "msg": "configs is required and must be an array",
  "data": null
}
```

```json
{
  "code": 1001,
  "msg": "configs length cannot exceed 100",
  "data": null
}
```

```json
{
  "code": 1001,
  "msg": "configs[0].key_id is required",
  "data": null
}
```

```json
{
  "code": 1001,
  "msg": "Claude account not found or inactive",
  "data": null
}
```

#### 业务逻辑说明

1. **批量验证**: 先验证所有请求参数的格式和取值范围
2. **逐个处理**: 遍历 `configs` 数组，逐个更新 API Key 配置
3. **错误隔离**: 某个 API Key 更新失败不影响其他 API Key 的更新
4. **验证 API Key**: 检查 `key_id` 对应的 API Key 是否存在且未删除
5. **验证绑定账户**:
   - `claude_account_id` 为普通 ID 时验证 Claude Console 账户；为 `group:` 时验证 Claude 分组
   - `openai_account_id` 按普通 ID / `group:` / `responses:` 前缀分别验证
6. **更新配置**:
   - `configs[].claude_rate`（或兼容旧 `configs[].rate`）更新 `serviceRates.claude`
   - `configs[].openai_rate` 更新 `serviceRates.codex`
   - 如果提供 `claude_account_id`，按普通账户或分组格式更新 `claudeConsoleAccountId` / `claudeAccountId`
   - 如果提供 `openai_account_id`，更新 `openaiAccountId`
   - 如果更新了绑定字段，会确保 `permissions` 中包含对应服务
7. **返回结果**: 返回处理总数、成功数、失败数和失败详情（包含 `key_id` 和失败原因）

#### 安全考虑

1. **权限验证**: 通过 SHA256 签名验证请求合法性
2. **参数验证**: 严格验证所有输入参数的格式和取值范围
3. **批量限制**: 单次请求最多更新 100 个 API Key
4. **账户/分组验证**: 确保绑定的账户或分组存在且可用
5. **错误隔离**: 单个更新失败不影响其他更新操作
6. **审计日志**: 记录所有配置更新操作，便于追溯

---

### 接口 5: 更新 API Key

#### 请求参数

**路径参数**

| 参数  | 类型   | 必填 | 说明       |
| ----- | ------ | ---- | ---------- |
| keyId | string | 是   | API Key ID |

**请求体**

```json
{
  "name": "MyApp Updated",
  "totalCostLimit": 200.0,
  "claude_account_id": "group:381cb540-f33e-49d1-8fda-80348f8c456f",
  "openai_account_id": "responses:openai-responses-account-uuid",
  "claude_rate": 2.5,
  "openai_rate": 2.0,
  "rateLimits": [
    { "window": 300, "cost": 600 },
    { "window": 3000, "cost": 6000 }
  ],
  "expirationMode": "fixed",
  "expiresAt": "2027-12-31T23:59:59.000Z",
  "sign": "ABC123..."
}
```

| 参数              | 类型   | 必填 | 说明                                                                                              |
| ----------------- | ------ | ---- | ------------------------------------------------------------------------------------------------- |
| name              | string | 否   | API Key 的名称                                                                                    |
| totalCostLimit    | number | 否   | 总费用限制（美元）                                                                                |
| claude_account_id | string | 否   | 绑定的 Claude 账户 ID；普通 ID 写入 `claudeConsoleAccountId`，`group:` 格式写入 `claudeAccountId` |
| openai_account_id | string | 否   | 绑定的 OpenAI 账户 ID；支持普通 ID、`group:...`、`responses:...`，内部映射到 `openaiAccountId`    |
| claude_rate       | number | 否   | Claude 服务倍率，内部映射到 `serviceRates.claude`                                                 |
| openai_rate       | number | 否   | OpenAI/Codex 服务倍率，内部映射到 `serviceRates.codex`                                            |
| rate              | number | 否   | 兼容旧参数，等同于 `claude_rate`；若同时提供则 `claude_rate` 优先                                 |
| rateLimits        | array  | 否   | 多窗口速率限制配置；每项至少包含 `window`，并提供 `requests` 或 `cost` 之一                       |
| expirationMode    | string | 否   | 过期模式，支持 `fixed`（固定时间）或 `activation`（首次使用后激活）                               |
| expiresAt         | string | 否   | 固定过期时间，ISO 8601 格式；`expirationMode=fixed` 时可传                                         |
| activationDays    | number | 否   | `activation` 模式下的有效时长数值，必须为正整数                                                   |
| activationUnit    | string | 否   | `activation` 模式下的时间单位，支持 `hours` 或 `days`                                             |
| sign              | string | 是   | SHA256 签名（大写十六进制）                                                                       |

#### 响应格式

**成功响应**

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "xxx-xxx-xxx",
    "keyName": "MyApp Updated"
  }
}
```

**错误响应**

```json
{
  "code": 1004,
  "msg": "API Key not found",
  "data": null
}
```

**说明**

- 所有参数均为可选，仅更新提供的字段
- 参数验证规则与创建接口一致
- 更新账户绑定时会自动更新权限列表

---

### 接口 6: 更新 API Key 过期时间

#### 请求参数

**路径参数**

| 参数  | 类型   | 必填 | 说明       |
| ----- | ------ | ---- | ---------- |
| keyId | string | 是   | API Key ID |

**请求体**

设置固定过期时间：

```json
{
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "sign": "ABC123..."
}
```

手动激活 activation 模式的 key：

```json
{
  "activateNow": true,
  "sign": "ABC123..."
}
```

清空过期时间（永不过期）：

```json
{
  "expiresAt": "",
  "sign": "ABC123..."
}
```

| 参数        | 类型    | 必填 | 说明                                                     |
| ----------- | ------- | ---- | -------------------------------------------------------- |
| expiresAt   | string  | 否   | 目标过期时间，ISO 8601 格式；传空字符串表示清空过期时间  |
| activateNow | boolean | 否   | 传 `true` 时手动激活 activation 模式且尚未激活的 API Key |
| sign        | string  | 是   | SHA256 签名（大写十六进制）                              |

**参数验证规则**

1. `keyId`: 必填，必须是有效的 API Key ID
2. `expiresAt`: 可选，提供时必须是合法日期字符串；传空字符串表示清空过期时间
3. `activateNow`: 可选，仅支持 `true`；且目标 key 必须是 `activation` 模式且尚未激活
4. `activateNow` 为 `true` 时，不处理 `expiresAt`

#### 响应格式

**成功响应**

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "xxx-xxx-xxx",
    "keyName": "MyApp"
  }
}
```

**响应字段说明**

| 字段         | 类型   | 说明                              |
| ------------ | ------ | --------------------------------- |
| code         | number | 状态码，0表示成功，其他值表示错误 |
| msg          | string | 消息，成功时为"success"          |
| data         | object | 业务数据                          |
| data.keyId   | string | API Key ID                        |
| data.keyName | string | API Key 名称                      |

**错误响应**

```json
{
  "code": 1004,
  "msg": "API Key not found",
  "data": null
}
```

```json
{
  "code": 1001,
  "msg": "invalid expiration date format",
  "data": null
}
```

```json
{
  "code": 1001,
  "msg": "Key is either already activated or not in activation mode",
  "data": null
}
```

#### 业务逻辑说明

1. **定位 Key**: 根据路径参数 `keyId` 查询目标 API Key
2. **手动激活**: 当 `activateNow=true` 时，仅 activation 模式且未激活的 key 可执行激活
3. **设置过期时间**: 传 `expiresAt` 时写入新的过期时间，并在未激活时自动补充激活状态
4. **清空过期时间**: 传空字符串时清空 `expiresAt`，表示永不过期
5. **返回结果**: 成功时返回与创建接口一致的 `keyId`、`keyName`

#### 安全考虑

1. **权限验证**: 通过 SHA256 签名验证请求合法性
2. **参数验证**: 严格校验 `keyId`、`expiresAt` 和 `activateNow`
3. **状态约束**: 手动激活仅允许对 activation 模式且未激活的 key 生效
4. **审计日志**: 记录 partner 侧对 API Key 过期时间的修改操作

---

## 使用示例

### Node.js 示例

#### 示例 1: 查询用量汇总

```javascript
const crypto = require('crypto')
const axios = require('axios')

// 配置
const API_URL = 'http://localhost:3000/partner/api-key/usage'
const SECRET_KEY = 'your-secret-key' // 与服务端 PARTNER_API_SECRET 一致

// 生成签名（PHP 风格算法）
function generateSignature(params, secretKey) {
  // 1. 按 key 排序
  const sortedKeys = Object.keys(params).sort()

  // 2. 拼接参数
  let signStr = ''
  for (const key of sortedKeys) {
    const value = params[key]

    // 对象或数组使用 JSON.stringify
    if (typeof value === 'object' && value !== null) {
      signStr += `${key}=${JSON.stringify(value)}`
    } else {
      signStr += `${key}=${value}`
    }
    signStr += '&'
  }

  // 3. 移除末尾的 &
  signStr = signStr.slice(0, -1)

  // 4. 追加密钥
  signStr += secretKey

  // 5. SHA256 哈希并转大写
  return crypto.createHash('sha256').update(signStr).digest('hex').toUpperCase()
}

// 查询用量
async function queryUsage(keyIds) {
  const params = { key_ids: keyIds }
  const signature = generateSignature(params, SECRET_KEY)

  // 将签名添加到参数中
  params.sign = signature

  try {
    const response = await axios.post(API_URL, params, {
      headers: {
        'Content-Type': 'application/json'
      }
    })

    console.log('查询成功:', response.data)
    return response.data
  } catch (error) {
    console.error('查询失败:', error.response?.data || error.message)
    throw error
  }
}

// 使用示例
queryUsage(['key-id-1', 'key-id-2'])
  .then((data) => {
    // data.data 是 key-value 形式，key 为 keyId
    for (const [keyId, info] of Object.entries(data.data)) {
      console.log(`${keyId}: 总费用=${info.totalCost}, 限制=${info.totalCostLimit}`)
    }
  })
  .catch((err) => console.error(err))
```

#### 示例 2: 查询用量明细

```javascript
const crypto = require('crypto')
const axios = require('axios')

// 配置
const API_URL = 'http://localhost:3000/partner/api-key/usage-details'
const SECRET_KEY = 'your-secret-key' // 与服务端 PARTNER_API_SECRET 一致

// 生成签名（与示例1相同）
function generateSignature(params, secretKey) {
  const sortedKeys = Object.keys(params).sort()
  let signStr = ''
  for (const key of sortedKeys) {
    const value = params[key]
    if (typeof value === 'object' && value !== null) {
      signStr += `${key}=${JSON.stringify(value)}`
    } else {
      signStr += `${key}=${value}`
    }
    signStr += '&'
  }
  signStr = signStr.slice(0, -1)
  signStr += secretKey
  return crypto.createHash('sha256').update(signStr).digest('hex').toUpperCase()
}

// 查询用量明细
async function queryUsageDetails(keyIds) {
  const params = { key_ids: keyIds }
  const signature = generateSignature(params, SECRET_KEY)
  params.sign = signature

  try {
    const response = await axios.post(API_URL, params, {
      headers: {
        'Content-Type': 'application/json'
      }
    })

    console.log('查询成功:', response.data)
    return response.data
  } catch (error) {
    console.error('查询失败:', error.response?.data || error.message)
    throw error
  }
}

// 使用示例
queryUsageDetails(['key-id-1', 'key-id-2'])
  .then((data) => {
    const { totalStats, dailyUsage, modelStats } = data.data

    console.log('=== 总计统计 ===')
    console.log('总请求数:', totalStats.requests)
    console.log('总Token数:', totalStats.totalTokens)
    console.log('总费用:', `$${totalStats.cost}`)

    console.log('\n=== 每日用量（最近5天）===')
    dailyUsage.slice(0, 5).forEach((day) => {
      console.log(`${day.date}: ${day.requests}次请求, ${day.totalTokens} tokens, $${day.cost}`)
    })

    console.log('\n=== 模型统计（Top 3）===')
    modelStats.slice(0, 3).forEach((model) => {
      console.log(`${model.model}: ${model.requests}次请求, $${model.cost}`)
    })
  })
  .catch((err) => console.error(err))
```

### Python 示例

#### 示例 1: 查询用量汇总

```javascript
const crypto = require('crypto')
const axios = require('axios')

// 配置
const API_URL = 'http://localhost:3000/partner/api-key/usage'
const SECRET_KEY = 'your-secret-key' // 与服务端 PARTNER_API_SECRET 一致

// 生成签名（PHP 风格算法）
function generateSignature(params, secretKey) {
  // 1. 按 key 排序
  const sortedKeys = Object.keys(params).sort()

  // 2. 拼接参数
  let signStr = ''
  for (const key of sortedKeys) {
    const value = params[key]

    // 对象或数组使用 JSON.stringify
    if (typeof value === 'object' && value !== null) {
      signStr += `${key}=${JSON.stringify(value)}`
    } else {
      signStr += `${key}=${value}`
    }
    signStr += '&'
  }

  // 3. 移除末尾的 &
  signStr = signStr.slice(0, -1)

  // 4. 追加密钥
  signStr += secretKey

  // 5. SHA256 哈希并转大写
  return crypto.createHash('sha256').update(signStr).digest('hex').toUpperCase()
}

// 查询用量
async function queryUsage(keyIds) {
  const params = { key_ids: keyIds }
  const signature = generateSignature(params, SECRET_KEY)

  // 将签名添加到参数中
  params.sign = signature

  try {
    const response = await axios.post(API_URL, params, {
      headers: {
        'Content-Type': 'application/json'
      }
    })

    console.log('查询成功:', response.data)
    return response.data
  } catch (error) {
    console.error('查询失败:', error.response?.data || error.message)
    throw error
  }
}

// 使用示例
queryUsage(['key-id-1', 'key-id-2'])
  .then((data) => {
    // data.data 是 key-value 形式，key 为 keyId
    for (const [keyId, info] of Object.entries(data.data)) {
      console.log(`${keyId}: 总费用=${info.totalCost}, 限制=${info.totalCostLimit}`)
    }
  })
  .catch((err) => console.error(err))
```

#### 示例 2: 查询用量明细

```javascript
const crypto = require('crypto')
const axios = require('axios')

// 配置
const API_URL = 'http://localhost:3000/partner/api-key/usage-details'
const SECRET_KEY = 'your-secret-key' // 与服务端 PARTNER_API_SECRET 一致

// 生成签名（与示例1相同）
function generateSignature(params, secretKey) {
  const sortedKeys = Object.keys(params).sort()
  let signStr = ''
  for (const key of sortedKeys) {
    const value = params[key]
    if (typeof value === 'object' && value !== null) {
      signStr += `${key}=${JSON.stringify(value)}`
    } else {
      signStr += `${key}=${value}`
    }
    signStr += '&'
  }
  signStr = signStr.slice(0, -1)
  signStr += secretKey
  return crypto.createHash('sha256').update(signStr).digest('hex').toUpperCase()
}

// 查询用量明细
async function queryUsageDetails(keyIds) {
  const params = { key_ids: keyIds }
  const signature = generateSignature(params, SECRET_KEY)
  params.sign = signature

  try {
    const response = await axios.post(API_URL, params, {
      headers: {
        'Content-Type': 'application/json'
      }
    })

    console.log('查询成功:', response.data)
    return response.data
  } catch (error) {
    console.error('查询失败:', error.response?.data || error.message)
    throw error
  }
}

// 使用示例
queryUsageDetails(['key-id-1', 'key-id-2'])
  .then((data) => {
    const { totalStats, dailyUsage, modelStats } = data.data

    console.log('=== 总计统计 ===')
    console.log('总请求数:', totalStats.requests)
    console.log('总Token数:', totalStats.totalTokens)
    console.log('总费用:', `$${totalStats.cost}`)

    console.log('\n=== 每日用量（最近5天）===')
    dailyUsage.slice(0, 5).forEach((day) => {
      console.log(`${day.date}: ${day.requests}次请求, ${day.totalTokens} tokens, $${day.cost}`)
    })

    console.log('\n=== 模型统计（Top 3）===')
    modelStats.slice(0, 3).forEach((model) => {
      console.log(`${model.model}: ${model.requests}次请求, $${model.cost}`)
    })
  })
  .catch((err) => console.error(err))
```

### Python 示例

#### 示例 1: 查询用量汇总

```python
import hashlib
import json
import requests

# 配置
API_URL = 'http://localhost:3000/partner/api-key/usage'
SECRET_KEY = 'your-secret-key'  # 与服务端 PARTNER_API_SECRET 一致

def generate_signature(params, secret_key):
    """生成签名（PHP 风格算法）"""
    # 1. 按 key 排序
    sorted_keys = sorted(params.keys())

    # 2. 拼接参数
    sign_str = ''
    for key in sorted_keys:
        value = params[key]

        # 对象或数组使用 JSON.stringify
        if isinstance(value, (dict, list)):
            sign_str += f"{key}={json.dumps(value, separators=(',', ':'))}"
        else:
            sign_str += f"{key}={value}"
        sign_str += '&'

    # 3. 移除末尾的 &
    sign_str = sign_str.rstrip('&')

    # 4. 追加密钥
    sign_str += secret_key

    # 5. SHA256 哈希并转大写
    return hashlib.sha256(sign_str.encode('utf-8')).hexdigest().upper()

def query_usage(key_ids):
    """查询 API Key 用量"""
    params = {'key_ids': key_ids}
    signature = generate_signature(params, SECRET_KEY)

    # 将签名添加到参数中
    params['sign'] = signature

    headers = {
        'Content-Type': 'application/json'
    }

    try:
        response = requests.post(API_URL, json=params, headers=headers)
        response.raise_for_status()

        data = response.json()
        print('查询成功:', json.dumps(data, indent=2, ensure_ascii=False))
        return data
    except requests.exceptions.RequestException as e:
        print('查询失败:', e)
        if hasattr(e.response, 'text'):
            print('错误详情:', e.response.text)
        raise

# 使用示例
if __name__ == '__main__':
    result = query_usage(['key-id-1', 'key-id-2'])
    for key_id, info in result['data'].items():
        print(f"{key_id}: 总费用=${info['totalCost']}, 限制=${info['totalCostLimit']}")
```

#### 示例 2: 查询用量明细

```python
import hashlib
import json
import requests

# 配置
API_URL = 'http://localhost:3000/partner/api-key/usage-details'
SECRET_KEY = 'your-secret-key'  # 与服务端 PARTNER_API_SECRET 一致

def generate_signature(params, secret_key):
    """生成签名（与示例1相同）"""
    sorted_keys = sorted(params.keys())
    sign_str = ''
    for key in sorted_keys:
        value = params[key]
        if isinstance(value, (dict, list)):
            sign_str += f"{key}={json.dumps(value, separators=(',', ':'))}"
        else:
            sign_str += f"{key}={value}"
        sign_str += '&'
    sign_str = sign_str.rstrip('&')
    sign_str += secret_key
    return hashlib.sha256(sign_str.encode('utf-8')).hexdigest().upper()

def query_usage_details(key_ids):
    """查询 API Key 用量明细"""
    params = {'key_ids': key_ids}
    signature = generate_signature(params, SECRET_KEY)
    params['sign'] = signature

    headers = {'Content-Type': 'application/json'}

    try:
        response = requests.post(API_URL, json=params, headers=headers)
        response.raise_for_status()
        data = response.json()
        print('查询成功:', json.dumps(data, indent=2, ensure_ascii=False))
        return data
    except requests.exceptions.RequestException as e:
        print('查询失败:', e)
        if hasattr(e.response, 'text'):
            print('错误详情:', e.response.text)
        raise

# 使用示例
if __name__ == '__main__':
    result = query_usage_details(['key-id-1', 'key-id-2'])
    total_stats = result['data']['totalStats']
    daily_usage = result['data']['dailyUsage']
    model_stats = result['data']['modelStats']

    print('\n=== 总计统计 ===')
    print(f"总请求数: {total_stats['requests']}")
    print(f"总Token数: {total_stats['totalTokens']}")
    print(f"总费用: ${total_stats['cost']}")

    print('\n=== 每日用量（最近5天）===')
    for day in daily_usage[:5]:
        print(f"{day['date']}: {day['requests']}次请求, {day['totalTokens']} tokens, ${day['cost']}")

    print('\n=== 模型统计（Top 3）===')
    for model in model_stats[:3]:
        print(f"{model['model']}: {model['requests']}次请求, ${model['cost']}")
```

### PHP 示例

#### 示例 1: 查询用量汇总

```php
<?php

// 配置
define('API_URL', 'http://localhost:3000/partner/api-key/usage');
define('SECRET_KEY', 'your-secret-key'); // 与服务端 PARTNER_API_SECRET 一致

/**
 * 生成签名（与服务端算法一致）
 */
function generateSignature($params, $secretKey) {
    // 1. 移除 sign 参数（如果存在）
    if (isset($params['sign'])) {
        unset($params['sign']);
    }

    // 2. 按 key 排序
    ksort($params);

    // 3. 拼接参数
    $signStr = '';
    foreach ($params as $key => $value) {
        if (is_array($value) || is_object($value)) {
            $signStr .= $key . '=' . json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        } else {
            $signStr .= $key . '=' . $value;
        }
        $signStr .= '&';
    }

    // 4. 移除末尾的 &
    $signStr = rtrim($signStr, '&');

    // 5. 追加密钥
    $signStr .= $secretKey;

    // 6. SHA256 哈希并转大写
    return strtoupper(hash('sha256', $signStr));
}

/**
 * 查询 API Key 用量
 */
function queryUsage($keyIds) {
    $params = ['key_ids' => $keyIds];
    $signature = generateSignature($params, SECRET_KEY);

    // 将签名添加到参数中
    $params['sign'] = $signature;

    $ch = curl_init(API_URL);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($params));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json'
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 200) {
        throw new Exception("查询失败: HTTP $httpCode - $response");
    }

    return json_decode($response, true);
}

// 使用示例
try {
    $result = queryUsage(['key-id-1', 'key-id-2']);
    echo "查询成功:\n";
    foreach ($result['data'] as $keyId => $info) {
        echo "$keyId: 总费用=\$" . $info['totalCost'] . ", 限制=\$" . $info['totalCostLimit'] . "\n";
    }
} catch (Exception $e) {
    echo "错误: " . $e->getMessage() . "\n";
}
```

#### 示例 2: 查询用量明细

```php
<?php

// 配置
define('API_URL', 'http://localhost:3000/partner/api-key/usage-details');
define('SECRET_KEY', 'your-secret-key'); // 与服务端 PARTNER_API_SECRET 一致

// 生成签名（与示例1相同）
function generateSignature($params, $secretKey) {
    if (isset($params['sign'])) {
        unset($params['sign']);
    }
    ksort($params);
    $signStr = '';
    foreach ($params as $key => $value) {
        if (is_array($value) || is_object($value)) {
            $signStr .= $key . '=' . json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        } else {
            $signStr .= $key . '=' . $value;
        }
        $signStr .= '&';
    }
    $signStr = rtrim($signStr, '&');
    $signStr .= $secretKey;
    return strtoupper(hash('sha256', $signStr));
}

// 查询用量明细
function queryUsageDetails($keyIds) {
    $params = ['key_ids' => $keyIds];
    $signature = generateSignature($params, SECRET_KEY);
    $params['sign'] = $signature;

    $ch = curl_init(API_URL);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($params));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 200) {
        throw new Exception("查询失败: HTTP $httpCode - $response");
    }

    return json_decode($response, true);
}

// 使用示例
try {
    $result = queryUsageDetails(['key-id-1', 'key-id-2']);
    $totalStats = $result['data']['totalStats'];
    $dailyUsage = $result['data']['dailyUsage'];
    $modelStats = $result['data']['modelStats'];

    echo "=== 总计统计 ===\n";
    echo "总请求数: " . $totalStats['requests'] . "\n";
    echo "总Token数: " . $totalStats['totalTokens'] . "\n";
    echo "总费用: $" . $totalStats['cost'] . "\n\n";

    echo "=== 每日用量（最近5天）===\n";
    foreach (array_slice($dailyUsage, 0, 5) as $day) {
        echo "{$day['date']}: {$day['requests']}次请求, {$day['totalTokens']} tokens, \${$day['cost']}\n";
    }

    echo "\n=== 模型统计（Top 3）===\n";
    foreach (array_slice($modelStats, 0, 3) as $model) {
        echo "{$model['model']}: {$model['requests']}次请求, \${$model['cost']}\n";
    }
} catch (Exception $e) {
    echo "错误: " . $e->getMessage() . "\n";
}
```

### cURL 示例

#### 示例 1: 查询用量汇总

```bash
#!/bin/bash

API_URL="http://localhost:3000/partner/api-key/usage"
SECRET_KEY="your-secret-key"
KEY_IDS='["key-id-1","key-id-2"]'

# 构建参数（按 key 排序）
SIGN_STR="key_ids=${KEY_IDS}"

# 追加密钥
SIGN_STR="${SIGN_STR}${SECRET_KEY}"

# 生成签名（SHA256 并转大写）
SIGNATURE=$(echo -n "$SIGN_STR" | openssl dgst -sha256 | awk '{print toupper($2)}')

# 构建请求体（包含签名）
BODY="{\"key_ids\":$KEY_IDS,\"sign\":\"$SIGNATURE\"}"

# 发送请求
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

#### 示例 2: 查询用量明细

```bash
#!/bin/bash

API_URL="http://localhost:3000/partner/api-key/usage-details"
SECRET_KEY="your-secret-key"
KEY_IDS='["key-id-1","key-id-2"]'

# 构建参数（按 key 排序）
SIGN_STR="key_ids=${KEY_IDS}"

# 追加密钥
SIGN_STR="${SIGN_STR}${SECRET_KEY}"

# 生成签名（SHA256 并转大写）
SIGNATURE=$(echo -n "$SIGN_STR" | openssl dgst -sha256 | awk '{print toupper($2)}')

# 构建请求体（包含签名）
BODY="{\"key_ids\":$KEY_IDS,\"sign\":\"$SIGNATURE\"}"

# 发送请求并格式化输出
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$BODY" | jq '.'
```

## 配置说明

### 环境变量

在 `.env` 文件中添加：

```bash
# 合作伙伴 API 验签密钥（可选，默认使用 JWT_SECRET）
PARTNER_API_SECRET=your-secret-key-here
```

### 配置文件

在 `config/config.js` 中已自动配置：

```javascript
partnerApi: {
  secret: process.env.PARTNER_API_SECRET || process.env.JWT_SECRET
}
```

## 错误码说明

| code | HTTP 状态码 | 说明                                     |
| ---- | ----------- | ---------------------------------------- |
| 0    | 200         | 成功                                     |
| 1001 | 400         | 缺少必需参数 key_ids                     |
| 1002 | 404         | 未找到指定的 API Key                     |
| 1003 | 500         | 服务器内部错误                           |
| 401  | 401         | 签名验证失败（缺少 sign 参数或签名错误） |

## 安全建议

1. **密钥管理**: 妥善保管 `PARTNER_API_SECRET`，不要提交到版本控制系统
2. **HTTPS**: 生产环境必须使用 HTTPS 协议
3. **参数完整性**: 确保所有参数都参与签名计算
4. **错误处理**: 妥善处理各种错误情况，避免泄露敏感信息

## 常见问题

### Q: 签名验证失败怎么办？

A: 检查以下几点：

1. 密钥是否与服务端一致
2. 参数是否按 key 字母顺序排序
3. 对象/数组是否使用 `JSON.stringify()` 序列化（无空格）
4. 签名字符串末尾是否追加了密钥
5. 哈希结果是否转为大写

### Q: 如何调试签名问题？

A: 在客户端打印签名字符串：

```javascript
console.log('签名字符串:', signStr)
console.log('签名结果:', signature)
```

### Q: 如何查看总费用限制的使用情况？

A: 响应中的 `totalCost` 和 `totalCostLimit` 字段分别表示已使用费用和总限制，可以计算使用率：

```javascript
const usageRate = ((data.totalCost / data.totalCostLimit) * 100).toFixed(2)
console.log(`使用率: ${usageRate}%`)
```
