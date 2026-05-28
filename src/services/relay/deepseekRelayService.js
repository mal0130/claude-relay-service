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
const deepseekAccountService = require('../account/deepseekAccountService')
const unifiedDeepSeekScheduler = require('../scheduler/unifiedDeepSeekScheduler')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  buildChatCompletionsUrl,
  buildAnthropicMessagesUrl,
  normalizeDeepSeekUsage,
  normalizeDeepSeekAnthropicUsage,
  isDeepSeekModel,
  normalizeDeepSeekModel,
  DEEPSEEK_DEFAULT_MODEL
} = require('../deepseekPlatform')

class DeepSeekRelayService {
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
      if (!apiKeyService.hasPermission(apiKeyData?.permissions, 'deepseek')) {
        return res.status(403).json({
          error: {
            message: 'This API key does not have permission to access DeepSeek',
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

      const selection = await unifiedDeepSeekScheduler.selectAccountForApiKey(
        apiKeyData,
        sessionHash,
        requestedModel
      )
      const { accountId: selectedAccountId } = selection
      accountId = selectedAccountId
      const account = await deepseekAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('DeepSeek account not found')
      }
      if (!account.apiKey) {
        throw new Error('DeepSeek account API Key not found or decryption failed')
      }

      const targetUrl = buildChatCompletionsUrl(account.baseApi)
      const body = this._buildRequestBody(req.body || {})
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
          'Content-Type': 'application/json'
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

      logger.info(`🎯 Forwarding DeepSeek request to ${targetUrl}, model=${requestedModel}`)
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
      if (!apiKeyService.hasPermission(apiKeyData?.permissions, 'deepseek')) {
        return res.status(403).json({
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'This API key does not have permission to access DeepSeek'
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

      const selection = await unifiedDeepSeekScheduler.selectAccountForApiKey(
        apiKeyData,
        sessionHash,
        requestedModel
      )
      const { accountId: selectedAccountId } = selection
      accountId = selectedAccountId
      const account = await deepseekAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('DeepSeek account not found')
      }
      if (!account.apiKey) {
        throw new Error('DeepSeek account API Key not found or decryption failed')
      }

      const targetUrl = buildAnthropicMessagesUrl(account.baseApi)
      const body = this._buildAnthropicRequestBody(req.body || {})
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
          'Content-Type': 'application/json'
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

      logger.info(
        `🎯 Forwarding DeepSeek Anthropic request to ${targetUrl}, model=${requestedModel}`
      )
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

  _buildRequestBody(body) {
    const normalized = { ...body }
    normalized.model = this._normalizeRequestModel(normalized.model)

    if (normalized.stream === true) {
      normalized.stream_options = {
        ...(normalized.stream_options || {}),
        include_usage: true
      }
    }

    return normalized
  }

  _buildAnthropicRequestBody(body) {
    const normalized = { ...body }
    normalized.model = this._normalizeRequestModel(normalized.model)

    return normalized
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
      return res.status(upstreamResponse.status).json(responseData)
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
      logger.warn(`⚠️ DeepSeek non-stream response missing usage, model=${model}`)
    }

    logger.info(
      formatCompletionUsageLog({
        completionType: '非流式完成',
        platform: 'deepseek',
        elapsedMs: Date.now() - startTime,
        usageSummary: completionUsageSummary,
        model,
        requestedModel
      })
    )
    return res.status(upstreamResponse.status).json(responseData)
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
      return res.status(upstreamResponse.status).json(responseData)
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
      logger.warn(`⚠️ DeepSeek Anthropic non-stream response missing usage, model=${model}`)
    }

    logger.info(
      formatCompletionUsageLog({
        completionType: '非流式完成',
        platform: 'deepseek',
        elapsedMs: Date.now() - startTime,
        usageSummary: completionUsageSummary,
        model,
        requestedModel
      })
    )
    return res.status(upstreamResponse.status).json(responseData)
  }

  async _handleStreamResponse(req, res, context) {
    const { upstreamResponse, body, accountId, requestedModel, sessionHash, startTime } = context

    if (upstreamResponse.status >= 400) {
      const errorBody = await this._readStreamToString(upstreamResponse.data)
      const parsed = this._parseJsonSafe(errorBody) || { error: { message: errorBody } }
      await this._handleUpstreamStatus(upstreamResponse.status, parsed, accountId, sessionHash)
      return res.status(upstreamResponse.status).json(parsed)
    }

    res.writeHead(upstreamResponse.status, {
      'Content-Type': upstreamResponse.headers['content-type'] || 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    const parser = new IncrementalSSEParser()
    let capturedUsage = null
    let actualModel = requestedModel
    let completionUsageSummary = this._buildUsageSummary()

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
        }
      }
    })

    upstreamResponse.data.on('end', async () => {
      try {
        if (parser.getRemaining().trim()) {
          const events = parser.feed('\n\n')
          for (const event of events) {
            if (event.type === 'data' && event.data?.usage) {
              capturedUsage = event.data.usage
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
          logger.warn(`⚠️ DeepSeek stream response missing usage, model=${actualModel}`)
        }

        if (await unifiedDeepSeekScheduler.isAccountRateLimited(accountId)) {
          await unifiedDeepSeekScheduler.removeAccountRateLimit(accountId)
        }
      } catch (error) {
        logger.error('Failed to finalize DeepSeek stream usage:', error)
      }

      logger.info(
        formatCompletionUsageLog({
          completionType: '流式完成',
          platform: 'deepseek',
          elapsedMs: Date.now() - startTime,
          usageSummary: completionUsageSummary,
          model: this._normalizeRequestModel(actualModel || requestedModel),
          requestedModel
        })
      )
      res.end()
    })

    upstreamResponse.data.on('error', (error) => {
      logger.error('DeepSeek upstream stream error:', error)
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

  async _handleAnthropicStreamResponse(req, res, context) {
    const { upstreamResponse, body, accountId, requestedModel, sessionHash, startTime } = context

    if (upstreamResponse.status >= 400) {
      const errorBody = await this._readStreamToString(upstreamResponse.data)
      const parsed = this._parseJsonSafe(errorBody) || {
        type: 'error',
        error: { type: 'api_error', message: errorBody }
      }
      await this._handleUpstreamStatus(upstreamResponse.status, parsed, accountId, sessionHash)
      return res.status(upstreamResponse.status).json(parsed)
    }

    res.writeHead(upstreamResponse.status, {
      'Content-Type': upstreamResponse.headers['content-type'] || 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    const parser = new IncrementalSSEParser()
    let capturedUsage = null
    let actualModel = requestedModel
    const streamedAssistantText = []
    const streamedThinkingText = []
    let completionUsageSummary = this._buildUsageSummary()

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
          logger.warn(`⚠️ DeepSeek Anthropic stream response missing usage, model=${actualModel}`)
        }

        if (await unifiedDeepSeekScheduler.isAccountRateLimited(accountId)) {
          await unifiedDeepSeekScheduler.removeAccountRateLimit(accountId)
        }
      } catch (error) {
        logger.error('Failed to finalize DeepSeek Anthropic stream usage:', error)
      }

      logger.info(
        formatCompletionUsageLog({
          completionType: '流式完成',
          platform: 'deepseek',
          elapsedMs: Date.now() - startTime,
          usageSummary: completionUsageSummary,
          model: this._normalizeRequestModel(actualModel || requestedModel),
          requestedModel
        })
      )
      res.end()
    })

    upstreamResponse.data.on('error', (error) => {
      logger.error('DeepSeek Anthropic upstream stream error:', error)
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
    const normalized = normalizeDeepSeekModel(model || DEEPSEEK_DEFAULT_MODEL)
    return isDeepSeekModel(normalized) ? normalized : DEEPSEEK_DEFAULT_MODEL
  }

  _isModelRestricted(apiKeyData, model) {
    return (
      apiKeyData?.enableModelRestriction &&
      Array.isArray(apiKeyData.restrictedModels) &&
      apiKeyData.restrictedModels.length > 0 &&
      apiKeyData.restrictedModels.includes(model)
    )
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

  _extractAnthropicModel(data = {}, fallback = DEEPSEEK_DEFAULT_MODEL) {
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
      assistantContent
    } = options
    const resolvedRawSessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      body?.session_id ||
      body?.conversation_id ||
      null
    const isAnthropicProtocol = protocol === 'anthropic'
    const normalizedUsage = isAnthropicProtocol
      ? normalizeDeepSeekAnthropicUsage(usage)
      : normalizeDeepSeekUsage(usage)
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
      model,
      accountId,
      'deepseek',
      usageExtra,
      createRequestDetailMeta(req, {
        requestBody: body,
        stream,
        statusCode
      })
    )

    await deepseekAccountService.updateUsageQuota(accountId, costs.realCost || 0)

    await updateRateLimitCounters(
      req.rateLimitInfo,
      {
        inputTokens: normalizedUsage.input_tokens,
        outputTokens: normalizedUsage.output_tokens,
        cacheCreateTokens: normalizedUsage.cache_creation_input_tokens,
        cacheReadTokens: normalizedUsage.cache_read_input_tokens
      },
      model,
      req.apiKey.id,
      'deepseek',
      costs
    )

    return usageSummary
  }

  async _handleUpstreamStatus(status, responseBody, accountId, sessionHash) {
    if (!accountId) {
      return
    }

    if (status === 401 || status === 403) {
      await unifiedDeepSeekScheduler.markAccountUnauthorized(
        accountId,
        `DeepSeek upstream auth failed (${status})`
      )
      if (sessionHash) {
        await unifiedDeepSeekScheduler.clearSessionMapping(sessionHash)
      }
      return
    }

    if (status === 429) {
      await unifiedDeepSeekScheduler.markAccountRateLimited(accountId, sessionHash)
      return
    }

    if (status >= 500 || status === 529) {
      await upstreamErrorHelper.markTempUnavailable(accountId, 'deepseek', status, null, {
        response: responseBody
      })
      if (sessionHash) {
        await unifiedDeepSeekScheduler.clearSessionMapping(sessionHash)
      }
    }
  }

  async _handleRequestError(req, res, error, accountId, sessionHash) {
    if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
      logger.info('🔌 DeepSeek request canceled')
      if (!res.headersSent) {
        return res.status(499).json({ error: { message: 'Client closed request' } })
      }
      return res.end()
    }

    const status = error.response?.status || 500
    const responseBody = error.response?.data || { error: { message: error.message } }
    logger.error('❌ DeepSeek relay request failed:', error.message)

    await this._handleUpstreamStatus(status, responseBody, accountId, sessionHash)

    if (!res.headersSent) {
      return res.status(status).json(responseBody)
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

module.exports = new DeepSeekRelayService()
