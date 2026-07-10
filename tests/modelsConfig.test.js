jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const { CLAUDE_MODELS } = require('../config/models')
const {
  isClaudeAdaptiveThinkingOnlyModel,
  prefersClaudeAdaptiveThinking,
  supportsClaudeManualThinkingBudget,
  supportsClaudeEffortLevel,
  normalizeClaudeSamplingForModel,
  normalizeClaudeThinkingForModel
} = require('../src/utils/modelHelper')
const openaiToClaude = require('../src/services/openaiToClaude')

describe('models config', () => {
  it('places Claude Sonnet 4.6 as the second Claude model option', () => {
    expect(CLAUDE_MODELS[1]).toEqual({
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6'
    })
  })
})

describe('Claude thinking compatibility', () => {
  it('classifies adaptive-only and deprecated manual thinking models', () => {
    expect(isClaudeAdaptiveThinkingOnlyModel('claude-sonnet-5')).toBe(true)
    expect(isClaudeAdaptiveThinkingOnlyModel('us.anthropic.claude-opus-4-8-v1:0')).toBe(true)
    expect(isClaudeAdaptiveThinkingOnlyModel('claude-3-5-sonnet-20241022')).toBe(false)
    expect(prefersClaudeAdaptiveThinking('claude-sonnet-4-6')).toBe(true)
    expect(supportsClaudeManualThinkingBudget('claude-sonnet-4-5-20250929')).toBe(true)
    expect(supportsClaudeManualThinkingBudget('claude-sonnet-5')).toBe(false)
    expect(supportsClaudeManualThinkingBudget('claude-3-5-sonnet-20241022')).toBe(false)
    expect(supportsClaudeEffortLevel('claude-sonnet-5', 'xhigh')).toBe(true)
    expect(supportsClaudeEffortLevel('claude-sonnet-4-6', 'xhigh')).toBe(false)
    expect(supportsClaudeEffortLevel('claude-sonnet-4-6', 'medium')).toBe(true)
    expect(supportsClaudeEffortLevel('claude-opus-4-5', 'medium')).toBe(true)
    expect(supportsClaudeEffortLevel('claude-opus-4-5', 'max')).toBe(false)
    expect(supportsClaudeEffortLevel('claude-sonnet-4-5', 'medium')).toBe(false)
    expect(supportsClaudeEffortLevel('claude-haiku-4-5', 'medium')).toBe(false)
  })

  it('normalizes manual thinking to adaptive for models that reject budget_tokens', () => {
    const body = {
      model: 'claude-sonnet-5',
      thinking: {
        type: 'enabled',
        budget_tokens: 8192,
        display: 'summarized'
      }
    }

    const result = normalizeClaudeThinkingForModel(body)

    expect(result).toEqual({
      changed: true,
      reason: 'manual_thinking_unsupported'
    })
    expect(body.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized'
    })
    expect(body.output_config).toEqual({
      effort: 'high'
    })
  })

  it('normalizes Opus 4.8 manual thinking to adaptive with model-aware effort', () => {
    const body = {
      model: 'claude-opus-4-8',
      max_tokens: 32000,
      thinking: {
        type: 'enabled',
        budget_tokens: 31999
      }
    }

    const result = normalizeClaudeThinkingForModel(body, {
      migrateDeprecatedManualThinking: false
    })

    expect(result).toEqual({
      changed: true,
      reason: 'manual_thinking_unsupported'
    })
    expect(body.thinking).toEqual({
      type: 'adaptive'
    })
    expect(body.output_config).toEqual({
      effort: 'max'
    })
  })

  it('keeps deprecated manual thinking for Sonnet 4.6 when direct relay opts out', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      thinking: {
        type: 'enabled',
        budget_tokens: 8192
      }
    }

    const result = normalizeClaudeThinkingForModel(body, {
      migrateDeprecatedManualThinking: false
    })

    expect(result.changed).toBe(false)
    expect(body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 8192
    })
    expect(body.output_config).toBeUndefined()
  })

  it('downgrades unsupported xhigh effort to high for Sonnet 4.6', () => {
    const request = openaiToClaude.convertRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning: {
        effort: 'xhigh'
      }
    })

    expect(request.output_config).toEqual({
      effort: 'high'
    })
    expect(request.thinking).toEqual({ type: 'adaptive' })
  })

  it('preserves xhigh effort for Sonnet 5', () => {
    const request = openaiToClaude.convertRequest({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning: {
        effort: 'xhigh'
      }
    })

    expect(request.output_config).toEqual({
      effort: 'xhigh'
    })
    expect(request.thinking).toEqual({ type: 'adaptive' })
  })

  it('drops effort for models that do not support output_config.effort', () => {
    const request = openaiToClaude.convertRequest({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning: {
        effort: 'medium'
      }
    })

    expect(request.output_config).toBeUndefined()
    expect(request.thinking).toBeUndefined()
  })

  it('downgrades unsupported effort levels on effort-capable models', () => {
    const request = openaiToClaude.convertRequest({
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning: {
        effort: 'max'
      }
    })

    expect(request.output_config).toEqual({
      effort: 'high'
    })
  })

  it('falls back to manual thinking when adaptive thinking is unsupported but budget is valid', () => {
    const body = {
      model: 'claude-sonnet-4-5',
      thinking: {
        type: 'adaptive',
        budget_tokens: 8192
      }
    }

    const result = normalizeClaudeThinkingForModel(body)

    expect(result).toEqual({
      changed: true,
      reason: 'adaptive_thinking_unsupported'
    })
    expect(body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 8192
    })
    expect(body.output_config).toBeUndefined()
  })

  it('applies model-aware effort gating when removing adaptive budget_tokens', () => {
    const body = {
      model: 'claude-opus-4-5',
      thinking: {
        type: 'adaptive',
        budget_tokens: 31999
      }
    }

    const result = normalizeClaudeThinkingForModel(body)

    expect(result).toEqual({
      changed: true,
      reason: 'adaptive_thinking_unsupported'
    })
    expect(body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 31999
    })
    expect(body.output_config).toBeUndefined()
  })

  it('drops disabled thinking for always-on adaptive thinking models', () => {
    const body = {
      model: 'claude-fable-5',
      thinking: {
        type: 'disabled'
      }
    }

    const result = normalizeClaudeThinkingForModel(body)

    expect(result).toEqual({
      changed: true,
      reason: 'thinking_disabled_unsupported'
    })
    expect(body.thinking).toBeUndefined()
  })

  it('keeps manual thinking for older models that still require budget_tokens', () => {
    const body = {
      model: 'claude-sonnet-4-5-20250929',
      thinking: {
        type: 'enabled',
        budget_tokens: 4096
      }
    }

    const result = normalizeClaudeThinkingForModel(body)

    expect(result.changed).toBe(false)
    expect(body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096
    })
  })

  it('maps OpenAI reasoning effort to Claude adaptive thinking for Sonnet 4.6', () => {
    const request = openaiToClaude.convertRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning: {
        effort: 'medium'
      }
    })

    expect(request.output_config).toEqual({
      effort: 'medium'
    })
    expect(request.thinking).toEqual({ type: 'adaptive' })
  })

  it('drops sampling controls for models that reject non-default sampling params', () => {
    const body = {
      model: 'claude-opus-4-8',
      temperature: 0.7,
      top_p: 0.9,
      top_k: 20
    }

    const result = normalizeClaudeSamplingForModel(body)

    expect(result).toEqual({
      changed: true,
      removedFields: ['temperature', 'top_p', 'top_k']
    })
    expect(body).toEqual({
      model: 'claude-opus-4-8'
    })
  })

  it('keeps sampling controls for older models', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      temperature: 0.7,
      top_p: 0.9,
      top_k: 20
    }

    const result = normalizeClaudeSamplingForModel(body)

    expect(result).toEqual({
      changed: false,
      removedFields: []
    })
    expect(body).toEqual({
      model: 'claude-sonnet-4-6',
      temperature: 0.7,
      top_p: 0.9,
      top_k: 20
    })
  })

  it('maps OpenAI adaptive reasoning budget to effort and drops unsupported sampling', () => {
    const request = openaiToClaude.convertRequest({
      model: 'claude-sonnet-5',
      temperature: 0.7,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'hello' }],
      reasoning: {
        type: 'adaptive',
        budget_tokens: 8192
      }
    })

    expect(request.temperature).toBeUndefined()
    expect(request.top_p).toBeUndefined()
    expect(request.thinking).toEqual({
      type: 'adaptive'
    })
    expect(request.output_config).toEqual({
      effort: 'high'
    })
  })
})
