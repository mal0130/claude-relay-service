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
const { buildUsageMetadata } = require('../../utils/userInputExtractor')
const apiKeyService = require('../apiKeyService')
const deepseekAccountService = require('../account/deepseekAccountService')
const unifiedDeepSeekScheduler = require('../scheduler/unifiedDeepSeekScheduler')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  buildChatCompletionsUrl,
  buildCompletionsUrl,
  buildAnthropicMessagesUrl,
  normalizeDeepSeekUsage,
  normalizeDeepSeekAnthropicUsage,
  isDeepSeekModel,
  normalizeDeepSeekModel,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_COMPLETION_DEFAULT_MODEL
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
      const mappedModel =
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
          ? deepseekAccountService.getMappedModel(account.supportedModels, requestedModel)
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

  async handleCompletions(req, res) {
    const apiKeyData = req.apiKey
    const requestedModel = this._normalizeCompletionRequestModel(req.body?.model)
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
        requestedModel,
        'completion'
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
      if (!account.codeCompletionBaseApi) {
        throw new Error('DeepSeek account code completion endpoint is not configured')
      }

      const targetUrl = buildCompletionsUrl(account.codeCompletionBaseApi)
      if (!targetUrl) {
        throw new Error('DeepSeek account code completion endpoint is invalid')
      }

      const mappedModel =
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
          ? deepseekAccountService.getMappedModel(account.supportedModels, requestedModel)
          : requestedModel
      const body = this._buildCompletionRequestBody(req.body || {}, mappedModel)
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

      logger.info(
        `🎯 Forwarding DeepSeek completion request to ${targetUrl}, model=${requestedModel}`
      )
      upstreamResponse = await axios.post(targetUrl, body, requestConfig)

      if (isStream) {
        return await this._handleCompletionStreamResponse(req, res, {
          upstreamResponse,
          body,
          accountId,
          requestedModel,
          sessionHash,
          startTime
        })
      }

      return await this._handleCompletionJsonResponse(req, res, {
        upstreamResponse,
        body,
        accountId,
        requestedModel,
        sessionHash,
        startTime
      })
    } catch (error) {
      return await this._handleRequestError(req, res, error, accountId, sessionHash, 'completion')
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
      const mappedModel =
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
          ? deepseekAccountService.getMappedModel(account.supportedModels, requestedModel)
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

  _buildCompletionRequestBody(body, mappedModel) {
    const normalized = { ...body }
    normalized.model = mappedModel || this._normalizeCompletionRequestModel(normalized.model)

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
      }),
      config.logging.truncate ? {} : { response: responseData }
    )
    return res.status(upstreamResponse.status).json(responseData)
  }

  async _handleCompletionJsonResponse(req, res, context) {
    const { upstreamResponse, body, accountId, requestedModel, sessionHash, startTime } = context
    const responseData = upstreamResponse.data

    if (upstreamResponse.status >= 400) {
      await this._handleUpstreamStatus(
        upstreamResponse.status,
        responseData,
        accountId,
        sessionHash,
        'completion'
      )
      return res
        .status(upstreamResponse.status)
        .json(upstreamErrorHelper.sanitizeRelayErrorResponse(upstreamResponse.status, responseData))
    }

    const usage = responseData?.usage
    const model = this._normalizeCompletionRequestModel(responseData?.model || requestedModel)
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
        protocol: 'completion'
      })
    } else {
      logger.warn(`⚠️ DeepSeek completion response missing usage, model=${model}`)
    }

    logger.info(
      formatCompletionUsageLog({
        completionType: '非流式完成',
        platform: 'deepseek',
        elapsedMs: Date.now() - startTime,
        usageSummary: completionUsageSummary,
        model,
        requestedModel
      }),
      config.logging.truncate ? {} : { response: responseData }
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
        protocol: 'anthropic'
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
          logger.warn(`⚠️ DeepSeek stream response missing usage, model=${actualModel}`)
        }

        if (await unifiedDeepSeekScheduler.isAccountRateLimited(accountId)) {
          await unifiedDeepSeekScheduler.removeAccountRateLimit(accountId)
        }
      } catch (error) {
        logger.error('Failed to finalize DeepSeek stream usage:', error)
      }

      const responseForLog = this._buildOpenAIStreamResponse(
        streamResponseState,
        capturedUsage,
        this._normalizeRequestModel(actualModel || requestedModel)
      )
      logger.info(
        formatCompletionUsageLog({
          completionType: '流式完成',
          platform: 'deepseek',
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

  async _handleCompletionStreamResponse(req, res, context) {
    const { upstreamResponse, body, accountId, requestedModel, sessionHash, startTime } = context

    if (upstreamResponse.status >= 400) {
      const errorBody = await this._readStreamToString(upstreamResponse.data)
      const parsed = this._parseJsonSafe(errorBody) || { error: { message: errorBody } }
      await this._handleUpstreamStatus(
        upstreamResponse.status,
        parsed,
        accountId,
        sessionHash,
        'completion'
      )
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
          this._collectCompletionStreamResponse(event.data, streamResponseState)
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
              this._collectCompletionStreamResponse(event.data, streamResponseState)
            }
          }
        }

        if (capturedUsage) {
          completionUsageSummary = await this._recordUsage(req, {
            usage: capturedUsage,
            body,
            model: this._normalizeCompletionRequestModel(actualModel || requestedModel),
            accountId,
            sessionHash,
            requestedModel,
            stream: true,
            statusCode: res.statusCode,
            protocol: 'completion'
          })
        } else {
          logger.warn(`⚠️ DeepSeek completion stream missing usage, model=${actualModel}`)
        }

        if (await unifiedDeepSeekScheduler.isAccountRateLimited(accountId)) {
          await unifiedDeepSeekScheduler.removeAccountRateLimit(accountId)
        }
      } catch (error) {
        logger.error('Failed to finalize DeepSeek completion stream usage:', error)
      }

      const responseForLog = this._buildCompletionStreamResponse(
        streamResponseState,
        capturedUsage,
        this._normalizeCompletionRequestModel(actualModel || requestedModel)
      )
      logger.info(
        formatCompletionUsageLog({
          completionType: '流式完成',
          platform: 'deepseek',
          elapsedMs: Date.now() - startTime,
          usageSummary: completionUsageSummary,
          model: this._normalizeCompletionRequestModel(actualModel || requestedModel),
          requestedModel
        }),
        this._buildResponseLogMeta(responseForLog)
      )
      res.end()
    })

    upstreamResponse.data.on('error', (error) => {
      logger.error('DeepSeek completion upstream stream error:', error)
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
            protocol: 'anthropic'
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

      const responseForLog = this._buildAnthropicStreamResponse(
        anthropicResponseMeta,
        null,
        capturedUsage,
        this._normalizeRequestModel(actualModel || requestedModel)
      )

      logger.info(
        formatCompletionUsageLog({
          completionType: '流式完成',
          platform: 'deepseek',
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

  _normalizeCompletionRequestModel(model) {
    if (!model || typeof model !== 'string') {
      return DEEPSEEK_COMPLETION_DEFAULT_MODEL
    }

    return isDeepSeekModel(model) ? model : DEEPSEEK_COMPLETION_DEFAULT_MODEL
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

  _collectCompletionStreamResponse(data, streamResponseState) {
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
    if (data.object) {
      streamResponseState.object = data.object
    }

    for (const choice of data.choices) {
      const choiceIndex = Number.isInteger(choice?.index) ? choice.index : 0
      const currentChoice = streamResponseState.choices.get(choiceIndex) || {
        index: choiceIndex,
        text: '',
        finish_reason: null,
        logprobs: null
      }

      if (typeof choice?.text === 'string') {
        currentChoice.text += choice.text
      }
      if (choice?.logprobs !== undefined) {
        currentChoice.logprobs = choice.logprobs
      }
      if (choice?.finish_reason !== undefined) {
        currentChoice.finish_reason = choice.finish_reason
      }

      streamResponseState.choices.set(choiceIndex, currentChoice)
    }
  }

  _buildCompletionStreamResponse(streamResponseState, usage, fallbackModel) {
    const choices = Array.from(streamResponseState.choices.values())
      .sort((left, right) => left.index - right.index)
      .map((choice) => ({
        text: choice.text || '',
        index: choice.index,
        logprobs: choice.logprobs ?? null,
        finish_reason: choice.finish_reason ?? null
      }))

    if (!streamResponseState.id && choices.length === 0 && !usage) {
      return null
    }

    const response = {
      id: streamResponseState.id,
      object: streamResponseState.object || 'text_completion',
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

    const { message } = data
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
      protocol = 'openai'
    } = options
    const resolvedRawSessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      body?.session_id ||
      body?.conversation_id ||
      null
    const isAnthropicProtocol = protocol === 'anthropic'
    const isCompletionProtocol = protocol === 'completion'
    const normalizedUsage = isAnthropicProtocol
      ? normalizeDeepSeekAnthropicUsage(usage)
      : normalizeDeepSeekUsage(usage)
    const usageSummary = this._buildUsageSummary(normalizedUsage)
    const usageExtra = buildUsageMetadata({
      body,
      format: isAnthropicProtocol ? 'anthropic' : isCompletionProtocol ? 'completion' : 'openai',
      headers: req.headers,
      requestIp: req,
      sessionId: sessionHash || null,
      rawSessionId: resolvedRawSessionId,
      assistantContent: null
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

  async _handleUpstreamStatus(status, responseBody, accountId, sessionHash, endpointType = 'chat') {
    if (!accountId) {
      return
    }

    if (upstreamErrorHelper.isAccountQuotaExceededError(status, responseBody)) {
      await unifiedDeepSeekScheduler.markAccountQuotaExceeded(
        accountId,
        responseBody,
        sessionHash,
        endpointType
      )
      return
    }

    if (upstreamErrorHelper.isRelayBillingError(status, responseBody)) {
      await upstreamErrorHelper.markTempUnavailable(accountId, 'deepseek', status, null, {
        response: responseBody
      })
      if (sessionHash) {
        await unifiedDeepSeekScheduler.clearSessionMapping(sessionHash, endpointType)
      }
      return
    }

    if (status === 401 || status === 403) {
      await unifiedDeepSeekScheduler.markAccountUnauthorized(
        accountId,
        `DeepSeek upstream auth failed (${status})`
      )
      if (sessionHash) {
        await unifiedDeepSeekScheduler.clearSessionMapping(sessionHash, endpointType)
      }
      return
    }

    if (status === 429) {
      await unifiedDeepSeekScheduler.markAccountRateLimited(
        accountId,
        sessionHash,
        null,
        endpointType
      )
      return
    }

    if (status >= 500 || status === 529) {
      await upstreamErrorHelper.markTempUnavailable(accountId, 'deepseek', status, null, {
        response: responseBody
      })
      if (sessionHash) {
        await unifiedDeepSeekScheduler.clearSessionMapping(sessionHash, endpointType)
      }
    }
  }

  async _handleRequestError(req, res, error, accountId, sessionHash, endpointType = 'chat') {
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

    await this._handleUpstreamStatus(status, responseBody, accountId, sessionHash, endpointType)

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

module.exports = new DeepSeekRelayService()
