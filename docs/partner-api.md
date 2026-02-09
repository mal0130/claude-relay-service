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
  "sign": "ABC123..."
}
```

| 参数           | 类型   | 必填 | 说明                        |
| -------------- | ------ | ---- | --------------------------- |
| name           | string | 是   | API Key 的名称              |
| totalCostLimit | number | 否   | 总费用限制（美元）          |
| sign           | string | 是   | SHA256 签名（大写十六进制） |

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
- Claude 专属账号自动绑定到 `FoxCode` 账户
- 权限固定为 `claude`，只允许访问 Claude 服务
- API Key 创建后自动激活

---

### 接口 2: 查询 API Key 用量汇总

#### 请求参数

**请求体**

```json
{
  "key_name": "MyApp",
  "sign": "ABC123..."
}
```

| 参数     | 类型   | 必填 | 说明                        |
| -------- | ------ | ---- | --------------------------- |
| key_name | string | 是   | API Key 的名称              |
| sign     | string | 是   | SHA256 签名（大写十六进制） |

#### 响应格式

**成功响应**

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "xxx-xxx-xxx",
    "keyName": "MyApp",
    "totalCost": 12.34,
    "totalCostLimit": 100.0
  }
}
```

### 响应字段说明

| 字段                | 类型   | 说明                                      |
| ------------------- | ------ | ----------------------------------------- |
| code                | number | 状态码，0表示成功，其他值表示错误         |
| msg                 | string | 消息，成功时为"success"，失败时为错误信息 |
| data                | object | 业务数据                                  |
| data.keyId          | string | API Key ID                                |
| data.keyName        | string | API Key 名称                              |
| data.totalCost      | number | 总费用（美元）                            |
| data.totalCostLimit | number | 总费用限制（美元）                        |

**错误响应**

```json
{
  "code": 1001,
  "msg": "key_name is required",
  "data": null
}
```

---

### 接口 2: 查询 API Key 用量明细

#### 请求参数

**请求体**

```json
{
  "key_name": "MyApp",
  "sign": "ABC123..."
}
```

| 参数     | 类型   | 必填 | 说明                        |
| -------- | ------ | ---- | --------------------------- |
| key_name | string | 是   | API Key 的名称              |
| sign     | string | 是   | SHA256 签名（大写十六进制） |

#### 响应格式

**成功响应**

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "keyId": "xxx-xxx-xxx",
    "keyName": "MyApp",
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

| 字段                              | 类型   | 说明                                      |
| --------------------------------- | ------ | ----------------------------------------- |
| code                              | number | 状态码，0表示成功，其他值表示错误         |
| msg                               | string | 消息，成功时为"success"，失败时为错误信息 |
| data                              | object | 业务数据                                  |
| data.keyId                        | string | API Key ID                                |
| data.keyName                      | string | API Key 名称                              |
| data.period                       | string | 统计周期（固定为 "last_30_days"）        |
| data.totalStats                   | object | 总计统计数据                              |
| data.totalStats.requests          | number | 总请求次数                                |
| data.totalStats.inputTokens       | number | 总输入 Token 数                           |
| data.totalStats.outputTokens      | number | 总输出 Token 数                           |
| data.totalStats.cacheCreateTokens | number | 总缓存创建 Token 数                       |
| data.totalStats.cacheReadTokens   | number | 总缓存读取 Token 数                       |
| data.totalStats.totalTokens       | number | 总 Token 数（所有类型之和）               |
| data.totalStats.cost              | number | 总费用（美元）                            |
| data.dailyUsage                   | array  | 每日用量明细数组（按日期倒序）            |
| data.dailyUsage[].date            | string | 日期（YYYY-MM-DD 格式）                   |
| data.dailyUsage[].requests        | number | 当日请求次数                              |
| data.dailyUsage[].inputTokens     | number | 当日输入 Token 数                         |
| data.dailyUsage[].outputTokens    | number | 当日输出 Token 数                         |
| data.dailyUsage[].cacheCreateTokens | number | 当日缓存创建 Token 数                   |
| data.dailyUsage[].cacheReadTokens | number | 当日缓存读取 Token 数                     |
| data.dailyUsage[].totalTokens     | number | 当日总 Token 数                           |
| data.dailyUsage[].cost            | number | 当日费用（美元）                          |
| data.dailyUsage[].models          | array  | 当日各模型的用量明细（按请求数倒序）      |
| data.dailyUsage[].models[].model  | string | 模型名称                                  |
| data.dailyUsage[].models[].requests | number | 该模型当日请求次数                      |
| data.dailyUsage[].models[].inputTokens | number | 该模型当日输入 Token 数              |
| data.dailyUsage[].models[].outputTokens | number | 该模型当日输出 Token 数             |
| data.dailyUsage[].models[].cacheCreateTokens | number | 该模型当日缓存创建 Token 数   |
| data.dailyUsage[].models[].cacheReadTokens | number | 该模型当日缓存读取 Token 数     |
| data.dailyUsage[].models[].totalTokens | number | 该模型当日总 Token 数                |
| data.dailyUsage[].models[].cost   | number | 该模型当日费用（美元）                    |
| data.modelStats                   | array  | 按模型维度的统计数组（按请求数倒序）      |
| data.modelStats[].model           | string | 模型名称                                  |
| data.modelStats[].requests        | number | 该模型的请求次数                          |
| data.modelStats[].inputTokens     | number | 该模型的输入 Token 数                     |
| data.modelStats[].outputTokens    | number | 该模型的输出 Token 数                     |
| data.modelStats[].cacheCreateTokens | number | 该模型的缓存创建 Token 数               |
| data.modelStats[].cacheReadTokens | number | 该模型的缓存读取 Token 数                 |
| data.modelStats[].totalTokens     | number | 该模型的总 Token 数                       |
| data.modelStats[].cost            | number | 该模型的费用（美元）                      |

