const express = require('express')
const { authenticateApiKey } = require('../middleware/auth')
const deepseekRelayService = require('../services/relay/deepseekRelayService')
const logger = require('../utils/logger')

const router = express.Router()

function validateMessagesBody(req, res, format = 'openai') {
  if (!req.body || !Array.isArray(req.body.messages) || req.body.messages.length === 0) {
    if (format === 'anthropic') {
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Messages array is required and cannot be empty'
        }
      })
    }

    return res.status(400).json({
      error: {
        message: 'Messages array is required and cannot be empty',
        type: 'invalid_request_error',
        code: 'invalid_request'
      }
    })
  }

  return null
}

function validatePromptBody(req, res) {
  if (!req.body || typeof req.body.prompt !== 'string' || req.body.prompt.length === 0) {
    return res.status(400).json({
      error: {
        message: 'Prompt is required and cannot be empty',
        type: 'invalid_request_error',
        code: 'invalid_request'
      }
    })
  }

  return null
}

router.post('/v1/chat/completions', authenticateApiKey, async (req, res) => {
  try {
    const validationResponse = validateMessagesBody(req, res)
    if (validationResponse) {
      return validationResponse
    }

    return await deepseekRelayService.handleChatCompletions(req, res)
  } catch (error) {
    logger.error('❌ DeepSeek chat/completions route error:', error)
    if (!res.headersSent) {
      return res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'server_error',
          code: 'internal_error'
        }
      })
    }
    return res.end()
  }
})

router.post('/v1/completions', authenticateApiKey, async (req, res) => {
  try {
    const validationResponse = validatePromptBody(req, res)
    if (validationResponse) {
      return validationResponse
    }

    return await deepseekRelayService.handleCompletions(req, res)
  } catch (error) {
    logger.error('❌ DeepSeek completions route error:', error)
    if (!res.headersSent) {
      return res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'server_error',
          code: 'internal_error'
        }
      })
    }
    return res.end()
  }
})

router.post('/anthropic/v1/messages', authenticateApiKey, async (req, res) => {
  try {
    const validationResponse = validateMessagesBody(req, res, 'anthropic')
    if (validationResponse) {
      return validationResponse
    }

    return await deepseekRelayService.handleAnthropicMessages(req, res)
  } catch (error) {
    logger.error('❌ DeepSeek Anthropic messages route error:', error)
    if (!res.headersSent) {
      return res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Internal server error'
        }
      })
    }
    return res.end()
  }
})

module.exports = router
