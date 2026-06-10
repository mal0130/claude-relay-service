const GLM_DEFAULT_BASE_API = 'https://open.bigmodel.cn/api/paas/v4'
const GLM_DEFAULT_MODEL = 'glm-4-flash'

const GLM_PLATFORM = {
  key: 'glm',
  label: 'GLM (智谱AI)',
  routePrefix: '/glm',
  permission: 'glm',
  accountType: 'glm',
  accountSubType: 'glm-api',
  accountSubTypeLabel: '标准 API',
  protocol: 'openai-compatible-chat',
  protocols: ['openai-compatible-chat', 'anthropic-messages'],
  chatPath: '/chat/completions',
  anthropicMessagesPath: '/anthropic/v1/messages',
  modelPatterns: ['glm-*'],
  modelAliases: {},
  capabilities: {
    stream: true,
    tools: true,
    jsonOutput: true,
    reasoning: false,
    promptCacheUsage: false,
    includeUsageInStream: true
  }
}

function normalizeBaseApi(baseApi = GLM_DEFAULT_BASE_API) {
  const value = String(baseApi || GLM_DEFAULT_BASE_API).trim()
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function buildChatCompletionsUrl(baseApi) {
  return `${normalizeBaseApi(baseApi)}${GLM_PLATFORM.chatPath}`
}

function buildAnthropicMessagesUrl(baseApi) {
  const normalized = normalizeBaseApi(baseApi)

  if (normalized.endsWith('/anthropic/v1/messages')) {
    return normalized
  }

  if (normalized.endsWith('/anthropic/v1')) {
    return `${normalized}/messages`
  }

  if (normalized.endsWith('/anthropic')) {
    return `${normalized}/v1/messages`
  }

  if (normalized.endsWith('/v4')) {
    return `${normalized.slice(0, -3)}${GLM_PLATFORM.anthropicMessagesPath}`
  }

  return `${normalized}${GLM_PLATFORM.anthropicMessagesPath}`
}

function isGlmModel(model) {
  if (typeof model !== 'string') {
    return false
  }
  const lower = model.toLowerCase()
  return lower.startsWith('glm-') || lower.startsWith('z-ai/')
}

function normalizeGlmModel(model) {
  if (!model || typeof model !== 'string') {
    return GLM_DEFAULT_MODEL
  }
  return GLM_PLATFORM.modelAliases[model] || model
}

function normalizeGlmUsage(usage = {}) {
  const cacheReadTokens = Number(
    usage.prompt_cache_hit_tokens || usage.prompt_tokens_details?.cached_tokens || 0
  )
  const totalInputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0)
  return {
    input_tokens: cacheReadTokens > 0 ? Math.max(0, totalInputTokens - cacheReadTokens) : totalInputTokens,
    output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheReadTokens
  }
}

function normalizeGlmAnthropicUsage(usage = {}) {
  const cacheCreation =
    usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null
  const cacheCreationInputTokens =
    Number(usage.cache_creation_input_tokens || 0) ||
    Number(cacheCreation?.ephemeral_5m_input_tokens || 0) +
      Number(cacheCreation?.ephemeral_1h_input_tokens || 0)

  return {
    input_tokens: Number(usage.input_tokens || usage.prompt_tokens || 0),
    output_tokens: Number(usage.output_tokens || usage.completion_tokens || 0),
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: Number(
      usage.cache_read_input_tokens || usage.prompt_cache_hit_tokens || 0
    ),
    ...(cacheCreation ? { cache_creation: cacheCreation } : {})
  }
}

module.exports = {
  GLM_PLATFORM,
  GLM_DEFAULT_BASE_API,
  GLM_DEFAULT_MODEL,
  normalizeBaseApi,
  buildChatCompletionsUrl,
  buildAnthropicMessagesUrl,
  isGlmModel,
  normalizeGlmModel,
  normalizeGlmUsage,
  normalizeGlmAnthropicUsage
}
