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
  protocols: ['openai-compatible-chat'],
  chatPath: '/chat/completions',
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

function isGlmModel(model) {
  return typeof model === 'string' && model.toLowerCase().startsWith('glm-')
}

function normalizeGlmModel(model) {
  if (!model || typeof model !== 'string') {
    return GLM_DEFAULT_MODEL
  }
  return GLM_PLATFORM.modelAliases[model] || model
}

function normalizeGlmUsage(usage = {}) {
  return {
    input_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  }
}

module.exports = {
  GLM_PLATFORM,
  GLM_DEFAULT_BASE_API,
  GLM_DEFAULT_MODEL,
  normalizeBaseApi,
  buildChatCompletionsUrl,
  isGlmModel,
  normalizeGlmModel,
  normalizeGlmUsage
}
