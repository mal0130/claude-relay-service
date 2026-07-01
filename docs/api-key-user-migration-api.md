# API Key 用户归属迁移接口文档

本文档用于 2.0 项目通过 HTTP 接口读取当前项目 API Key，并按当前归属用户迁移到 2.0 对应用户名下。

## 1. 认证

先登录后台拿 Admin Token：

```bash
curl -X POST 'http://127.0.0.1:3000/web/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"你的管理员密码"}'
```

成功响应：

```json
{
  "success": true,
  "token": "ADMIN_TOKEN",
  "expiresIn": 86400000,
  "username": "admin"
}
```

后续迁移接口统一带：

```http
Authorization: Bearer ADMIN_TOKEN
```

也支持 `x-admin-token: ADMIN_TOKEN`，但推荐使用 `Authorization`。

## 2. 拉取 API Key 列表

接口：

```http
GET /admin/api-keys
```

示例：

```bash
curl 'http://127.0.0.1:3000/admin/api-keys?page=1&pageSize=100&searchMode=apiKey&sortBy=lastUsedAt&sortOrder=desc' \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

分页参数：

| 参数 | 说明 |
| --- | --- |
| `page` | 页码，从 `1` 开始 |
| `pageSize` | 每页数量，只支持 `10` / `20` / `50` / `100` |
| `searchMode` | `apiKey` 或 `bindingAccount` |
| `search` | 搜索词，可空 |
| `tag` | 标签筛选，可空 |
| `isActive` | `true` / `false` / 空 |
| `models` | 模型筛选，逗号分隔，可空 |
| `sortBy` | `name` / `createdAt` / `expiresAt` / `lastUsedAt` / `isActive` / `status` / `cost` |
| `sortOrder` | `asc` / `desc` |

响应结构：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "legacy_crs_key_id",
        "name": "API Key 名称",
        "description": "",
        "apiKey": "sha256_hash",
        "isActive": true,
        "isDeleted": false,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "lastUsedAt": "2026-01-02T00:00:00.000Z",
        "expiresAt": "",
        "userId": "legacy_crs_user_id",
        "userUsername": "username",
        "createdBy": "user",
        "ownerDisplayName": "用户显示名",
        "externalUid": "",
        "permissions": "all",
        "accountBindings": {},
        "rateLimits": [
          {
            "window": 60,
            "requests": 100,
            "cost": 10
          }
        ],
        "dailyCostLimit": 0,
        "totalCostLimit": 0,
        "weeklyOpusCostLimit": 0,
        "weeklyResetDay": 1,
        "weeklyResetHour": 0,
        "tags": []
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 100,
      "total": 123,
      "totalPages": 2
    },
    "availableTags": []
  }
}
```

迁移注意：

- `id` 是当前项目 API Key ID，建议迁到 2.0 后保存为 `legacy_crs_key_id`。
- `apiKey` 是原始 `cr_...` 的 SHA-256 哈希，不是明文 Key，不能反推出明文。
- 如果 2.0 要继续兼容旧 Key，需要从外部业务系统或用户侧拿到原始 `cr_...`。
- `/admin/api-keys` 默认不返回已删除 Key。
- `timeRange=today` 在 `sortBy=lastUsedAt` 时不做列表过滤，只是兼容参数；统计数据请看下面的批量统计接口。
- 订阅/额度限制的静态配置在这里拿：`rateLimits`、`dailyCostLimit`、`totalCostLimit`、`weeklyOpusCostLimit`、`weeklyResetDay`、`weeklyResetHour`。

## 3. 获取对应用户信息

API Key 列表里有 `userId`、`userUsername`、`ownerDisplayName`，但迁移归属建议再查用户详情。

### 3.1 批量拉用户列表

接口：

```http
GET /users
```

示例：

```bash
curl 'http://127.0.0.1:3000/users?page=1&limit=1000' \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

查询参数：

| 参数 | 说明 |
| --- | --- |
| `page` | 页码 |
| `limit` | 每页数量 |
| `role` | 可选，按角色过滤 |
| `isActive` | 可选，`true` / `false` |
| `search` | 可选，按 `username` / `displayName` / `email` 搜索 |

响应结构：

```json
{
  "success": true,
  "users": [
    {
      "id": "legacy_crs_user_id",
      "username": "username",
      "email": "user@example.com",
      "displayName": "显示名",
      "role": "user",
      "isActive": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "lastLoginAt": "2026-01-02T00:00:00.000Z",
      "apiKeyCount": 1,
      "totalUsage": {
        "requests": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "totalCost": 0
      }
    }
  ],
  "pagination": {
    "total": 1,
    "page": 1,
    "limit": 1000,
    "totalPages": 1
  }
}
```

### 3.2 查询单个用户详情

接口：

```http
GET /users/:userId
```

示例：

```bash
curl 'http://127.0.0.1:3000/users/<userId>' \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

