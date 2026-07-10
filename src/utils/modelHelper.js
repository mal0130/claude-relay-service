/**
 * Model Helper Utility
 *
 * Provides utilities for parsing vendor-prefixed model names.
 * Supports parsing model strings like "ccr,model_name" to extract vendor type and base model.
 */

// 仅保留原仓库既有的模型前缀：CCR 路由
// Gemini/Antigravity 采用“路径分流”，避免在 model 字段里混入 vendor 前缀造成混乱
const SUPPORTED_VENDOR_PREFIXES = ['ccr']

/**
 * Parse vendor-prefixed model string
 * @param {string} modelStr - Model string, potentially with vendor prefix (e.g., "ccr,gemini-2.5-pro")
 * @returns {{vendor: string|null, baseModel: string}} - Parsed vendor and base model
 */
function parseVendorPrefixedModel(modelStr) {
  if (!modelStr || typeof modelStr !== 'string') {
    return { vendor: null, baseModel: modelStr || '' }
  }

  // Trim whitespace and convert to lowercase for comparison
  const trimmed = modelStr.trim()
  const lowerTrimmed = trimmed.toLowerCase()

  for (const vendorPrefix of SUPPORTED_VENDOR_PREFIXES) {
    if (!lowerTrimmed.startsWith(`${vendorPrefix},`)) {
      continue
    }

    const parts = trimmed.split(',')
    if (parts.length < 2) {
      break
    }

    // Extract base model (everything after the first comma, rejoined in case model name contains commas)
    const baseModel = parts.slice(1).join(',').trim()
    return {
      vendor: vendorPrefix,
      baseModel
    }
  }

  // No recognized vendor prefix found
  return {
    vendor: null,
    baseModel: trimmed
  }
}

/**
 * Check if a model string has a vendor prefix
 * @param {string} modelStr - Model string to check
 * @returns {boolean} - True if the model has a vendor prefix
 */
function hasVendorPrefix(modelStr) {
  const { vendor } = parseVendorPrefixedModel(modelStr)
  return vendor !== null
}

/**
 * Get the effective model name for scheduling and processing
 * This removes vendor prefixes to get the actual model name used for API calls
 * @param {string} modelStr - Original model string
 * @returns {string} - Effective model name without vendor prefix
 */
function getEffectiveModel(modelStr) {
  const { baseModel } = parseVendorPrefixedModel(modelStr)
  return baseModel
}

/**
 * Get the vendor type from a model string
 * @param {string} modelStr - Model string to parse
 * @returns {string|null} - Vendor type ('ccr') or null if no prefix
 */
function getVendorType(modelStr) {
  const { vendor } = parseVendorPrefixedModel(modelStr)
  return vendor
}

/**
 * Check if the model is Opus 4.5 or newer.
 *
 * VERSION LOGIC (as of 2025-12-05):
 * - Opus 4.5+ (including 5.0, 6.0, etc.) → returns true (Pro account eligible)
 * - Opus 4.4 and below (including 3.x, 4.0, 4.1) → returns false (Max account only)
 *
 * Supported naming formats:
 *   - New format: claude-opus-{major}[-{minor}][-date], e.g., claude-opus-4-5-20251101
 *   - New format: claude-opus-{major}.{minor}, e.g., claude-opus-4.5
 *   - Old format: claude-{version}-opus[-date], e.g., claude-3-opus-20240229
 *   - Special: opus-latest, claude-opus-latest → always returns true
 *
 * @param {string} modelName - Model name
 * @returns {boolean} - Whether the model is Opus 4.5 or newer
 */
