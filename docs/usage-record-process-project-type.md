# usage 记录中的 `processType` / `projectType` 来源说明

本文说明 usage 记录里 `processType` 和 `projectType` 两个字段的来源、判定规则，以及它们是如何进入 Redis 的。

## 结论

- `processType` 来源于请求头 `uni_agent_agent_type`
- `projectType` 来源于请求体中的 developer/system 指令文本
- 两个字段都不是 `addUsageRecord()` 自己生成的
- 它们先由 `buildUsageMetadata()` 组装进 `extra`
- 再在 `ENABLE_USAGE_DETAIL=true` 时通过 `recordUsage()` / `recordUsageWithDetails()` 一起写入 Redis

## 落库链路

`addUsageRecord()` 本身只是把传入的 `record` 原样写入 Redis：

- `src/models/redis.js`

真正把 `processType` / `projectType` 塞进 usage 记录的是：

- `src/utils/userInputExtractor.js` 中的 `buildUsageMetadata()`
- `src/services/apiKeyService.js` 中的 `...(process.env.ENABLE_USAGE_DETAIL === 'true' ? extra : {})`

对应位置：

- [src/utils/userInputExtractor.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/utils/userInputExtractor.js:245)
- [src/services/apiKeyService.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/services/apiKeyService.js:2111)
- [src/services/apiKeyService.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/services/apiKeyService.js:2381)

## `processType` 来源

### 取值位置

`processType` 由 `extractProcessType(headers)` 提取：

- [src/utils/userInputExtractor.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/utils/userInputExtractor.js:236)

等价逻辑：

```js
const raw = headers['uni_agent_agent_type']
if (typeof raw !== 'string') {
  return null
}

return raw.trim().toLowerCase()
```

### 规则

- 来源 header：`uni_agent_agent_type`
- 如果 header 不存在或不是字符串，返回 `null`
- 如果存在，则先 `trim()` 再转小写

### 例子

- `primary` -> `primary`
- ` Primary ` -> `primary`
- 未传 -> `null`

### 补充

这个 header 不只用于 usage 记录，也参与了鉴权阶段的主进程判断逻辑：

- [src/middleware/auth.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/middleware/auth.js:414)

## `projectType` 来源

### 取值位置

`projectType` 由 `classifyProjectType(projectTypeBody || body, format)` 计算：

- [src/utils/userInputExtractor.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/utils/userInputExtractor.js:261)
- [src/utils/userInputExtractor.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/utils/userInputExtractor.js:287)

### 分类结果

只会返回三种值：

- `uni-app-x`
- `uni-app`
- `other`

### 匹配规则

会从请求体里的 developer/system 文本中提取字符串，然后逐条匹配：

- 包含 `This is a uni-app x project` -> `uni-app-x`
- 包含 `This is a uni-app project` -> `uni-app`
- 都不匹配 -> `other`

代码里先判断 `uni-app-x`，避免被 `uni-app` 提前吃掉。

### 不同协议的文本来源

#### OpenAI

从 `input` 或 `messages` 中提取 `role='developer'` 或 `role='system'` 的文本：

- [src/utils/userInputExtractor.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/utils/userInputExtractor.js:333)

#### Anthropic / Claude Code

从 `body.system` 中提取文本：

- [src/utils/userInputExtractor.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/utils/userInputExtractor.js:364)

#### Gemini

从 `systemInstruction` 或 `system_instruction` 中提取文本：

- [src/utils/userInputExtractor.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/utils/userInputExtractor.js:381)

## 谁在调用 `buildUsageMetadata()`

这两个字段通常在各路由或 relay 层先组装好，再传给 `apiKeyService.recordUsage()`：

- Claude / Anthropic 路由：
  [src/routes/api.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/routes/api.js:301)
- OpenAI 路由：
  [src/routes/openaiRoutes.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/routes/openaiRoutes.js:788)
- OpenAI Claude 路由：
  [src/routes/openaiClaudeRoutes.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/routes/openaiClaudeRoutes.js:323)
- Gemini handler：
  [src/handlers/geminiHandlers.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/handlers/geminiHandlers.js:583)

## 什么时候会真正写进 Redis

虽然 `buildUsageMetadata()` 总会生成 `processType` / `projectType`，但是否落库还取决于环境变量：

```js
...(process.env.ENABLE_USAGE_DETAIL === 'true' ? extra : {})
```

也就是说：

- `ENABLE_USAGE_DETAIL=true`：会写入 usage 记录
- 其它情况：不会写入 usage 记录

## Redis 中的表现

这两个字段作为 usage record 的普通 JSON 字段存储，没有额外索引，也没有单独 schema。

管理后台读取时会直接从记录里透出：

- [src/routes/admin/usageStats.js](/Users/liyanchao/project/DCloud/claude-relay-service/src/routes/admin/usageStats.js:180)

对应读取逻辑：

```js
processType: record.processType || null,
projectType: record.projectType || null
```

## 一句话总结

- `processType` = 请求头 `uni_agent_agent_type` 的规范化结果
- `projectType` = 请求体 developer/system 提示词分类结果
- 两者都通过 `buildUsageMetadata()` 进入 `extra`
- 只有 `ENABLE_USAGE_DETAIL=true` 时才会随 usage 记录一起写入 Redis
