const axios = require('axios')
const crypto = require('crypto')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')
const config = require('../../../config/config')
const { filterForOpenAI } = require('../../utils/headerFilter')
const { IncrementalSSEParser } = require('../../utils/sseParser')
const { updateRateLimitCounters } = require('../../utils/rateLimitHelper')
const { createRequestDetailMeta } = require('../../utils/requestDetailHelper')
const { buildUsageMetadata, buildInputMessagesBlock } = require('../../utils/userInputExtractor')
const apiKeyService = require('../apiKeyService')
const deepseekAccountService = require('../account/deepseekAccountService')
const unifiedDeepSeekScheduler = require('../scheduler/unifiedDeepSeekScheduler')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  buildChatCompletionsUrl,
  normalizeDeepSeekUsage,
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
    const requestedModel = normalizeDeepSeekModel(req.body?.model || DEEPSEEK_DEFAULT_MODEL)
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

      const selection = await unifiedDeepSeekScheduler.selectAccountForApiKey(
        apiKeyData,
        sessionHash,
        requestedModel
      )
      accountId = selection.accountId
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

  _buildRequestBody(body) {
    const normalized = { ...body }
    normalized.model = normalizeDeepSeekModel(normalized.model)
    if (!isDeepSeekModel(normalized.model)) {
      normalized.model = DEEPSEEK_DEFAULT_MODEL
    }

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
    const model = normalizeDeepSeekModel(responseData?.model || requestedModel)

    if (usage) {
      await this._recordUsage(req, {
        usage,
        body,
        model,
        accountId,
        sessionHash,
        stream: false,
        statusCode: upstreamResponse.status
      })
    } else {
      logger.warn(`⚠️ DeepSeek non-stream response missing usage, model=${model}`)
    }

    logger.info(
      `✅ DeepSeek non-stream completed elapsed=${Date.now() - startTime}ms model=${model}`
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
    let usageRecorded = false

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
          await this._recordUsage(req, {
            usage: capturedUsage,
            body,
            model: normalizeDeepSeekModel(actualModel || requestedModel),
            accountId,
            sessionHash,
            stream: true,
            statusCode: res.statusCode
          })
          usageRecorded = true
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
        `✅ DeepSeek stream completed elapsed=${Date.now() - startTime}ms model=${actualModel} usageRecorded=${usageRecorded}`
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

  async _recordUsage(req, options) {
    const { usage, body, model, accountId, sessionHash, stream, statusCode } = options
    const normalizedUsage = normalizeDeepSeekUsage(usage)
    const inputBlock = buildInputMessagesBlock(body)
    const usageExtra = buildUsageMetadata({
      body,
      format: 'openai',
      headers: req.headers,
      requestIp: req,
      sessionId: sessionHash || null,
      rawSessionId: null,
      assistantContent: inputBlock ? [inputBlock] : undefined
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

    logger.info(
      `📊 Recorded DeepSeek usage - Input: ${normalizedUsage.input_tokens}, Cached: ${normalizedUsage.cache_read_input_tokens}, Output: ${normalizedUsage.output_tokens}, Model: ${model}`
    )
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
