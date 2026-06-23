const DEEPSEEK_DEFAULT_BASE_API = 'https://api.deepseek.com'
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

const DEEPSEEK_PLATFORM = {
  key: 'deepseek',
  label: 'DeepSeek',
  routePrefix: '/deepseek',
  permission: 'deepseek',
  accountType: 'deepseek',
  accountSubType: 'deepseek-api',
  accountSubTypeLabel: '标准 API',
  protocol: 'openai-compatible-chat',
  protocols: ['openai-compatible-chat', 'anthropic-messages'],
  chatPath: '/chat/completions',
  anthropicMessagesPath: '/anthropic/v1/messages',
  modelPatterns: ['deepseek-*'],
  modelAliases: {
    'deepseek-chat': 'deepseek-v4-flash',
    'deepseek-reasoner': 'deepseek-v4-flash'
  },
  capabilities: {
    stream: true,
    tools: true,
    jsonOutput: true,
    reasoning: true,
    promptCacheUsage: true,
    includeUsageInStream: true
  }
}

function normalizeBaseApi(baseApi = DEEPSEEK_DEFAULT_BASE_API) {
  const value = String(baseApi || DEEPSEEK_DEFAULT_BASE_API).trim()
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function buildChatCompletionsUrl(baseApi) {
  return `${normalizeBaseApi(baseApi)}${DEEPSEEK_PLATFORM.chatPath}`
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

  if (normalized.endsWith('/v1')) {
    return `${normalized.slice(0, -3)}${DEEPSEEK_PLATFORM.anthropicMessagesPath}`
  }

  return `${normalized}${DEEPSEEK_PLATFORM.anthropicMessagesPath}`
}

function isDeepSeekModel(model) {
  return typeof model === 'string' && model.toLowerCase().startsWith('deepseek-')
}

function normalizeDeepSeekModel(model) {
  if (!model || typeof model !== 'string') {
    return DEEPSEEK_DEFAULT_MODEL
  }
  return DEEPSEEK_PLATFORM.modelAliases[model] || model
}

function normalizeDeepSeekUsage(usage = {}) {
  const hitTokens = Number(
    usage.prompt_cache_hit_tokens ||
      usage.cache_read_tokens ||
      usage.prompt_tokens_details?.cached_tokens ||
      0
  )
  const missTokens = Number(usage.prompt_cache_miss_tokens || 0)
  const hasCacheBreakdown = hitTokens > 0 || missTokens > 0

  return {
    input_tokens: hasCacheBreakdown
      ? Math.max(
          0,
          missTokens || Number(usage.prompt_tokens || usage.input_tokens || 0) - hitTokens
        )
      : Number(usage.prompt_tokens || usage.input_tokens || 0),
    output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: Math.max(0, hitTokens)
  }
}

function normalizeDeepSeekAnthropicUsage(usage = {}) {
  const hitTokens = Number(usage.cache_read_input_tokens || usage.prompt_cache_hit_tokens || 0)
  const missTokens = Number(usage.prompt_cache_miss_tokens || 0)
  const cacheCreation =
    usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null
  const cacheCreationInputTokens =
    Number(usage.cache_creation_input_tokens || 0) ||
    Number(cacheCreation?.ephemeral_5m_input_tokens || 0) +
      Number(cacheCreation?.ephemeral_1h_input_tokens || 0)

  return {
    input_tokens:
      missTokens > 0 ? missTokens : Number(usage.input_tokens || usage.prompt_tokens || 0),
    output_tokens: Number(usage.output_tokens || usage.completion_tokens || 0),
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: Math.max(0, hitTokens),
    ...(cacheCreation ? { cache_creation: cacheCreation } : {})
  }
}

module.exports = {
  DEEPSEEK_PLATFORM,
  DEEPSEEK_DEFAULT_BASE_API,
  DEEPSEEK_DEFAULT_MODEL,
  normalizeBaseApi,
  buildChatCompletionsUrl,
  buildAnthropicMessagesUrl,
  isDeepSeekModel,
  normalizeDeepSeekModel,
  normalizeDeepSeekUsage,
  normalizeDeepSeekAnthropicUsage
}
