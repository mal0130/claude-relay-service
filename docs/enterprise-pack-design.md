# 企业版设计方案

> 日期：2026-05-15

## 背景

现有资源包（`_pack-(10|100|1000|10000)-month`）和订阅套餐（`pack-month-149/360/1490`）均为个人版，一个 key 绑定一个归属者（`externalUid`）。企业版需要支持一个 key 被多个用户共享使用，但归属权不变。

---

## 核心字段设计

| 字段 | 类型 | 说明 |
|------|------|------|
| `externalUid` | `string` | 归属者（购买者），所有类型统一不变 |
| `memberUids` | `string` (JSON 数组) | 有权使用该 key 的成员 uid 列表，仅企业版有值 |

**个人版**：`memberUids` 为空，沿用现有逻辑。
**企业版**：`memberUids = ["uid_a", "uid_b", "uid_c"]`，`externalUid` 仍为归属者。

---

## Redis 数据结构

### API Key 字段扩展

```
apikey:{keyId}
  ...现有字段...
  memberUids: '["uid_a","uid_b","uid_c"]'   // 企业版有值，个人版为空
```

### 索引对照

| 索引 | 用途 |
|------|------|
| `uid_keys:{externalUid}` | 现有索引，归属者 → key 列表，个人版切换用 |
| `enterprise_pack_member:{memberUid}` | 新增索引，成员 uid → 企业 key 列表，企业版切换用 |

两套索引完全隔离，互不干扰。

---

## 鉴权 / 切换逻辑

请求 header 新增参数：

| 参数 | 值 | 说明 |
|------|----|------|
| `x-user-id` | uid 字符串 | 当前实际使用者 |
| `x-pack-mode` | `enterprise` / `personal` | 使用企业版还是个人版 |

### 切换入口判断

```
x-pack-mode = 'enterprise'
  → 查 enterprise_pack_member:{x-user-id}
  → 候选 key 全为企业 key
  → 无需 pack_consent，有 memberUid 即可切换
  → 优先级：企业订阅 > 其他 > 企业资源包

x-pack-mode = 'personal'（或不传）
  → 查 uid_keys:{externalUid}（现有逻辑不变）
  → pack_consent 规则照旧
  → 优先级：套餐 > 其他 > 资源包（需 pack_consent）
```

### 企业版切换规则

- 只在 `enterprise_pack_member:{user_id}` 索引中查找候选 key
- 候选 key 的 `memberUids` 必须包含 `x-user-id`（索引保证，双重校验）
- **不需要 `pack_consent` 标签**，`memberUids` 本身即授权凭据
- 企业 key 不会出现在个人版候选列表，个人 key 不会出现在企业版候选列表

---

## 配额共享策略

企业 key 的配额**整包共享**，所有成员共同消耗：

- `tokenLimit`、`dailyCostLimit`、`totalCostLimit` 等限制作用于整个 key
- usage 统计记录在 key 维度，可附加 `x-user-id` 用于后续按成员分析

### 按成员限额（v2 可选）

如需按成员设置子限额，`memberUids` 可改为对象数组：

```json
[
  { "uid": "uid_a", "dailyCostLimit": 5.0 },
  { "uid": "uid_b", "dailyCostLimit": 2.0 }
]
```

v1 先做整包共享，按需再加。

---

## Partner API 变化

### 创建 / 更新 key

新增参数透传：

```json
POST /partner/api-keys
{
  "...现有参数...",
  "memberUids": ["uid_b", "uid_c"]
}
```

`memberUids` 非空即视为企业版，无需额外 `packType` 字段。

### 成员管理接口（新增）

全部使用 POST，路由前缀 `/partner/enterprise/`，与个人版接口完全隔离：

```
POST /partner/enterprise/key/batch-create     批量创建企业 Key（单个时数组传一个元素）
POST /partner/enterprise/key/members/add      添加成员
POST /partner/enterprise/key/members/remove   移除成员
```

更新配置、更新过期时间、查询用量等操作直接复用个人版接口，传企业 Key 的 `keyId` 即可。

详细接口文档见 [partner-api-enterprise.md](partner-api-enterprise.md)。

---

## 改动范围

| 文件 | 改动内容 |
|------|----------|
| `src/services/apiKeyService.js` | `createApiKey` 加 `memberUids` 字段；新增成员管理方法（增/删/查，同步维护 `enterprise_pack_member` 索引） |
| `src/models/redis.js` | 新增 `enterprise_pack_member` 索引的 CRUD 方法 |
| `src/routes/partner.js` | 新增 `/partner/enterprise/` 下的全部企业版接口，与个人版接口完全隔离 |
| `src/middleware/auth.js` | 读取 `x-pack-mode` + `x-user-id`；企业版模式走 `enterprise_pack_member` 索引，跳过 `pack_consent` 检查；个人模式走现有 `uid_keys` 逻辑不变 |

所有改动均为**加法**，个人版逻辑零改动，向后兼容。
