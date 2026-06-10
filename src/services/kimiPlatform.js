const KIMI_DEFAULT_BASE_API = 'https://api.moonshot.cn/v1'
const KIMI_DEFAULT_MODEL = 'moonshot-v1-8k'

const KIMI_PLATFORM = {
  key: 'kimi',
  label: 'Kimi (月之暗面)',
  routePrefix: '/kimi',
  permission: 'kimi',
  accountType: 'kimi',
  accountSubType: 'kimi-api',
  accountSubTypeLabel: '标准 API',
  protocol: 'openai-compatible-chat',
  protocols: ['openai-compatible-chat', 'anthropic-messages'],
  chatPath: '/chat/completions',
  anthropicMessagesPath: '/anthropic/v1/messages',
  modelPatterns: ['moonshot-*'],
  modelAliases: {
    'kimi-latest': 'moonshot-v1-128k'
  },
  capabilities: {
    stream: true,
    tools: true,
    jsonOutput: true,
    reasoning: false,
    promptCacheUsage: false,
    includeUsageInStream: false
  }
}

function normalizeBaseApi(baseApi = KIMI_DEFAULT_BASE_API) {
  const value = String(baseApi || KIMI_DEFAULT_BASE_API).trim()
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function buildChatCompletionsUrl(baseApi) {
  return `${normalizeBaseApi(baseApi)}${KIMI_PLATFORM.chatPath}`
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
    return `${normalized.slice(0, -3)}${KIMI_PLATFORM.anthropicMessagesPath}`
  }

  return `${normalized}${KIMI_PLATFORM.anthropicMessagesPath}`
}

function isKimiModel(model) {
  if (typeof model !== 'string') {
    return false
  }
  const lower = model.toLowerCase()
  return (
    lower.startsWith('moonshot-') || lower.startsWith('kimi-') || lower.startsWith('moonshotai/')
  )
}

function normalizeKimiModel(model) {
  if (!model || typeof model !== 'string') {
    return KIMI_DEFAULT_MODEL
  }
  return KIMI_PLATFORM.modelAliases[model] || model
}

function normalizeKimiUsage(usage = {}) {
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

function normalizeKimiAnthropicUsage(usage = {}) {
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
  KIMI_PLATFORM,
  KIMI_DEFAULT_BASE_API,
  KIMI_DEFAULT_MODEL,
  normalizeBaseApi,
  buildChatCompletionsUrl,
  buildAnthropicMessagesUrl,
  isKimiModel,
  normalizeKimiModel,
  normalizeKimiUsage,
  normalizeKimiAnthropicUsage
}
