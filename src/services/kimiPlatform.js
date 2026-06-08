const KIMI_DEFAULT_BASE_API = 'https://api.moonshot.cn'
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
  protocols: ['openai-compatible-chat'],
  chatPath: '/v1/chat/completions',
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

function isKimiModel(model) {
  return (
    typeof model === 'string' &&
    (model.toLowerCase().startsWith('moonshot-') || model.toLowerCase().startsWith('kimi-'))
  )
}

function normalizeKimiModel(model) {
  if (!model || typeof model !== 'string') {
    return KIMI_DEFAULT_MODEL
  }
  return KIMI_PLATFORM.modelAliases[model] || model
}

function normalizeKimiUsage(usage = {}) {
  return {
    input_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  }
}

module.exports = {
  KIMI_PLATFORM,
  KIMI_DEFAULT_BASE_API,
  KIMI_DEFAULT_MODEL,
  normalizeBaseApi,
  buildChatCompletionsUrl,
  isKimiModel,
  normalizeKimiModel,
  normalizeKimiUsage
}
