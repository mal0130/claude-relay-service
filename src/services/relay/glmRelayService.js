const axios = require('axios')
const crypto = require('crypto')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')
const config = require('../../../config/config')
const { filterForOpenAI } = require('../../utils/headerFilter')
const { IncrementalSSEParser } = require('../../utils/sseParser')
const { updateRateLimitCounters } = require('../../utils/rateLimitHelper')
const {
  createRequestDetailMeta,
  buildCompletionUsageSummary,
  formatCompletionUsageLog
} = require('../../utils/requestDetailHelper')
const { buildUsageMetadata, buildInputMessagesBlock } = require('../../utils/userInputExtractor')
const apiKeyService = require('../apiKeyService')
const glmAccountService = require('../account/glmAccountService')
const unifiedGlmScheduler = require('../scheduler/unifiedGlmScheduler')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  buildChatCompletionsUrl,
  normalizeGlmUsage,
  isGlmModel,
  normalizeGlmModel,
  GLM_DEFAULT_MODEL
} = require('../glmPlatform')

class GlmRelayService {
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
      if (!apiKeyService.hasPermission(apiKeyData?.permissions, 'glm')) {
        return res.status(403).json({
          error: {
            message: 'This API key does not have permission to access GLM',
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

      const selection = await unifiedGlmScheduler.selectAccountForApiKey(
        apiKeyData,
        sessionHash,
        requestedModel
      )
      const { accountId: selectedAccountId } = selection
      accountId = selectedAccountId
      const account = await glmAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('GLM account not found')
      }
      if (!account.apiKey) {
        throw new Error('GLM account API Key not found or decryption failed')
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

      logger.info(`🎯 Forwarding GLM request to ${targetUrl}, model=${requestedModel}`)
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
      logger.warn(`⚠️ GLM non-stream response missing usage, model=${model}`)
    }

    logger.info(
      formatCompletionUsageLog({
        completionType: '非流式完成',
        platform: 'glm',
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
          logger.warn(`⚠️ GLM stream response missing usage, model=${actualModel}`)
        }

        if (await unifiedGlmScheduler.isAccountRateLimited(accountId)) {
          await unifiedGlmScheduler.removeAccountRateLimit(accountId)
        }
      } catch (error) {
        logger.error('Failed to finalize GLM stream usage:', error)
      }

      logger.info(
        formatCompletionUsageLog({
          completionType: '流式完成',
          platform: 'glm',
          elapsedMs: Date.now() - startTime,
          usageSummary: completionUsageSummary,
          model: this._normalizeRequestModel(actualModel || requestedModel),
          requestedModel
        })
      )
      res.end()
    })

    upstreamResponse.data.on('error', (error) => {
      logger.error('GLM upstream stream error:', error)
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

  _normalizeRequestModel(model) {
    const normalized = normalizeGlmModel(model || GLM_DEFAULT_MODEL)
    return isGlmModel(normalized) ? normalized : GLM_DEFAULT_MODEL
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
    const { usage, body, model, accountId, sessionHash, stream, statusCode } = options
    const resolvedRawSessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      body?.session_id ||
      body?.conversation_id ||
      null
    const normalizedUsage = normalizeGlmUsage(usage)
    const usageSummary = this._buildUsageSummary(normalizedUsage)
    const inputBlock = buildInputMessagesBlock(body)
    const usageExtra = buildUsageMetadata({
      body,
      format: 'openai',
      headers: req.headers,
      requestIp: req,
      sessionId: sessionHash || null,
      rawSessionId: resolvedRawSessionId,
      assistantContent: inputBlock ? [inputBlock] : undefined
    })

    const costs = await apiKeyService.recordUsageWithDetails(
      req.apiKey.id,
      normalizedUsage,
      model,
      accountId,
      'glm',
      usageExtra,
      createRequestDetailMeta(req, {
        requestBody: body,
        stream,
        statusCode
      })
    )

    await glmAccountService.updateUsageQuota(accountId, costs.realCost || 0)

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
      'glm',
      costs
    )

    return usageSummary
  }

  async _handleUpstreamStatus(status, responseBody, accountId, sessionHash) {
    if (!accountId) {
      return
    }

    if (status === 401 || status === 403) {
      await unifiedGlmScheduler.markAccountUnauthorized(
        accountId,
        `GLM upstream auth failed (${status})`
      )
      if (sessionHash) {
        await unifiedGlmScheduler.clearSessionMapping(sessionHash)
      }
      return
    }

    if (status === 429) {
      await unifiedGlmScheduler.markAccountRateLimited(accountId, sessionHash)
      return
    }

    if (status >= 500 || status === 529) {
      await upstreamErrorHelper.markTempUnavailable(accountId, 'glm', status, null, {
        response: responseBody
      })
      if (sessionHash) {
        await unifiedGlmScheduler.clearSessionMapping(sessionHash)
      }
    }
  }

  async _handleRequestError(req, res, error, accountId, sessionHash) {
    if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
      logger.info('🔌 GLM request canceled')
      if (!res.headersSent) {
        return res.status(499).json({ error: { message: 'Client closed request' } })
      }
      return res.end()
    }

    const status = error.response?.status || 500
    const responseBody = error.response?.data || { error: { message: error.message } }
    logger.error('❌ GLM relay request failed:', error.message)

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

module.exports = new GlmRelayService()