function isOpus45OrNewer(modelName) {
  if (!modelName) {
    return false
  }

  const lowerModel = modelName.toLowerCase()
  if (!lowerModel.includes('opus')) {
    return false
  }

  // Handle 'latest' special case
  if (lowerModel.includes('opus-latest') || lowerModel.includes('opus_latest')) {
    return true
  }

  // Old format: claude-{version}-opus (version before opus)
  // e.g., claude-3-opus-20240229, claude-3.5-opus
  const oldFormatMatch = lowerModel.match(/claude[- ](\d+)(?:[.-](\d+))?[- ]opus/)
  if (oldFormatMatch) {
    const majorVersion = parseInt(oldFormatMatch[1], 10)
    const minorVersion = oldFormatMatch[2] ? parseInt(oldFormatMatch[2], 10) : 0

    // Old format version refers to Claude major version
    // majorVersion > 4: 5.x, 6.x, ... → true
    // majorVersion === 4 && minorVersion >= 5: 4.5, 4.6, ... → true
    // Others (3.x, 4.0-4.4): → false
    if (majorVersion > 4) {
      return true
    }
    if (majorVersion === 4 && minorVersion >= 5) {
      return true
    }
    return false
  }

  // New format 1: opus-{major}.{minor} (dot-separated)
  // e.g., claude-opus-4.5, opus-4.5
  const dotFormatMatch = lowerModel.match(/opus[- ]?(\d+)\.(\d+)/)
  if (dotFormatMatch) {
    const majorVersion = parseInt(dotFormatMatch[1], 10)
    const minorVersion = parseInt(dotFormatMatch[2], 10)

    // Same version logic as old format
    // opus-5.0, opus-6.0 → true
    // opus-4.5, opus-4.6 → true
    // opus-4.0, opus-4.4 → false
    if (majorVersion > 4) {
      return true
    }
    if (majorVersion === 4 && minorVersion >= 5) {
      return true
    }
    return false
  }

  // New format 2: opus-{major}[-{minor}][-date] (hyphen-separated)
  // e.g., claude-opus-4-5-20251101, claude-opus-4-20250514, claude-opus-4-1-20250805
  // If opus-{major} is followed by 8-digit date, there's no minor version

  // Extract content after 'opus'
  const opusIndex = lowerModel.indexOf('opus')
  const afterOpus = lowerModel.substring(opusIndex + 4)

  // Match: -{major}-{minor}-{date} or -{major}-{date} or -{major}
  // IMPORTANT: Minor version regex is (\d{1,2}) not (\d+)
  // This prevents matching 8-digit dates as minor version
  // Example: opus-4-20250514 → major=4, minor=undefined (not 20250514)
  // Example: opus-4-5-20251101 → major=4, minor=5
  // Future-proof: Supports up to 2-digit minor versions (0-99)
  const versionMatch = afterOpus.match(/^[- ](\d+)(?:[- ](\d{1,2})(?=[- ]\d{8}|$))?/)

  if (versionMatch) {
    const majorVersion = parseInt(versionMatch[1], 10)
    const minorVersion = versionMatch[2] ? parseInt(versionMatch[2], 10) : 0

    // Same version logic: >= 4.5 returns true
    // opus-5-0-date, opus-6-date → true
    // opus-4-5-date, opus-4-10-date → true (supports 2-digit minor)
    // opus-4-date (no minor, treated as 4.0) → false
    // opus-4-1-date, opus-4-4-date → false
    if (majorVersion > 4) {
      return true
    }
    if (majorVersion === 4 && minorVersion >= 5) {
      return true
    }
    return false
  }

  // Other cases containing 'opus' but cannot parse version, assume legacy
  return false
}

/**
 * 判断某个 model 名称是否属于 Anthropic Claude 系列模型。
 *
 * 用于 API Key 维度的限额/统计（Claude 周费用）。这里刻意覆盖以下命名：
 * - 标准 Anthropic 模型：claude-*，包括 claude-3-opus、claude-sonnet-*、claude-haiku-* 等
 * - Bedrock 模型：{region}.anthropic.claude-... / anthropic.claude-...
 * - 少数情况下 model 字段可能只包含家族关键词（sonnet/haiku/opus），也视为 Claude 系列
 *
 * 注意：会先去掉支持的 vendor 前缀（例如 "ccr,"）。
 */
function isClaudeFamilyModel(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return false
  }

  const { baseModel } = parseVendorPrefixedModel(modelName)
  const m = (baseModel || '').trim().toLowerCase()
  if (!m) {
    return false
  }

  // Bedrock 模型格式
  if (
    m.includes('.anthropic.claude-') ||
    m.startsWith('anthropic.claude-') ||
    m.includes('.claude-')
  ) {
    return true
  }

  // 标准 Anthropic 模型 ID
  if (m.startsWith('claude-') || m.includes('claude-')) {
    return true
  }

  // 兜底：某些下游链路里 model 字段可能不带 "claude-" 前缀，但仍包含家族关键词。
  if (m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) {
    return true
  }

  return false
}