**错误响应**

```json
{
  "code": 1001,
  "msg": "key_name is required",
  "data": null
}
```

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
async function queryUsage(keyName) {
  const params = { key_name: keyName }
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
queryUsage('MyApp')
  .then((data) => {
    console.log('总费用:', data.data.totalCost)
    console.log('费用限制:', data.data.totalCostLimit)
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
async function queryUsageDetails(keyName) {
  const params = { key_name: keyName }
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
queryUsageDetails('MyApp')
  .then((data) => {
    const { totalStats, dailyUsage, modelStats } = data.data

    console.log('=== 总计统计 ===')
    console.log('总请求数:', totalStats.requests)
    console.log('总Token数:', totalStats.totalTokens)
    console.log('总费用:', `$${totalStats.cost}`)

    console.log('\n=== 每日用量（最近5天）===')
    dailyUsage.slice(0, 5).forEach(day => {
      console.log(`${day.date}: ${day.requests}次请求, ${day.totalTokens} tokens, $${day.cost}`)
    })

    console.log('\n=== 模型统计（Top 3）===')
    modelStats.slice(0, 3).forEach(model => {
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

def query_usage(key_name):
    """查询 API Key 用量"""
    params = {'key_name': key_name}
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
    result = query_usage('MyApp')
    print(f"总费用: ${result['data']['totalCost']}")
    print(f"费用限制: ${result['data']['totalCostLimit']}")
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

def query_usage_details(key_name):
    """查询 API Key 用量明细"""
    params = {'key_name': key_name}
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
    result = query_usage_details('MyApp')
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
function queryUsage($keyName) {
    $params = ['key_name' => $keyName];
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
    $result = queryUsage('MyApp');
    echo "查询成功:\n";
    echo "总费用: $" . $result['data']['totalCost'] . "\n";
    echo "费用限制: $" . $result['data']['totalCostLimit'] . "\n";
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
function queryUsageDetails($keyName) {
    $params = ['key_name' => $keyName];
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
    $result = queryUsageDetails('MyApp');
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
KEY_NAME="MyApp"

# 构建参数（按 key 排序）
SIGN_STR="key_name=${KEY_NAME}"

# 追加密钥
SIGN_STR="${SIGN_STR}${SECRET_KEY}"

# 生成签名（SHA256 并转大写）
SIGNATURE=$(echo -n "$SIGN_STR" | openssl dgst -sha256 | awk '{print toupper($2)}')

# 构建请求体（包含签名）
BODY="{\"key_name\":\"$KEY_NAME\",\"sign\":\"$SIGNATURE\"}"

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
KEY_NAME="MyApp"

# 构建参数（按 key 排序）
SIGN_STR="key_name=${KEY_NAME}"

# 追加密钥
SIGN_STR="${SIGN_STR}${SECRET_KEY}"

# 生成签名（SHA256 并转大写）
SIGNATURE=$(echo -n "$SIGN_STR" | openssl dgst -sha256 | awk '{print toupper($2)}')

# 构建请求体（包含签名）
BODY="{\"key_name\":\"$KEY_NAME\",\"sign\":\"$SIGNATURE\"}"

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
| 1001 | 400         | 缺少必需参数 key_name                    |
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
