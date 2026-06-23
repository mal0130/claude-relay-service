const axios = require('axios')
const crypto = require('crypto')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')
const config = require('../../../config/config')
const { filterForClaude, filterForOpenAI } = require('../../utils/headerFilter')
const { IncrementalSSEParser } = require('../../utils/sseParser')
const { updateRateLimitCounters } = require('../../utils/rateLimitHelper')
const {
  createRequestDetailMeta,
  buildCompletionUsageSummary,
  formatCompletionUsageLog
} = require('../../utils/requestDetailHelper')
const { buildUsageMetadata, buildInputMessagesBlock } = require('../../utils/userInputExtractor')
const apiKeyService = require('../apiKeyService')
const kimiAccountService = require('../account/kimiAccountService')
const unifiedKimiScheduler = require('../scheduler/unifiedKimiScheduler')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  buildChatCompletionsUrl,
  buildAnthropicMessagesUrl,
  normalizeKimiUsage,
  normalizeKimiAnthropicUsage,
  isKimiModel,
  normalizeKimiModel,
  KIMI_DEFAULT_MODEL
} = require('../kimiPlatform')

class KimiRelayService {
  constructor() {
    this.defaultTimeout = config.requestTimeout || 600000
  }

  async handleChatCompletions(req, res) {
    const apiKeyData = req.apiKey
    const requestedModel = this._normalizeRequestModel(req.body?.model)
    const sessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      req.body?.session_id ||
      req.body?.conversation_id ||
      null
    const sessionHash = sessionId
      ? crypto.createHash('sha256').update(String(sessionId)).digest('hex')
      : null

    let accountId = null
    let upstreamResponse = null
    const startTime = Date.now()

    try {
      if (!apiKeyService.hasPermission(apiKeyData?.permissions, 'kimi')) {
        return res.status(403).json({
          error: {
            message: 'This API key does not have permission to access Kimi',
            type: 'permission_denied',
            code: 'permission_denied'
          }
        })
      }

      if (this._isModelRestricted(apiKeyData, requestedModel)) {
        return res.status(403).json({
          error: {
            message: `Model ${requestedModel} is not allowed for this API key`,
            type: 'invalid_request_error',
            code: 'model_not_allowed'
          }
        })
      }

      const selection = await unifiedKimiScheduler.selectAccountForApiKey(
        apiKeyData,
        sessionHash,
        requestedModel
      )
      const { accountId: selectedAccountId } = selection
      accountId = selectedAccountId
      const account = await kimiAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Kimi account not found')
      }
      if (!account.apiKey) {
        throw new Error('Kimi account API Key not found or decryption failed')
      }

      const targetUrl = buildChatCompletionsUrl(account.baseApi)
      const mappedModel =
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
          ? kimiAccountService.getMappedModel(account.supportedModels, requestedModel)
          : requestedModel
      const body = this._buildRequestBody(req.body || {}, mappedModel)
      const isStream = body.stream === true
      const abortController = new AbortController()

      const onClientDisconnect = () => {
        if (!abortController.signal.aborted) {
          abortController.abort()
        }
      }
      req.once('close', onClientDisconnect)
      res.once('close', onClientDisconnect)

      const requestConfig = {
        headers: {
          ...filterForOpenAI(req.headers || {}),
          Authorization: `Bearer ${account.apiKey}`,
          'Content-Type': 'application/json',
          'accept-encoding': 'identity'
        },
        timeout: this.defaultTimeout,
        validateStatus: () => true,
        signal: abortController.signal
      }

      if (account.proxy) {
        const agent = ProxyHelper.createProxyAgent(account.proxy)
        if (agent) {
          requestConfig.httpAgent = agent
          requestConfig.httpsAgent = agent
        }
      }

      if (isStream) {
        requestConfig.responseType = 'stream'
      }

      logger.info(`🎯 Forwarding Kimi request to ${targetUrl}, model=${requestedModel}`)
      upstreamResponse = await axios.post(targetUrl, body, requestConfig)

      if (isStream) {
        return await this._handleStreamResponse(req, res, {
          upstreamResponse,
          body,
          accountId,
          requestedModel,
          sessionHash,
          startTime
        })
      }

      return await this._handleJsonResponse(req, res, {
        upstreamResponse,
        body,
        accountId,
        requestedModel,
        sessionHash,
        startTime
      })
    } catch (error) {
      return await this._handleRequestError(req, res, error, accountId, sessionHash)
    }
  }

  _buildRequestBody(body, mappedModel) {
    const normalized = { ...body }
    normalized.model = mappedModel || this._normalizeRequestModel(normalized.model)

    if (normalized.stream === true) {
      normalized.stream_options = {
        ...(normalized.stream_options || {}),
        include_usage: true
      }
    }

    return normalized
  }

  _buildAnthropicRequestBody(body, mappedModel) {
    const normalized = { ...body }
    normalized.model = mappedModel || this._normalizeRequestModel(normalized.model)

    return normalized
  }

  async handleAnthropicMessages(req, res) {
    const apiKeyData = req.apiKey
    const requestedModel = this._normalizeRequestModel(req.body?.model)
    const sessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      req.body?.session_id ||
      req.body?.conversation_id ||
      null
    const sessionHash = sessionId
      ? crypto.createHash('sha256').update(String(sessionId)).digest('hex')
      : null

    let accountId = null
    let upstreamResponse = null
    const startTime = Date.now()

    try {
      if (!apiKeyService.hasPermission(apiKeyData?.permissions, 'kimi')) {
        return res.status(403).json({
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'This API key does not have permission to access Kimi'
          }
        })
      }

      if (this._isModelRestricted(apiKeyData, requestedModel)) {
        return res.status(403).json({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `Model ${requestedModel} is not allowed for this API key`
          }
        })
      }

      const selection = await unifiedKimiScheduler.selectAccountForApiKey(
        apiKeyData,
        sessionHash,
        requestedModel
      )
      const { accountId: selectedAccountId } = selection
      accountId = selectedAccountId
      const account = await kimiAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Kimi account not found')
      }
      if (!account.apiKey) {
        throw new Error('Kimi account API Key not found or decryption failed')
      }

      const targetUrl = buildAnthropicMessagesUrl(account.baseApi)
      const mappedModel =
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
          ? kimiAccountService.getMappedModel(account.supportedModels, requestedModel)
          : requestedModel
      const body = this._buildAnthropicRequestBody(req.body || {}, mappedModel)
      const isStream = body.stream === true
      const abortController = new AbortController()

      const onClientDisconnect = () => {
        if (!abortController.signal.aborted) {
          abortController.abort()
        }
      }
      req.once('close', onClientDisconnect)
      res.once('close', onClientDisconnect)

      const requestConfig = {
        headers: {
          ...filterForClaude(req.headers || {}),
          'x-api-key': account.apiKey,
          'anthropic-version':
            this._getHeaderValue(req.headers, 'anthropic-version') || '2023-06-01',
          'Content-Type': 'application/json',
          'accept-encoding': 'identity'
        },
        timeout: this.defaultTimeout,
        validateStatus: () => true,
        signal: abortController.signal
      }

      if (account.proxy) {
        const agent = ProxyHelper.createProxyAgent(account.proxy)
        if (agent) {
          requestConfig.httpAgent = agent
          requestConfig.httpsAgent = agent
        }
      }

      if (isStream) {
        requestConfig.responseType = 'stream'
      }

      logger.info(`🎯 Forwarding Kimi Anthropic request to ${targetUrl}, model=${requestedModel}`)
      upstreamResponse = await axios.post(targetUrl, body, requestConfig)

      if (isStream) {
        return await this._handleAnthropicStreamResponse(req, res, {
          upstreamResponse,
          body,
          accountId,
          requestedModel,
          sessionHash,
          startTime
        })
      }

      return await this._handleAnthropicJsonResponse(req, res, {
        upstreamResponse,
        body,
        accountId,
        requestedModel,
        sessionHash,
        startTime
      })
    } catch (error) {
      return await this._handleRequestError(req, res, error, accountId, sessionHash)
    }
  }

  async _handleJsonResponse(req, res, context) {
    const { upstreamResponse, body, accountId, requestedModel, sessionHash, startTime } = context
    const responseData = upstreamResponse.data

    if (upstreamResponse.status >= 400) {
      await this._handleUpstreamStatus(
        upstreamResponse.status,
        responseData,
        accountId,
        sessionHash
      )
      return res
        .status(upstreamResponse.status)
        .json(upstreamErrorHelper.sanitizeRelayErrorResponse(upstreamResponse.status, responseData))
    }

    const usage = responseData?.usage
    const model = this._normalizeRequestModel(responseData?.model || requestedModel)
    let completionUsageSummary = this._buildUsageSummary()

    if (usage) {
      completionUsageSummary = await this._recordUsage(req, {
        usage,
        body,
        model,
        accountId,
        sessionHash,
        requestedModel,
        stream: false,
        statusCode: upstreamResponse.status
      })
    } else {
      logger.warn(`⚠️ Kimi non-stream response missing usage, model=${model}`)
    }

    logger.info(
      formatCompletionUsageLog({
        completionType: '非流式完成',
        platform: 'kimi',
        elapsedMs: Date.now() - startTime,
        usageSummary: completionUsageSummary,
        model,
        requestedModel
      }),
      config.logging.truncate ? {} : { response: responseData }
    )
    return res.status(upstreamResponse.status).json(responseData)
  }

  async _handleStreamResponse(req, res, context) {
    const { upstreamResponse, body, accountId, requestedModel, sessionHash, startTime } = context

    if (upstreamResponse.status >= 400) {
      const errorBody = await this._readStreamToString(upstreamResponse.data)
      const parsed = this._parseJsonSafe(errorBody) || { error: { message: errorBody } }
      await this._handleUpstreamStatus(upstreamResponse.status, parsed, accountId, sessionHash)
      return res
        .status(upstreamResponse.status)
        .json(
          upstreamErrorHelper.sanitizeRelayErrorResponse(upstreamResponse.status, parsed, errorBody)
        )
    }

    res.status(upstreamResponse.status)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders()
    }

    const parser = new IncrementalSSEParser()
    let capturedUsage = null
    let actualModel = requestedModel
    let completionUsageSummary = this._buildUsageSummary()
    const streamResponseState = { choices: new Map() }

    upstreamResponse.data.on('data', (chunk) => {
      if (!res.destroyed) {
        res.write(chunk)
      }

      const events = parser.feed(chunk.toString())
      for (const event of events) {
        if (event.type === 'data' && event.data) {
          if (event.data.model) {
            actualModel = event.data.model
          }
          if (event.data.usage) {
            capturedUsage = event.data.usage
          }
          this._collectOpenAIStreamResponse(event.data, streamResponseState)
        }
      }
    })

    upstreamResponse.data.on('end', async () => {
      try {
        if (parser.getRemaining().trim()) {
          const events = parser.feed('\n\n')
          for (const event of events) {
            if (event.type === 'data' && event.data) {
              if (event.data.model) {
                actualModel = event.data.model
              }
              if (event.data.usage) {
                capturedUsage = event.data.usage
              }
              this._collectOpenAIStreamResponse(event.data, streamResponseState)
            }
          }
        }

        if (capturedUsage) {
          completionUsageSummary = await this._recordUsage(req, {
            usage: capturedUsage,
            body,
            model: this._normalizeRequestModel(actualModel || requestedModel),
            accountId,
            sessionHash,
            requestedModel,
            stream: true,
            statusCode: res.statusCode
          })
        } else {
          logger.warn(`⚠️ Kimi stream response missing usage, model=${actualModel}`)
        }

        if (await unifiedKimiScheduler.isAccountRateLimited(accountId)) {
          await unifiedKimiScheduler.removeAccountRateLimit(accountId)
        }
      } catch (error) {
        logger.error('Failed to finalize Kimi stream usage:', error)
      }

      const responseForLog = this._buildOpenAIStreamResponse(
        streamResponseState,
        capturedUsage,
        this._normalizeRequestModel(actualModel || requestedModel)
      )
      logger.info(
        formatCompletionUsageLog({
          completionType: '流式完成',
          platform: 'kimi',
          elapsedMs: Date.now() - startTime,
          usageSummary: completionUsageSummary,
          model: this._normalizeRequestModel(actualModel || requestedModel),
          requestedModel
        }),
        this._buildResponseLogMeta(responseForLog)
      )
      res.end()
    })

    upstreamResponse.data.on('error', (error) => {
      logger.error('Kimi upstream stream error:', error)
      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream stream error' } })
      } else {
        res.end()
      }
    })

    req.on('close', () => {
      try {
        upstreamResponse.data?.destroy?.()
      } catch (_) {
        // ignore
      }
    })
  }

  async _handleAnthropicJsonResponse(req, res, context) {
    const { upstreamResponse, body, accountId, requestedModel, sessionHash, startTime } = context
    const responseData = upstreamResponse.data

    if (upstreamResponse.status >= 400) {
      await this._handleUpstreamStatus(
        upstreamResponse.status,
        responseData,
        accountId,
        sessionHash
      )
      return res
        .status(upstreamResponse.status)
        .json(upstreamErrorHelper.sanitizeRelayErrorResponse(upstreamResponse.status, responseData))
    }

    const usage = responseData?.usage
    const model = this._normalizeRequestModel(responseData?.model || requestedModel)
    let completionUsageSummary = this._buildUsageSummary()

    if (usage) {
      completionUsageSummary = await this._recordUsage(req, {
        usage,
        body,
        model,
        accountId,
        sessionHash,
        requestedModel,
        stream: false,
        statusCode: upstreamResponse.status,
        protocol: 'anthropic',
        assistantContent: responseData?.content
      })
    } else {
      logger.warn(`⚠️ Kimi Anthropic non-stream response missing usage, model=${model}`)
    }

    logger.info(
      formatCompletionUsageLog({
        completionType: '非流式完成',
        platform: 'kimi',
        elapsedMs: Date.now() - startTime,
        usageSummary: completionUsageSummary,
        model,
        requestedModel
      }),
      config.logging.truncate ? {} : { response: responseData }
    )
    return res.status(upstreamResponse.status).json(responseData)
  }

  async _handleAnthropicStreamResponse(req, res, context) {
    const { upstreamResponse, body, accountId, requestedModel, sessionHash, startTime } = context

    if (upstreamResponse.status >= 400) {
      const errorBody = await this._readStreamToString(upstreamResponse.data)
      const parsed = this._parseJsonSafe(errorBody) || {
        type: 'error',
        error: { type: 'api_error', message: errorBody }
      }
      await this._handleUpstreamStatus(upstreamResponse.status, parsed, accountId, sessionHash)
      return res
        .status(upstreamResponse.status)
        .json(
          upstreamErrorHelper.sanitizeRelayErrorResponse(upstreamResponse.status, parsed, errorBody)
        )
    }

    res.status(upstreamResponse.status)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders()
    }

    const parser = new IncrementalSSEParser()
    let capturedUsage = null
    let actualModel = requestedModel
    const streamedAssistantText = []
    const streamedThinkingText = []
    let completionUsageSummary = this._buildUsageSummary()
    const anthropicResponseMeta = {}

    upstreamResponse.data.on('data', (chunk) => {
      if (!res.destroyed) {
        res.write(chunk)
      }

      const events = parser.feed(chunk.toString())
      for (const event of events) {
        if (event.type === 'data' && event.data) {
          actualModel = this._extractAnthropicModel(event.data, actualModel)
          capturedUsage = this._mergeAnthropicUsage(
            capturedUsage,
            this._extractAnthropicUsage(event.data)
          )
          this._collectAnthropicStreamContent(
            event.data,
            streamedAssistantText,
            streamedThinkingText
          )
          this._collectAnthropicStreamResponseMeta(event.data, anthropicResponseMeta)
        }
      }
    })

    upstreamResponse.data.on('end', async () => {
      try {
        if (parser.getRemaining().trim()) {
          const events = parser.feed('\n\n')
          for (const event of events) {
            if (event.type === 'data' && event.data) {
              actualModel = this._extractAnthropicModel(event.data, actualModel)
              capturedUsage = this._mergeAnthropicUsage(
                capturedUsage,
                this._extractAnthropicUsage(event.data)
              )
              this._collectAnthropicStreamContent(
                event.data,
                streamedAssistantText,
                streamedThinkingText
              )
            }
          }
        }

        if (capturedUsage) {
          completionUsageSummary = await this._recordUsage(req, {
            usage: capturedUsage,
            body,
            model: this._normalizeRequestModel(actualModel || requestedModel),
            accountId,
            sessionHash,
            requestedModel,
            stream: true,
            statusCode: res.statusCode,
            protocol: 'anthropic',
            assistantContent: this._buildAnthropicAssistantContent(
              streamedAssistantText,
              streamedThinkingText
            )
          })
        } else {
          logger.warn(`⚠️ Kimi Anthropic stream response missing usage, model=${actualModel}`)
        }

        if (await unifiedKimiScheduler.isAccountRateLimited(accountId)) {
          await unifiedKimiScheduler.removeAccountRateLimit(accountId)
        }
      } catch (error) {
        logger.error('Failed to finalize Kimi Anthropic stream usage:', error)
      }

      const responseForLog = this._buildAnthropicStreamResponse(
        anthropicResponseMeta,
        this._buildAnthropicAssistantContent(streamedAssistantText, streamedThinkingText),
        capturedUsage,
        this._normalizeRequestModel(actualModel || requestedModel)
      )

      logger.info(
        formatCompletionUsageLog({
          completionType: '流式完成',
          platform: 'kimi',
          elapsedMs: Date.now() - startTime,
          usageSummary: completionUsageSummary,
          model: this._normalizeRequestModel(actualModel || requestedModel),
          requestedModel
        }),
        this._buildResponseLogMeta(responseForLog)
      )
      res.end()
    })

    upstreamResponse.data.on('error', (error) => {
      logger.error('Kimi Anthropic upstream stream error:', error)
      if (!res.headersSent) {
        res.status(502).json({
          type: 'error',
          error: { type: 'api_error', message: 'Upstream stream error' }
        })
      } else {
        res.end()
      }
    })

    req.on('close', () => {
      try {
        upstreamResponse.data?.destroy?.()
      } catch (_) {
        // ignore
      }
    })
  }

  _normalizeRequestModel(model) {
    const normalized = normalizeKimiModel(model || KIMI_DEFAULT_MODEL)
    return isKimiModel(normalized) ? normalized : KIMI_DEFAULT_MODEL
  }

  _getHeaderValue(headers = {}, name) {
    const lowerName = name.toLowerCase()
    for (const [key, value] of Object.entries(headers || {})) {
      if (key.toLowerCase() === lowerName) {
        return Array.isArray(value) ? value[0] : value
      }
    }
    return null
  }

  _extractAnthropicUsage(data = {}) {
    if (data?.usage && typeof data.usage === 'object') {
      return data.usage
    }

    if (data?.message?.usage && typeof data.message.usage === 'object') {
      return data.message.usage
    }

    return null
  }

  _mergeAnthropicUsage(current, partial) {
    if (!partial || typeof partial !== 'object') {
      return current
    }

    return {
      ...(current || {}),
      ...partial,
      cache_creation: {
        ...(current?.cache_creation || {}),
        ...(partial.cache_creation || {})
      }
    }
  }

  _extractAnthropicModel(data = {}, fallback = KIMI_DEFAULT_MODEL) {
    return data?.message?.model || data?.model || fallback
  }

  _collectAnthropicStreamContent(data, streamedAssistantText, streamedThinkingText) {
    const delta = data?.delta
    if (!delta || typeof delta !== 'object') {
      return
    }

    if (typeof delta.text === 'string' && delta.text) {
      streamedAssistantText.push(delta.text)
    }

    if (typeof delta.thinking === 'string' && delta.thinking) {
      streamedThinkingText.push(delta.thinking)
    }
  }

  _buildAnthropicAssistantContent(streamedAssistantText, streamedThinkingText) {
    const blocks = []
    const thinking = streamedThinkingText.join('')
    if (thinking) {
      blocks.push({ type: 'thinking', thinking })
    }

    const text = streamedAssistantText.join('')
    if (text) {
      blocks.push({ type: 'text', text })
    }

    return blocks.length > 0 ? blocks : undefined
  }

  _buildResponseLogMeta(response) {
    return config.logging.truncate || !response ? {} : { response }
  }

  _collectOpenAIStreamResponse(data, streamResponseState) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.choices)) {
      return
    }

    if (data.id && !streamResponseState.id) {
      streamResponseState.id = data.id
    }
    if (data.created && !streamResponseState.created) {
      streamResponseState.created = data.created
    }
    if (data.model) {
      streamResponseState.model = data.model
    }
    if (data.system_fingerprint) {
      streamResponseState.system_fingerprint = data.system_fingerprint
    }

    for (const choice of data.choices) {
      const choiceIndex = Number.isInteger(choice?.index) ? choice.index : 0
      const currentChoice = streamResponseState.choices.get(choiceIndex) || {
        index: choiceIndex,
        message: { role: 'assistant', content: '' },
        finish_reason: null
      }

      const delta = choice?.delta
      if (delta?.role) {
        currentChoice.message.role = delta.role
      }
      if (typeof delta?.content === 'string') {
        currentChoice.message.content += delta.content
      }
      if (typeof delta?.reasoning_content === 'string') {
        currentChoice.message.reasoning_content =
          (currentChoice.message.reasoning_content || '') + delta.reasoning_content
      }
      if (typeof delta?.reasoning === 'string') {
        currentChoice.message.reasoning = (currentChoice.message.reasoning || '') + delta.reasoning
      }
      if (typeof delta?.refusal === 'string') {
        currentChoice.message.refusal = (currentChoice.message.refusal || '') + delta.refusal
      }
      if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
        currentChoice.message.tool_calls = this._mergeOpenAIStreamToolCalls(
          currentChoice.message.tool_calls,
          delta.tool_calls
        )
      }
      if (choice?.finish_reason !== undefined) {
        currentChoice.finish_reason = choice.finish_reason
      }

      streamResponseState.choices.set(choiceIndex, currentChoice)
    }
  }

  _mergeOpenAIStreamToolCalls(currentToolCalls = [], deltaToolCalls = []) {
    const mergedToolCalls = currentToolCalls.map((toolCall) => ({
      ...toolCall,
      function: toolCall.function ? { ...toolCall.function } : toolCall.function
    }))

    for (const toolCall of deltaToolCalls) {
      const toolCallIndex = Number.isInteger(toolCall?.index)
        ? toolCall.index
        : mergedToolCalls.length
      const currentToolCall = mergedToolCalls[toolCallIndex] || {
        function: { arguments: '' }
      }

      if (toolCall?.id) {
        currentToolCall.id = toolCall.id
      }
      if (toolCall?.type) {
        currentToolCall.type = toolCall.type
      }
      if (toolCall?.function) {
        currentToolCall.function = currentToolCall.function || { arguments: '' }
        if (toolCall.function.name) {
          currentToolCall.function.name = toolCall.function.name
        }
        if (typeof toolCall.function.arguments === 'string') {
          currentToolCall.function.arguments =
            (currentToolCall.function.arguments || '') + toolCall.function.arguments
        }
      }

      mergedToolCalls[toolCallIndex] = currentToolCall
    }

    return mergedToolCalls.filter(Boolean)
  }

  _buildOpenAIStreamResponse(streamResponseState, usage, fallbackModel) {
    const choices = Array.from(streamResponseState.choices.values())
      .sort((left, right) => left.index - right.index)
      .map((choice) => {
        const message = {
          role: choice.message.role || 'assistant'
        }

        if (choice.message.content) {
          message.content = choice.message.content
        }
        if (choice.message.reasoning_content) {
          message.reasoning_content = choice.message.reasoning_content
        }
        if (choice.message.reasoning) {
          message.reasoning = choice.message.reasoning
        }
        if (choice.message.refusal) {
          message.refusal = choice.message.refusal
        }
        if (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0) {
          message.tool_calls = choice.message.tool_calls
        }

        return {
          index: choice.index,
          message,
          finish_reason: choice.finish_reason ?? null
        }
      })

    if (!streamResponseState.id && choices.length === 0 && !usage) {
      return null
    }

    const response = {
      id: streamResponseState.id,
      object: 'chat.completion',
      created: streamResponseState.created,
      model: streamResponseState.model || fallbackModel,
      choices
    }

    if (streamResponseState.system_fingerprint) {
      response.system_fingerprint = streamResponseState.system_fingerprint
    }
    if (usage) {
      response.usage = usage
    }

    return response
  }

  _collectAnthropicStreamResponseMeta(data, anthropicResponseMeta) {
    if (!data || typeof data !== 'object') {
      return
    }

    const message = data.message
    if (message && typeof message === 'object') {
      if (message.id) {
        anthropicResponseMeta.id = message.id
      }
      if (message.type) {
        anthropicResponseMeta.type = message.type
      }
      if (message.role) {
        anthropicResponseMeta.role = message.role
      }
      if (message.model) {
        anthropicResponseMeta.model = message.model
      }
      if (message.stop_reason !== undefined) {
        anthropicResponseMeta.stop_reason = message.stop_reason
      }
      if (message.stop_sequence !== undefined) {
        anthropicResponseMeta.stop_sequence = message.stop_sequence
      }
    }

    if (data.delta && typeof data.delta === 'object') {
      if (data.delta.stop_reason !== undefined) {
        anthropicResponseMeta.stop_reason = data.delta.stop_reason
      }
      if (data.delta.stop_sequence !== undefined) {
        anthropicResponseMeta.stop_sequence = data.delta.stop_sequence
      }
    }
  }

  _buildAnthropicStreamResponse(anthropicResponseMeta, content, usage, fallbackModel) {
    if (!anthropicResponseMeta.id && !content && !usage) {
      return null
    }

    const response = {
      id: anthropicResponseMeta.id,
      type: anthropicResponseMeta.type || 'message',
      role: anthropicResponseMeta.role || 'assistant',
      model: anthropicResponseMeta.model || fallbackModel,
      content: content || [],
      stop_reason: anthropicResponseMeta.stop_reason ?? null,
      stop_sequence: anthropicResponseMeta.stop_sequence ?? null
    }

    if (usage) {
      response.usage = usage
    }

    return response
  }

  _isModelRestricted(apiKeyData, model) {
    return (
      apiKeyData?.enableModelRestriction &&
      Array.isArray(apiKeyData.restrictedModels) &&
      apiKeyData.restrictedModels.length > 0 &&
      apiKeyData.restrictedModels.includes(model)
    )
  }

  _buildUsageSummary(normalizedUsage = {}) {
    return buildCompletionUsageSummary({
      totalInputTokens:
        Number(normalizedUsage.input_tokens || 0) +
        Number(normalizedUsage.cache_read_input_tokens || 0),
      outputTokens: normalizedUsage.output_tokens || 0,
      cacheReadTokens: normalizedUsage.cache_read_input_tokens || 0,
      cacheCreateTokens: normalizedUsage.cache_creation_input_tokens || 0
    })
  }

  async _recordUsage(req, options) {
    const {
      usage,
      body,
      model,
      accountId,
      sessionHash,
      stream,
      statusCode,
      protocol = 'openai',
      assistantContent,
      requestedModel
    } = options
    // 计费使用请求模型（用户配置的），避免上游返回免费模型导致费用为0
    const billingModel = requestedModel || model
    const resolvedRawSessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      body?.session_id ||
      body?.conversation_id ||
      null
    const isAnthropicProtocol = protocol === 'anthropic'
    const normalizedUsage = isAnthropicProtocol
      ? normalizeKimiAnthropicUsage(usage)
      : normalizeKimiUsage(usage)
    const usageSummary = this._buildUsageSummary(normalizedUsage)
    const inputBlock = isAnthropicProtocol ? null : buildInputMessagesBlock(body)
    const usageExtra = buildUsageMetadata({
      body,
      format: isAnthropicProtocol ? 'anthropic' : 'openai',
      headers: req.headers,
      requestIp: req,
      sessionId: sessionHash || null,
      rawSessionId: resolvedRawSessionId,
      assistantContent: assistantContent || (inputBlock ? [inputBlock] : undefined)
    })

    const costs = await apiKeyService.recordUsageWithDetails(
      req.apiKey.id,
      normalizedUsage,
      billingModel,
      accountId,
      'kimi',
      usageExtra,
      createRequestDetailMeta(req, {
        requestBody: body,
        stream,
        statusCode
      })
    )

    await kimiAccountService.updateUsageQuota(accountId, costs.realCost || 0)

    await updateRateLimitCounters(
      req.rateLimitInfo,
      {
        inputTokens: normalizedUsage.input_tokens,
        outputTokens: normalizedUsage.output_tokens,
        cacheCreateTokens: normalizedUsage.cache_creation_input_tokens,
        cacheReadTokens: normalizedUsage.cache_read_input_tokens
      },
      billingModel,
      req.apiKey.id,
      'kimi',
      costs
    )

    return usageSummary
  }

  async _handleUpstreamStatus(status, responseBody, accountId, sessionHash) {
    if (!accountId) {
      return
    }

    if (upstreamErrorHelper.isRelayBillingError(status, responseBody)) {
      await upstreamErrorHelper.markTempUnavailable(accountId, 'kimi', status, null, {
        response: responseBody
      })
      if (sessionHash) {
        await unifiedKimiScheduler.clearSessionMapping(sessionHash)
      }
      return
    }

    if (status === 401 || status === 403) {
      await unifiedKimiScheduler.markAccountUnauthorized(
        accountId,
        `Kimi upstream auth failed (${status})`
      )
      if (sessionHash) {
        await unifiedKimiScheduler.clearSessionMapping(sessionHash)
      }
      return
    }

    if (status === 429) {
      await unifiedKimiScheduler.markAccountRateLimited(accountId, sessionHash)
      return
    }

    if (status >= 500 || status === 529) {
      await upstreamErrorHelper.markTempUnavailable(accountId, 'kimi', status, null, {
        response: responseBody
      })
      if (sessionHash) {
        await unifiedKimiScheduler.clearSessionMapping(sessionHash)
      }
    }
  }

  async _handleRequestError(req, res, error, accountId, sessionHash) {
    if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
      logger.info('🔌 Kimi request canceled')
      if (!res.headersSent) {
        return res.status(499).json({ error: { message: 'Client closed request' } })
      }
      return res.end()
    }

    const status = error.response?.status || 500
    const responseBody = error.response?.data || { error: { message: error.message } }
    logger.error('❌ Kimi relay request failed:', error.message)

    await this._handleUpstreamStatus(status, responseBody, accountId, sessionHash)

    if (!res.headersSent) {
      return res
        .status(status)
        .json(upstreamErrorHelper.sanitizeRelayErrorResponse(status, responseBody, error.message))
    }
    return res.end()
  }

  _parseJsonSafe(text) {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  _readStreamToString(stream) {
    return new Promise((resolve) => {
      const chunks = []
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', () => resolve(''))
    })
  }
}

module.exports = new KimiRelayService()