function normalizeClaudeModelName(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return ''
  }

  const { baseModel } = parseVendorPrefixedModel(modelName)
  return (baseModel || '').trim().toLowerCase().replace(/_/g, '-')
}

function parseClaudeModelVersion(modelName) {
  const normalized = normalizeClaudeModelName(modelName)
  if (!normalized) {
    return null
  }

  const oldFormatMatch = normalized.match(
    /claude[- ](\d+)(?:[-.](\d{1,2}))?[- ](opus|sonnet|haiku)/
  )
  if (oldFormatMatch) {
    return {
      family: oldFormatMatch[3],
      major: Number.parseInt(oldFormatMatch[1], 10),
      minor: oldFormatMatch[2] ? Number.parseInt(oldFormatMatch[2], 10) : 0,
      normalized
    }
  }

  const family = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'].find((candidate) =>
    normalized.includes(candidate)
  )

  if (!family) {
    return null
  }

  const familyIndex = normalized.indexOf(family)
  const afterFamily = normalized.slice(familyIndex + family.length)
  const versionMatch = afterFamily.match(/^[- ](\d+)(?:[-.](\d{1,2})(?=$|[-.:]))?/)

  if (!versionMatch) {
    return {
      family,
      major: null,
      minor: null,
      normalized
    }
  }

  return {
    family,
    major: Number.parseInt(versionMatch[1], 10),
    minor: versionMatch[2] ? Number.parseInt(versionMatch[2], 10) : 0,
    normalized
  }
}

function isClaudeAdaptiveThinkingOnlyModel(modelName) {
  const version = parseClaudeModelVersion(modelName)
  if (!version || !Number.isInteger(version.major)) {
    return false
  }

  if ((version.family === 'fable' || version.family === 'mythos') && version.major >= 5) {
    return true
  }

  if (version.family === 'sonnet' && version.major >= 5) {
    return true
  }

  if (version.family === 'opus') {
    if (version.major > 4) {
      return true
    }
    return version.major === 4 && version.minor >= 7
  }

  return false
}

function isClaudeAlwaysOnAdaptiveThinkingModel(modelName) {
  const version = parseClaudeModelVersion(modelName)
  if (!version) {
    return false
  }

  if (version.normalized.includes('mythos-preview')) {
    return true
  }

  return (
    Number.isInteger(version.major) &&
    (version.family === 'fable' || version.family === 'mythos') &&
    version.major >= 5
  )
}

function prefersClaudeAdaptiveThinking(modelName) {
  const version = parseClaudeModelVersion(modelName)
  if (!version || !Number.isInteger(version.major)) {
    return false
  }

  return (
    (version.family === 'opus' || version.family === 'sonnet') &&
    version.major === 4 &&
    version.minor === 6
  )
}

function supportsClaudeAdaptiveThinking(modelName) {
  return (
    isClaudeAdaptiveThinkingOnlyModel(modelName) ||
    isClaudeAlwaysOnAdaptiveThinkingModel(modelName) ||
    prefersClaudeAdaptiveThinking(modelName)
  )
}

function isClaudeSamplingRestrictedModel(modelName) {
  const version = parseClaudeModelVersion(modelName)
  if (!version) {
    return false
  }

  if (version.normalized.includes('mythos-preview')) {
    return true
  }

  if (!Number.isInteger(version.major)) {
    return false
  }

  if (version.family === 'fable' || version.family === 'mythos') {
    return version.major >= 5
  }

  if (version.family === 'sonnet') {
    return version.major >= 5
  }

  if (version.family === 'opus') {
    if (version.major > 4) {
      return true
    }
    return version.major === 4 && version.minor >= 7
  }

  return false
}

function normalizeClaudeSamplingForModel(body) {
  const result = {
    changed: false,
    removedFields: []
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return result
  }

  if (!isClaudeSamplingRestrictedModel(body.model)) {
    return result
  }

  const samplingFields = ['temperature', 'top_p', 'top_k']
  samplingFields.forEach((field) => {
    if (body[field] !== undefined) {
      delete body[field]
      result.changed = true
      result.removedFields.push(field)
    }
  })

  return result
}

