# LDAP 配置指南

## 简介
Claude Relay Service 支持通过 LDAP (Lightweight Directory Access Protocol) 进行用户认证。开启 LDAP 后，普通用户可以通过企业目录账号（如 Active Directory, OpenLDAP）直接登录系统，系统会自动同步用户信息。

> **重要提示**：LDAP 仅接管普通用户 (`/users/login`) 的认证流程。管理员账号 (`admin`) 仍然使用本地配置文件 (`data/init.json`) 中的密码登录，不受 LDAP 配置影响。这确保了即使 LDAP 服务不可用，管理员仍可登录系统进行维护。

## 快速配置

在项目根目录的 `.env` 文件中添加或修改以下配置：

### 1. 基础开关与连接
| 变量名 | 说明 | 示例 / 默认值 |
| :--- | :--- | :--- |
| `LDAP_ENABLED` | 是否启用 LDAP | `true` |
| `LDAP_URL` | 服务器地址 | `ldap://localhost:389` 或 `ldaps://ldap.example.com:636` |
| `LDAP_TIMEOUT` | 操作超时时间(毫秒) | `5000` |
| `LDAP_CONNECT_TIMEOUT` | 连接超时时间(毫秒) | `10000` |

### 2. 认证模式配置

系统支持两种认证模式，请根据 LDAP 服务器类型选择其一：

#### 模式 A: 管理员绑定 (推荐，适用于大多数场景)
系统使用管理员账号搜索用户 DN，然后验证用户密码。需要配置 `LDAP_BIND_DN` 和 `LDAP_BIND_PASSWORD`。

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `LDAP_BIND_DN` | 用于搜索的管理员 DN | `cn=admin,dc=example,dc=com` |
| `LDAP_BIND_PASSWORD` | 管理员密码 | `your_secure_password` |

#### 模式 B: 直接绑定 (适用于已知 DN 规则的场景)
如果用户 DN 遵循固定模式，可以跳过搜索步骤，直接构建 DN 进行认证。配置此项后将忽略管理员绑定配置。

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `LDAP_BIND_DN_PATTERN` | 用户 DN 模式模板<br>`{{username}}` 会被替换为登录名 | `uid={{username}},cn=users,dc=example,dc=com` |

### 3. 用户搜索 (模式 A 必需)
| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `LDAP_SEARCH_BASE` | 用户搜索的根路径 (Base DN) | `ou=users,dc=example,dc=com` |
| `LDAP_SEARCH_FILTER` | 搜索过滤器<br>**注意**: 请务必使用具体的属性过滤，避免使用 `(cn=*)` 这种宽泛过滤，以免匹配到非用户对象 | 默认: `(uid={{username}})`<br>AD常用: `(sAMAccountName={{username}})` |
| `LDAP_SEARCH_ATTRIBUTES` | 查询返回的属性列表 (逗号分隔) | `dn,uid,cn,mail,givenName,sn` |

### 4. 用户属性映射
LDAP 验证成功后，系统会将 LDAP 属性同步到本地用户数据库。

| 变量名 | 本地字段 | 默认 LDAP 属性 | AD 建议值 |
| :--- | :--- | :--- | :--- |
| `LDAP_USER_ATTR_USERNAME` | 用户名 | `uid` | `sAMAccountName` |
| `LDAP_USER_ATTR_DISPLAY_NAME` | 显示名 | `cn` | `displayName` |
| `LDAP_USER_ATTR_EMAIL` | 邮箱 | `mail` | `mail` |
| `LDAP_USER_ATTR_FIRST_NAME` | 名 | `givenName` | `givenName` |
| `LDAP_USER_ATTR_LAST_NAME` | 姓 | `sn` | `sn` |

### 5. SSL/TLS 安全配置 (可选)
如果使用 `ldaps://` 协议：

| 变量名 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | 是否验证证书有效性 | `true` (自签名证书请设为 `false`) |
| `LDAP_TLS_CA_FILE` | 自定义 CA 证书路径 | 空 |
| `LDAP_TLS_CERT_FILE` | 客户端证书路径 (双向认证) | 空 |
| `LDAP_TLS_KEY_FILE` | 客户端私钥路径 (双向认证) | 空 |

---

## 典型配置示例

### 场景 A: Windows Active Directory (AD)
```bash
LDAP_ENABLED=true
LDAP_URL=ldap://192.168.1.100:389
# AD 管理员通常格式为 DOMAIN\User 或 CN=...
LDAP_BIND_DN=MYDOMAIN\Administrator
LDAP_BIND_PASSWORD=SecretPassword123
LDAP_SEARCH_BASE=CN=Users,DC=mycompany,DC=com
# AD 使用 sAMAccountName 作为登录名
LDAP_SEARCH_FILTER=(sAMAccountName={{username}})

# 属性映射
LDAP_USER_ATTR_USERNAME=sAMAccountName
LDAP_USER_ATTR_DISPLAY_NAME=displayName
LDAP_USER_ATTR_EMAIL=mail
```

### 场景 B: OpenLDAP (标准)
```bash
LDAP_ENABLED=true
LDAP_URL=ldap://openldap-server:389
LDAP_BIND_DN=cn=admin,dc=example,dc=org
LDAP_BIND_PASSWORD=admin
LDAP_SEARCH_BASE=ou=people,dc=example,dc=org
LDAP_SEARCH_FILTER=(uid={{username}})
```

---

## 认证流程与特性

### 1. 认证逻辑
系统采用标准的 "Search & Bind" 流程：
1.  **连接**: 使用 `LDAP_BIND_DN` 连接 LDAP 服务器。
2.  **搜索**: 在 `LDAP_SEARCH_BASE` 下根据 `LDAP_SEARCH_FILTER` 查找用户，获取用户的 DN (Distinguished Name)。
3.  **验证**: 尝试使用 **用户 DN + 用户密码** 进行绑定。
4.  **AD 兼容性**: 如果标准 DN 绑定失败，系统会自动尝试 Windows AD 风格的认证格式（如 `user@domain` 或 `DOMAIN\user`）进行重试。

### 2. 自动账户同步 (Auto-Provisioning)
认证成功后：
*   **新用户**: 如果本地数据库中不存在该用户，系统会自动创建新用户。
*   **老用户**: 如果用户已存在，系统会更新其邮箱、显示名等信息，保持与 LDAP 同步。
*   **API Key 继承**: 如果系统中存在由管理员创建但未分配用户的 API Key（匹配用户名或邮箱），新用户登录时会自动获得这些 API Key 的所有权。

### 3. 安全保护
*   **防止注入**: 用户名会自动进行转义处理，防止 LDAP 注入攻击。
*   **禁用检查**: 如果本地用户被管理员标记为禁用 (`isActive=false`)，即使 LDAP 密码正确也会拒绝登录。

## 故障排查

### 常见错误代码
*   `ECONNREFUSED`: 无法连接到 LDAP 服务器，请检查 IP 和端口。
*   `InvalidCredentialsError`: Bind DN 或密码错误。
*   `User not found in LDAP`: 根据 Filter 未搜索到用户，请检查 `LDAP_SEARCH_BASE` 和 `LDAP_SEARCH_FILTER`。

### 调试模式
如果遇到问题，可以在 `.env` 中设置 `DEBUG=true`，系统会输出详细的 LDAP 交互日志（注意：生产环境请关闭，以免日志过多）。

### 检查工具
管理员可以使用 API `/api/admin/ldap-test` 来测试 LDAP 连接配置是否正确。