响应会返回用户资料和该用户名下 API Key 简表：

```json
{
  "success": true,
  "user": {
    "id": "legacy_crs_user_id",
    "username": "username",
    "email": "user@example.com",
    "displayName": "显示名",
    "role": "user",
    "isActive": true,
    "apiKeys": [
      {
        "id": "legacy_crs_key_id",
        "name": "API Key 名称",
        "isActive": true,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "lastUsedAt": "2026-01-02T00:00:00.000Z"
      }
    ]
  }
}
```

不要用 `/admin/users` 做迁移用户来源；当前实现里它主要给 API Key 分配下拉框用，只返回 Admin 选项。

## 4. 已删除 API Key

如果只迁移业务可用 Key，忽略这一节即可。

接口：

```http
GET /admin/api-keys/deleted
```

示例：

```bash
curl 'http://127.0.0.1:3000/admin/api-keys/deleted' \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

响应：

```json
{
  "success": true,
  "apiKeys": [
    {
      "id": "legacy_crs_key_id",
      "isDeleted": true,
      "deletedAt": "2026-01-01T00:00:00.000Z",
      "deletedBy": "admin",
      "deletedByType": "admin",
      "canRestore": true
    }
  ],
  "total": 1
}
```

## 5. 批量统计、限制状态和重置窗口接口

如果迁移时需要把某批 Key 的请求数、tokens、费用、订阅限制当前状态、窗口剩余时间一起带过去，调用：

```http
POST /admin/api-keys/batch-stats
```

示例：

```bash
curl -X POST 'http://127.0.0.1:3000/admin/api-keys/batch-stats' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "keyIds": ["key-id-1", "key-id-2"],
    "timeRange": "all"
  }'
