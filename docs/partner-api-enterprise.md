# 合作伙伴 API 文档 - 企业版

## 概览

企业版 Key 用于多人共享同一资源包。企业版专属接口只有 2 个，其余查询和更新能力直接复用主文档中的通用接口。

- 通用签名规则：见 [partner-api.md](partner-api.md#验签机制)
- 通用查询与更新：见 [partner-api.md](partner-api.md)

## 企业版和个人版的差异

| 项目       | 企业版                                                            |
| ---------- | ----------------------------------------------------------------- |
| 标识字段   | `packMode=enterprise`                                             |
| 归属者     | `externalUid` 必填，用于标识购买者或主账号                        |
| 成员列表   | 使用 `memberUids` 维护，可批量创建时写入，也可后续全量覆盖        |
| 每日限额   | 仅企业版批量创建接口支持 `dailyCostLimit`                         |
| 标签       | 默认仅带 `uni-agent`，不依赖 `pack_consent`                       |
| 使用侧鉴权 | 依赖 `uni_agent_subscription_type=enterprise` 和成员 uid 解密结果 |

补充说明：

- `memberUids` 会自动做 trim、去重、过滤空字符串
- `memberUids` 变更时，会同步维护 `enterprise_pack_member:{uid}` 反向索引
- 企业版 Key 创建后，仍可通过 `detail`、`usage`、`usage-details`、`:keyId/update`、`:keyId/expiration` 查询和更新

## 接口清单

| 接口                                        | 说明                              |
| ------------------------------------------- | --------------------------------- |
| `POST /partner/enterprise/key/batch-create` | 批量创建企业版 Key，单次 1-100 条 |
| `POST /partner/enterprise/key/members/set`  | 全量覆盖成员列表                  |

## 1. 批量创建企业版 Key

`POST /partner/enterprise/key/batch-create`

### 请求体

```json
{
  "keys": [
    {
      "name": "TeamPack-001",
      "externalUid": "owner_uid_123",
      "memberUids": ["uid_a", " uid_b ", "uid_a"],
      "totalCostLimit": 500,
      "dailyCostLimit": 50,
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
      "rateLimits": [{ "window": 300, "cost": 500 }],
      "expirationMode": "activation",
      "activationDays": 30,
      "activationUnit": "days"
    }
  ],
  "sign": "ABC123..."
}
```

### 字段说明

`keys[]` 中除企业版专属字段外，其余账号绑定、倍率、限流、过期字段和主文档完全一致。

| 字段                                                                                          | 必填 | 说明                                                                          |
| --------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------- |
| `keys`                                                                                        | 是   | 创建配置数组，长度 1-100                                                      |
| `keys[].name`                                                                                 | 是   | Key 名称，长度不超过 100                                                      |
| `keys[].externalUid`                                                                          | 是   | 归属者 uid，内部写入 `externalUid`                                            |
| `keys[].memberUids`                                                                           | 否   | 初始成员列表；会自动 trim 和去重，最终允许为空数组，但通常建议至少传 1 个成员 |
| `keys[].totalCostLimit`                                                                       | 否   | 总费用限制，非负数                                                            |
| `keys[].dailyCostLimit`                                                                       | 否   | 每日费用限制，非负数                                                          |
| `keys[].claude_account_id` ~ `keys[].kimi_account_id`                                         | 否   | 见主文档                                                                      |
| `keys[].claude_rate` ~ `keys[].kimi_rate`、`keys[].rate`                                      | 否   | 见主文档                                                                      |
| `keys[].rateLimits`                                                                           | 否   | 见主文档                                                                      |
| `keys[].expirationMode`、`keys[].expiresAt`、`keys[].activationDays`、`keys[].activationUnit` | 否   | 见主文档                                                                      |
| `sign`                                                                                        | 是   | 验签字段                                                                      |

### 创建行为

- 自动写入：
  - `description: "Created by partner enterprise API"`
  - `packMode: "enterprise"`
  - `tags: ["uni-agent"]`
  - `isActive: true`
- 成员列表会在返回值中回传标准化后的结果
- `dailyCostLimit` 仅此接口支持写入；当前 Partner 通用更新接口不提供该字段更新
- 部分条目失败时，整个接口仍返回 `code=0`，失败明细写在 `data.errors`

### 成功响应

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "total": 1,
    "created": 1,
    "failed": 0,
    "keys": [
      {
        "keyId": "key-id",
        "keyName": "TeamPack-001",
        "apiKey": "cr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "memberUids": ["uid_a", "uid_b"]
      }
    ],
    "errors": []
  }
}
```

### 部分失败示例

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "total": 2,
    "created": 1,
    "failed": 1,
    "keys": [
      {
        "keyId": "key-id",
        "keyName": "TeamPack-001",
        "apiKey": "cr_xxx",
        "memberUids": ["uid_a"]
      }
    ],
    "errors": [
      {
        "index": 1,
        "name": "TeamPack-002",
        "msg": "OpenAI account not found or inactive"
      }
    ]
  }
}
```

## 2. 全量覆盖企业成员

`POST /partner/enterprise/key/members/set`

### 请求体

```json
{
  "keyId": "key-id",
  "memberUids": ["uid_x", " uid_y ", "uid_x"],
  "sign": "ABC123..."
}
```

### 字段说明

| 字段         | 必填 | 说明                                             |
| ------------ | ---- | ------------------------------------------------ |
| `keyId`      | 是   | 企业版 Key ID                                    |
| `memberUids` | 是   | 当前完整成员列表；允许传空数组，表示清空所有成员 |
| `sign`       | 是   | 验签字段                                         |

### 行为说明

- 这是全量覆盖，不是增量追加
- 后端会对 `memberUids` 做 trim、去重、过滤空字符串
- 更新完成后会同步维护 `enterprise_pack_member:{uid}` 反向索引
- 如果传入的 `keyId` 不是企业版 Key，会返回 `400 / code=1004`

### 成功响应

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "key-id",
    "memberUids": ["uid_x", "uid_y"]
  }
}
```

## 企业版使用侧约定

企业成员实际发起 AI 请求时，服务端依赖以下 header 进入企业版切换逻辑：

| Header                           | 说明                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `uni_agent_subscription_type`    | 固定传 `enterprise`                                                                                 |
| `uni_agent_subscription_user_id` | 成员 uid 的加密值；服务端会解密后提取真实 uid，并到 `enterprise_pack_member:{uid}` 里查可用企业 Key |

行为约束：

- 企业版切换只在企业版 Key 之间进行，不会混用个人版 Key
- 企业版不依赖 `pack_consent`
- 成员 uid 不在 `memberUids` 中时，不会命中该企业 Key

## 错误码

| HTTP 状态 | `code` | 典型场景                           |
| --------- | ------ | ---------------------------------- |
| `401`     | `401`  | 缺少 `sign` 或签名错误             |
| `400`     | `1001` | 参数校验失败                       |
| `404`     | `1003` | `members/set` 中 Key 不存在        |
| `400`     | `1004` | `members/set` 传入的不是企业版 Key |
| `500`     | `1003` | 业务接口内部异常                   |
| `500`     | `500`  | 验签中间件内部异常                 |
