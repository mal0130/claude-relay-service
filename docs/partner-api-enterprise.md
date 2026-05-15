# 合作伙伴 API — 企业版接口文档

## 概述

本文档介绍企业版API Key 的管理接口。企业版支持一个 Key 被多个成员共享使用，配额整包共享。

验签机制与现有 Partner API 完全一致，参见 [partner-api.md](partner-api.md#验签机制)。

---

## 接口列表

| # | 接口 | 说明 |
|---|------|------|
| 1 | `POST /partner/enterprise/key/batch-create` | 批量创建企业 Key（单个时数组传一个元素） |
| 2 | `POST /partner/enterprise/key/members/set` | 设置成员（全量覆盖） |

> 更新配置、更新过期时间、查询用量等操作直接复用个人版接口，传企业 Key 的 `keyId` 即可，参见 [partner-api.md](partner-api.md)。

---

## 接口详情

### 接口 1：批量创建企业 Key

- **地址**：`POST /partner/enterprise/key/batch-create`
- **说明**：批量创建企业版 API Key，单次最多 100 条。创建单个时数组传一个元素即可

#### 请求参数

```json
{
  "keys": [
    {
      "name": "TeamPack-001",
      "externalUid": "owner_uid_123",
      "memberUids": ["uid_a", "uid_b", "uid_c"],
      "totalCostLimit": 500.0,
      "dailyCostLimit": 50.0,
      "claude_account_id": "group:381cb540-f33e-49d1-8fda-80348f8c456f",
      "openai_account_id": "responses:openai-responses-account-uuid",
      "deepseek_account_id": "group:deepseek-group-uuid",
      "claude_rate": 2.1,
      "openai_rate": 1.8,
      "deepseek_rate": 1.2,
      "rateLimits": [
        { "window": 300, "cost": 500 }
      ],
      "expirationMode": "activation",
      "activationDays": 30,
      "activationUnit": "days"
    }
  ],
  "sign": "ABC123..."
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| keys | array | 是 | 创建配置数组，长度 1-100 |
| sign | string | 是 | SHA256 签名（大写十六进制） |

**keys[] 字段说明**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Key 名称，≤100 字符 |
| externalUid | string | 是 | 归属者 uid（购买者） |
| memberUids | array | 是 | 初始成员 uid 列表，至少 1 个 |
| totalCostLimit | number | 否 | 总费用限制（美元），0 表示不限 |
| dailyCostLimit | number | 否 | 每日费用限制（美元），0 表示不限 |
| claude_account_id | string | 否 | Claude 账户 ID 或 `group:xxx` |
| openai_account_id | string | 否 | OpenAI 账户 ID，支持 `group:...`、`responses:...` |
| deepseek_account_id | string | 否 | DeepSeek 账户 ID，支持 `group:...` |
| claude_rate | number | 否 | Claude 服务倍率，正数，最多 1 位小数 |
| openai_rate | number | 否 | OpenAI 服务倍率 |
| deepseek_rate | number | 否 | DeepSeek 服务倍率 |
| rateLimits | array | 否 | 限流规则，每项含 `window`(分钟)、`requests`、`cost` |
| expiresAt | string | 否 | 固定过期时间，ISO 8601，与 `activation` 模式互斥 |
| expirationMode | string | 否 | `fixed`（默认）或 `activation` |
| activationDays | integer | 否 | 激活后有效时长，`activation` 模式必填 |
| activationUnit | string | 否 | `hours` 或 `days`，`activation` 模式必填 |

#### 响应

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
        "keyId": "xxx-xxx-xxx",
        "keyName": "TeamPack-001",
        "apiKey": "cr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "memberUids": ["uid_a", "uid_b", "uid_c"]
      }
    ],
    "errors": []
  }
}
```

**部分失败**

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "total": 2,
    "created": 1,
    "failed": 1,
    "keys": [...],
    "errors": [
      { "index": 1, "name": "TeamPack-002", "msg": "memberUids is required" }
    ]
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| data.total | number | 请求创建的总条数 |
| data.created | number | 成功创建的条数 |
| data.failed | number | 失败的条数 |
| data.keys[].keyId | string | API Key ID |
| data.keys[].keyName | string | API Key 名称 |
| data.keys[].apiKey | string | 完整 API Key（仅创建时返回一次） |
| data.keys[].memberUids | array | 初始成员列表 |
| data.errors[].index | number | 失败项在 keys 数组中的下标 |
| data.errors[].name | string | 失败项的 name |
| data.errors[].msg | string | 失败原因 |

---

### 接口 2：设置成员（全量覆盖）

- **地址**：`POST /partner/enterprise/key/members/set`
- **说明**：设置企业 Key 的成员列表，传入当前所有可用成员 uid，**全量覆盖**原有列表。后端自动计算差量并同步维护 `enterprise_pack_member` 反向索引

#### 请求参数

```json
{
  "keyId": "xxx-xxx-xxx",
  "memberUids": ["uid_a", "uid_b", "uid_c"],
  "sign": "ABC123..."
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| keyId | string | 是 | 企业 Key ID |
| memberUids | array | 是 | 当前全部成员 uid 列表，传空数组表示清空所有成员 |
| sign | string | 是 | SHA256 签名 |

#### 响应

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "xxx-xxx-xxx",
    "memberUids": ["uid_a", "uid_b", "uid_c"]
  }
}
```

---

## enterprise_pack_member 索引说明

`enterprise_pack_member:{uid}` 是企业版的反向索引，记录某个成员 uid 有权使用哪些企业 Key，用于鉴权时快速查找候选 Key。

### 数据结构

```
enterprise_pack_member:{memberUid}  →  Redis Set{ keyId1, keyId2, ... }
```

### 维护时机

| 操作 | 索引变更 |
|------|----------|
| 批量创建企业 Key（`batch-create`） | 为每个 `memberUids` 中的 uid 添加 `keyId` |
| 设置成员（`members/set`） | 对比新旧列表：新增的 uid 添加 `keyId`，移除的 uid 删除 `keyId` |
| 个人版接口停用/删除企业 Key | 从所有成员的索引中删除该 `keyId` |

### 维护逻辑（set 操作伪代码）

```
旧列表 = 读取 apikey:{keyId}.memberUids
新列表 = 请求传入的 memberUids

新增 = 新列表 - 旧列表
移除 = 旧列表 - 新列表

for uid in 新增:
    SADD enterprise_pack_member:{uid} keyId

for uid in 移除:
    SREM enterprise_pack_member:{uid} keyId

更新 apikey:{keyId}.memberUids = 新列表
```

---

## 请求鉴权说明（企业版使用方）

企业版成员发起 AI 请求时，需在 header 中携带以下参数，系统据此走企业版切换逻辑：

| Header | 说明 |
|--------|------|
| `x-user-id` | 当前使用者的 uid（必须在该 Key 的 `memberUids` 中） |
| `x-pack-mode` | 固定传 `enterprise` |

- `x-pack-mode: enterprise` 时，系统查 `enterprise_pack_member:{x-user-id}` 索引，只在企业 Key 之间切换
- 企业 Key 切换**不需要** `pack_consent` 标签，`memberUids` 本身即授权凭据
- 企业 Key 与个人 Key 完全隔离，不会互相切换

---

## 错误码

| code | 说明 |
|------|------|
| 0 | 成功 |
| 1001 | 参数错误 |
| 1002 | 签名验证失败 |
| 1003 | Key 不存在 |
| 1004 | Key 不是企业版 |
| 1005 | 成员 uid 不在该 Key 的成员列表中 |
