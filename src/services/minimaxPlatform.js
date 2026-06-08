const MINIMAX_DEFAULT_BASE_API = 'https://api.minimaxi.com/v1'
const MINIMAX_DEFAULT_MODEL = 'MiniMax-M3'

const MINIMAX_PLATFORM = {
  key: 'minimax',
  label: 'MiniMax',
  routePrefix: '/minimax',
  permission: 'minimax',
  accountType: 'minimax',
  accountSubType: 'minimax-api',
  accountSubTypeLabel: '标准 API',
  protocol: 'openai-compatible-chat',
  protocols: ['openai-compatible-chat', 'anthropic-messages'],
  chatPath: '/chat/completions',
  anthropicMessagesPath: '/anthropic/v1/messages',
  modelPatterns: ['minimax-*'],
  modelAliases: {
    'minimax-m3': 'MiniMax-M3',
    'minimax-m2.7': 'MiniMax-M2.7',
    'minimax-m2.7-highspeed': 'MiniMax-M2.7-highspeed',
    'minimax-m2.5': 'MiniMax-M2.5',
    'minimax-m2.5-highspeed': 'MiniMax-M2.5-highspeed',
    'minimax-m2.1': 'MiniMax-M2.1',
    'minimax-m2.1-highspeed': 'MiniMax-M2.1-highspeed',
    'minimax-m2': 'MiniMax-M2'
  },
  capabilities: {
    stream: true,
    tools: true,
    jsonOutput: true,
    reasoning: true,
    promptCacheUsage: true,
    includeUsageInStream: true,
    multimodal: true
  }
}

function normalizeBaseApi(baseApi = MINIMAX_DEFAULT_BASE_API) {
  const value = String(baseApi || MINIMAX_DEFAULT_BASE_API).trim()
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function buildChatCompletionsUrl(baseApi) {
  const normalized = normalizeBaseApi(baseApi)

  if (normalized.endsWith('/chat/completions')) {
    return normalized
  }

  if (normalized.endsWith('/v1')) {
    return `${normalized}${MINIMAX_PLATFORM.chatPath}`
  }

  if (normalized.endsWith('/anthropic')) {
    return `${normalized.slice(0, -11)}/v1/chat/completions`
  }

  return `${normalized}/v1/chat/completions`
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
    return `${normalized.slice(0, -3)}${MINIMAX_PLATFORM.anthropicMessagesPath}`
  }

  return `${normalized}${MINIMAX_PLATFORM.anthropicMessagesPath}`
}

function isMiniMaxModel(model) {
  return typeof model === 'string' && /^minimax-/i.test(model)
}

function normalizeMiniMaxModel(model) {
  if (!model || typeof model !== 'string') {
    return MINIMAX_DEFAULT_MODEL
  }

  const normalized = MINIMAX_PLATFORM.modelAliases[model] || model
  return normalized
}

function normalizeMiniMaxUsage(usage = {}) {
  return {
    input_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    cache_creation_input_tokens: Number(usage.cache_creation_input_tokens || 0),
    cache_read_input_tokens: Number(
      usage.cache_read_input_tokens || usage.prompt_cache_hit_tokens || 0
    )
  }
}

function normalizeMiniMaxAnthropicUsage(usage = {}) {
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
  MINIMAX_PLATFORM,
  MINIMAX_DEFAULT_BASE_API,
  MINIMAX_DEFAULT_MODEL,
  normalizeBaseApi,
  buildChatCompletionsUrl,
  buildAnthropicMessagesUrl,
  isMiniMaxModel,
  normalizeMiniMaxModel,
  normalizeMiniMaxUsage,
  normalizeMiniMaxAnthropicUsage
}