function supportsClaudeManualThinkingBudget(modelName) {
  const version = parseClaudeModelVersion(modelName)
  if (!version) {
    return false
  }

  if (version.normalized.includes('mythos-preview')) {
    return true
  }

  if (!Number.isInteger(version.major)) {
    return false
  }

  if (isClaudeAdaptiveThinkingOnlyModel(modelName)) {
    return false
  }

  if (version.family === 'sonnet' && version.major === 3) {
    return version.minor >= 7
  }

  if (version.family === 'opus' || version.family === 'sonnet' || version.family === 'haiku') {
    return version.major === 4
  }

  return false
}

const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max', 'xhigh'])

function isClaudeEffortSupportedModel(modelName) {
  const version = parseClaudeModelVersion(modelName)
  if (!version) {
    return false
  }

  if (version.normalized.includes('mythos-preview')) {
    return true
  }

  if (!Number.isInteger(version.major)) {
    return false
  }

  if (version.family === 'fable' || version.family === 'mythos') {
    return version.major === 5
  }

  if (version.family === 'sonnet') {
    return version.major === 5 || (version.major === 4 && version.minor === 6)
  }

  if (version.family === 'opus') {
    return version.major === 4 && version.minor >= 5 && version.minor <= 8
  }

  return false
}

function supportsClaudeEffortLevel(modelName, effort) {
  const normalizedEffort = normalizeClaudeEffort(effort)
  if (!normalizedEffort) {
    return false
  }

  const version = parseClaudeModelVersion(modelName)
  if (!version || !isClaudeEffortSupportedModel(modelName)) {
    return false
  }

  if (normalizedEffort === 'low' || normalizedEffort === 'medium' || normalizedEffort === 'high') {
    return true
  }

  if (normalizedEffort === 'max') {
    if (version.normalized.includes('mythos-preview')) {
      return true
    }

    if ((version.family === 'fable' || version.family === 'mythos') && version.major === 5) {
      return true
    }

    if (version.family === 'sonnet') {
      return version.major === 5 || (version.major === 4 && version.minor === 6)
    }

    return version.family === 'opus' && version.major === 4 && version.minor >= 6
  }

  if (normalizedEffort === 'xhigh') {
    if ((version.family === 'fable' || version.family === 'mythos') && version.major === 5) {
      return true
    }

    if (version.family === 'sonnet') {
      return version.major === 5
    }

    return version.family === 'opus' && version.major === 4 && version.minor >= 7
  }

  return false
}

function normalizeClaudeEffort(value) {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  return CLAUDE_EFFORT_LEVELS.has(normalized) ? normalized : null
}

function normalizeClaudeEffortForModel(modelName, value) {
  const normalized = normalizeClaudeEffort(value)
  if (!normalized) {
    return null
  }

  if (supportsClaudeEffortLevel(modelName, normalized)) {
    return normalized
  }

  return isClaudeEffortSupportedModel(modelName) ? 'high' : null
}

function mapClaudeThinkingBudgetToEffort(budgetTokens) {
  const budget = Number(budgetTokens)
  if (!Number.isFinite(budget) || budget <= 0) {
    return null
  }

  if (budget < 4096) {
    return 'low'
  }
  if (budget < 8192) {
    return 'medium'
  }
  if (budget < 16384) {
    return 'high'
  }
  return 'max'
}

function getClaudeOutputConfig(body) {
  return body?.output_config &&
    typeof body.output_config === 'object' &&
    !Array.isArray(body.output_config)
    ? body.output_config
    : null
}

function setClaudeOutputConfigEffort(body, effort) {
  if (!body || !effort) {
    return false
  }

  const outputConfig = getClaudeOutputConfig(body)
  const nextOutputConfig = {
    ...(outputConfig || {}),
    effort
  }

  const changed =
    body.output_config !== outputConfig ||
    !outputConfig ||
    outputConfig.effort !== nextOutputConfig.effort

  body.output_config = nextOutputConfig
  return changed
}

