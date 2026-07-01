# `uni_agent_subscription_user_id` 解密说明

本文只说明当前项目中 `uni_agent_subscription_user_id` 的真实处理方式，方便在其它语言项目中复刻，尤其是 Go。

## 代码位置

- 真实解密逻辑：`src/middleware/auth.js`
- header 透传过滤：`src/utils/headerFilter.js`

注意：

- `headerFilter.js` 只是把 `uni_agent_subscription_user_id` 从转发到上游的请求头里移除
- 真正的解密和企业版成员 UID 提取发生在 `auth.js`

## 当前实现结论

`uni_agent_subscription_user_id` 不是明文 uid。

服务端会按下面的顺序处理：

1. 从请求头读取 `uni_agent_subscription_user_id`
2. 对 header 值做 Base64 解码
3. 使用 `AES-128-CBC` 解密
4. 将结果转成 UTF-8 字符串
5. 取明文里 `|` 前的第一段
6. 对结果做 `trim()`

最终拿到的值才是企业成员 uid。

## 密钥来源

来自环境变量：

- `ENTERPRISE_USER_ID_AES_KEY`
- `ENTERPRISE_USER_ID_AES_IV`

对应配置位置：

- `config/config.js`

关键细节：

- 这里的 `key` 和 `iv` 是直接按原始字符串字节使用
- 不是把环境变量当 hex 解码
- 也不是把环境变量当 base64 解码

Node 当前实现等价于：

```js
const key = Buffer.from(process.env.ENTERPRISE_USER_ID_AES_KEY)
const iv = Buffer.from(process.env.ENTERPRISE_USER_ID_AES_IV)
```

这意味着：

- `key` 必须正好是 16 字节
- `iv` 必须正好是 16 字节

## Node 侧等价逻辑

```js
function extractEnterpriseUserId(encryptedUserId) {
  const key = Buffer.from(process.env.ENTERPRISE_USER_ID_AES_KEY)
  const iv = Buffer.from(process.env.ENTERPRISE_USER_ID_AES_IV)
  const encrypted = Buffer.from(encryptedUserId, 'base64')

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])

  return decrypted.toString('utf8').split('|')[0].trim()
}
```

## 明文格式

当前代码不是直接使用整段明文，而是：

```txt
明文.split('|')[0].trim()
```

所以如果明文是：

```txt
123456|foo|bar
```

最终使用的企业成员 uid 是：

```txt
123456
```

## Go 重写时必须保持一致的点

1. header 输入先做标准 Base64 解码
2. 算法固定为 `AES-128-CBC`
3. `key` 和 `iv` 直接使用环境变量原始字节
4. CBC 解密后要做 `PKCS#7` 去 padding
5. 最终只取 `|` 前第一段，再做空白裁剪
6. 任一步失败时，都应视为无效 user id

## Go 参考实现

```go
package enterpriseuid

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"fmt"
	"strings"
)

func ExtractEnterpriseUserID(encryptedB64, keyValue, ivValue string) (string, error) {
	key := []byte(keyValue)
	iv := []byte(ivValue)

	if len(key) != 16 {
		return "", fmt.Errorf("invalid AES-128 key length: %d", len(key))
	}
	if len(iv) != aes.BlockSize {
		return "", fmt.Errorf("invalid AES IV length: %d", len(iv))
	}

	ciphertext, err := base64.StdEncoding.DecodeString(encryptedB64)
	if err != nil {
		return "", fmt.Errorf("base64 decode failed: %w", err)
	}
	if len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return "", fmt.Errorf("invalid ciphertext length")
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher failed: %w", err)
	}

	plaintext := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plaintext, ciphertext)

	plaintext, err = pkcs7Unpad(plaintext, aes.BlockSize)
	if err != nil {
		return "", fmt.Errorf("pkcs7 unpad failed: %w", err)
	}

	parts := strings.SplitN(strings.TrimSpace(string(plaintext)), "|", 2)
	return strings.TrimSpace(parts[0]), nil
}

func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, fmt.Errorf("invalid padded data length")
	}

	padding := int(data[len(data)-1])
	if padding == 0 || padding > blockSize || padding > len(data) {
		return nil, fmt.Errorf("invalid padding size")
	}

	for _, b := range data[len(data)-padding:] {
		if int(b) != padding {
			return nil, fmt.Errorf("invalid padding content")
		}
	}

	return data[:len(data)-padding], nil
}
```

## 对拍样例

示例参数：

- `key = "1234567890abcdef"`
- `iv = "abcdef1234567890"`
- 明文 = `user123|extra`

用 Node 加密后可得到：

```txt
odjDnOKzLZ3DFo6eg1KC5g==
```

用当前逻辑解密后：

- 完整明文：`user123|extra`
- 最终提取 uid：`user123`

## 失败时的现网行为

在当前项目里，如果：

- 没传 `uni_agent_subscription_user_id`
- 解密失败
- 解密后拿不到有效 uid

企业版请求会在鉴权阶段被拦截，并返回：

- `missing_user_id`
- `invalid_user_id`

对应逻辑位置：

- `src/middleware/auth.js`

## 补充说明

虽然部分早期设计文档把 `uni_agent_subscription_user_id` 写成“uid 字符串”，但当前代码实际要求的是加密后的 header 值，重写时应以 `src/middleware/auth.js` 为准。