```

请求体：

| 字段 | 说明 |
| --- | --- |
| `keyIds` | API Key ID 数组，必填，单次最多 100 个 |
| `timeRange` | `all` / `today` / `7days` / `monthly` / `custom` |
| `startDate` | `custom` 时必填 |
| `endDate` | `custom` 时必填 |

响应结构：

```json
{
  "success": true,
  "data": {
    "key-id-1": {
      "requests": 10,
      "tokens": 12345,
      "inputTokens": 5000,
      "outputTokens": 6000,
      "cacheCreateTokens": 1000,
      "cacheReadTokens": 345,
      "cost": 1.23,
      "realCost": 0.98,
      "formattedCost": "$1.23",
      "dailyCost": 0.5,
      "weeklyOpusCost": 0.7,
      "allTimeCost": 12.34,
      "currentWindowRequests": 3,
      "currentWindowTokens": 1000,
      "currentWindowCost": 0.12,
      "windowRemainingSeconds": 1800,
      "windowStartTime": 1767225600000,
      "windowEndTime": 1767229200000,
      "rateLimitStatuses": [
        {
          "key": "rate_limit",
          "ruleId": "rate_limit_requests_0",
          "label": "60分钟请求限制",
          "current": 3,
          "limit": 100,
          "unit": "requests",
          "windowMinutes": 60,
          "remainingSeconds": 1800,
          "reached": false,
          "status": "normal"
        }
      ],
      "limitStatuses": [
        {
          "key": "daily_cost",
          "label": "每日限制",
          "current": 0.5,
          "limit": 10,
          "unit": "usd",
          "reached": false,
          "status": "normal"
        }
      ],
      "limitSummary": "normal"
    }
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `dailyCost` | 当前自然日已用费用 |
| `weeklyOpusCost` | 当前 Claude 周期已用费用，周期配置来自 API Key 的 `weeklyResetDay` / `weeklyResetHour` |
| `allTimeCost` | 总累计费用 |
| `currentWindowRequests` | 当前第一个速率限制窗口内请求数 |
| `currentWindowTokens` | 当前第一个速率限制窗口内 tokens |
| `currentWindowCost` | 当前第一个速率限制窗口内费用 |
| `windowStartTime` | 当前第一个速率限制窗口开始时间，毫秒时间戳；没有活动窗口时为 `null` |
| `windowEndTime` | 当前第一个速率限制窗口结束时间，毫秒时间戳；没有活动窗口时为 `null` |
| `windowRemainingSeconds` | 当前第一个速率限制窗口距离重置的剩余秒数；没有活动窗口时为 `null` |
| `rateLimitStatuses` | 多规则速率限制状态，每条规则带 `windowMinutes`、`remainingSeconds`、`current`、`limit` |
| `limitStatuses` | 统一限制状态，包含每日费用、总费用、Claude 周费用、速率限制等已配置项目 |
| `limitSummary` | `unlimited` / `normal` / `reached` |

注意：

- 订阅限制的“配置值”来自 `/admin/api-keys`，比如 `dailyCostLimit`、`totalCostLimit`、`weeklyOpusCostLimit`、`rateLimits`。
- 订阅限制的“当前用量、是否触顶、窗口剩余时间”来自 `/admin/api-keys/batch-stats`。
- `weeklyResetDay` / `weeklyResetHour` 是周费用周期配置，`batch-stats` 会用它计算 `weeklyOpusCost`，但响应里不会单独返回下次周重置时间。
- 速率限制窗口的重置时间看 `windowEndTime` 或 `rateLimitStatuses[].remainingSeconds`。

## 6. 最后使用时间和最后使用账号接口

如果迁移时需要拿每个 Key 的最后使用时间、最后使用账号、账号类型，调用：

```http
POST /admin/api-keys/batch-last-usage
```

示例：

```bash
curl -X POST 'http://127.0.0.1:3000/admin/api-keys/batch-last-usage' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "keyIds": ["key-id-1", "key-id-2"]
  }'
```

请求体：

| 字段 | 说明 |
| --- | --- |
| `keyIds` | API Key ID 数组，必填，单次最多 100 个 |

响应结构：

```json
{
  "success": true,
  "data": {
    "key-id-1": {
      "accountId": "account-id",
      "rawAccountId": "raw-account-id",
      "accountType": "claude",
      "accountCategory": "claude",
      "accountName": "账号名称",
      "recordedAt": "2026-01-02T00:00:00.000Z"
    },
    "key-id-2": null
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `recordedAt` | 最后一条使用记录的时间，可作为最后使用时间 |
| `accountId` | 解析后的最后使用账号 ID；账号已删除时可能为 `null` |
| `rawAccountId` | usage 记录里原始账号 ID |
| `accountType` | 最后使用账号类型；账号已删除时为 `deleted` |
| `accountCategory` | 账号分类；账号已删除时为 `deleted` |
| `accountName` | 账号名称；账号已删除时为 `已删除` |

注意：

- `/admin/api-keys` 返回的 `lastUsedAt` 是 Key 主记录上的基础最后使用时间。
- `/admin/api-keys/batch-last-usage` 从 `usage:records:{keyId}` 读取最近一条请求记录，能拿到更完整的最后使用账号信息和 `recordedAt`。
- 迁移时如果只需要排序/展示时间，可以用 `lastUsedAt`；如果要带最后使用账号信息，必须调用 `batch-last-usage`。

## 7. 推荐迁移流程

1. 调 `/web/auth/login` 获取 `ADMIN_TOKEN`。
2. 调 `/users?page=1&limit=1000` 分页拉全量用户，建立 `legacy_crs_user_id -> username` 映射。
3. 在 2.0 项目中建立 `username -> owner_user_id_2_0` 映射。
4. 调 `/admin/api-keys?page=N&pageSize=100` 分页拉全量 API Key。
5. 对每个 API Key 判断归属：
   - `userId` 非空：优先用 `userId` 查当前项目用户，拿 `username`，迁到 2.0 同名用户下。
   - `userId` 非空但用户不存在：用 `userUsername` 兜底，并记录 `owner_match_status=username_fallback`。
   - `userId` 为空：按 Admin/未归属处理，记录 `owner_match_status=admin`。
6. 如需迁移当前用量和限制状态，按每批最多 100 个 Key 调 `/admin/api-keys/batch-stats`。
7. 如需迁移最后使用账号和最后使用记录时间，按每批最多 100 个 Key 调 `/admin/api-keys/batch-last-usage`。
8. 跳过 `isDeleted=true`，除非本次迁移需要保留删除审计。
9. 保存 legacy 字段用于对账：

| 2.0 建议字段 | 当前项目来源 |
| --- | --- |
| `legacy_crs_key_id` | `items[].id` |
| `legacy_crs_key_hash` | `items[].apiKey` |
| `legacy_crs_user_id` | `items[].userId` |
| `legacy_crs_username` | 优先 `/users/:userId.user.username`，兜底 `items[].userUsername` |
| `owner_user_id` | 2.0 中同 username 的用户 ID |
| `owner_match_status` | 迁移脚本生成 |

## 8. 归属判断规则

归属判断只认用户管理字段，不认上游账号：

```text
apikey.userId -> user.id -> user.username -> 2.0 同 username 用户
```

字段优先级：

1. `userId`：主归属字段。
2. `/users/:userId` 返回的 `username`：最可靠用户名。
3. `userUsername`：冗余兜底。
4. `ownerDisplayName`：展示字段，不建议作为迁移匹配字段。
5. `createdBy`：创建来源/历史操作人语义，不建议作为归属字段。
6. `externalUid`：外部用户 ID，用于多 Key 自动切换，不等同于用户管理归属。