function normalizeClaudeThinkingForModel(body, options = {}) {
  const { migrateDeprecatedManualThinking = true } = options

  const result = {
    changed: false,
    reason: null
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return result
  }

  const outputConfig = getClaudeOutputConfig(body)
  const rawEffort = outputConfig?.effort ?? body.effort
  const normalizedRawEffort = normalizeClaudeEffort(rawEffort)
  const normalizedEffort = normalizeClaudeEffortForModel(body.model, rawEffort)

  if (body.effort !== undefined) {
    delete body.effort
    result.changed = true
  }

  if (normalizedEffort) {
    result.changed = setClaudeOutputConfigEffort(body, normalizedEffort) || result.changed
    if (normalizedRawEffort && normalizedRawEffort !== normalizedEffort && !result.reason) {
      result.reason = 'effort_level_unsupported'
    }
  } else if (outputConfig?.effort !== undefined) {
    delete outputConfig.effort
    if (Object.keys(outputConfig).length === 0) {
      delete body.output_config
    }
    result.changed = true
    if (normalizedRawEffort && !result.reason) {
      result.reason = 'effort_model_unsupported'
    }
  }

  const { thinking } = body
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) {
    return result
  }

  const thinkingType = typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : ''
  if (thinkingType === 'disabled' && isClaudeAlwaysOnAdaptiveThinkingModel(body.model)) {
    delete body.thinking
    result.changed = true
    result.reason = 'thinking_disabled_unsupported'
    return result
  }

  const shouldUseAdaptive =
    isClaudeAdaptiveThinkingOnlyModel(body.model) ||
    (migrateDeprecatedManualThinking && prefersClaudeAdaptiveThinking(body.model))

  if (thinkingType === 'enabled' && shouldUseAdaptive) {
    const mappedEffort =
      normalizedEffort ||
      normalizeClaudeEffortForModel(
        body.model,
        mapClaudeThinkingBudgetToEffort(thinking.budget_tokens)
      )
    body.thinking = {
      ...thinking,
      type: 'adaptive'
    }
    delete body.thinking.budget_tokens

    if (mappedEffort && !normalizedEffort) {
      result.changed = setClaudeOutputConfigEffort(body, mappedEffort) || result.changed
    }

    result.changed = true
    result.reason = isClaudeAdaptiveThinkingOnlyModel(body.model)
      ? 'manual_thinking_unsupported'
      : 'manual_thinking_deprecated'
    return result
  }

  if (thinkingType === 'adaptive') {
    if (!supportsClaudeAdaptiveThinking(body.model)) {
      if (thinking.budget_tokens !== undefined && supportsClaudeManualThinkingBudget(body.model)) {
        body.thinking = {
          ...thinking,
          type: 'enabled'
        }
      } else {
        delete body.thinking
      }

      result.changed = true
      result.reason = result.reason || 'adaptive_thinking_unsupported'
      return result
    }

    if (thinking.type !== 'adaptive') {
      body.thinking = {
        ...thinking,
        type: 'adaptive'
      }
      result.changed = true
    }

    if (body.thinking.budget_tokens !== undefined) {
      const mappedEffort =
        normalizeClaudeEffortForModel(body.model, getClaudeOutputConfig(body)?.effort) ||
        normalizeClaudeEffortForModel(
          body.model,
          mapClaudeThinkingBudgetToEffort(body.thinking.budget_tokens)
        )
      delete body.thinking.budget_tokens
      if (mappedEffort && !normalizeClaudeEffort(getClaudeOutputConfig(body)?.effort)) {
        result.changed = setClaudeOutputConfigEffort(body, mappedEffort) || result.changed
      }
      result.changed = true
      result.reason = 'adaptive_thinking_budget_removed'
    }
  }

  return result
}

module.exports = {
  parseVendorPrefixedModel,
  hasVendorPrefix,
  getEffectiveModel,
  getVendorType,
  isOpus45OrNewer,
  isClaudeFamilyModel,
  parseClaudeModelVersion,
  isClaudeAdaptiveThinkingOnlyModel,
  isClaudeAlwaysOnAdaptiveThinkingModel,
  prefersClaudeAdaptiveThinking,
  supportsClaudeAdaptiveThinking,
  isClaudeSamplingRestrictedModel,
  normalizeClaudeSamplingForModel,
  supportsClaudeManualThinkingBudget,
  supportsClaudeEffortLevel,
  normalizeClaudeEffort,
  normalizeClaudeEffortForModel,
  mapClaudeThinkingBudgetToEffort,
  normalizeClaudeThinkingForModel
}
