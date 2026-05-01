const express = require('express')
const { authenticateApiKey } = require('../middleware/auth')
const deepseekRelayService = require('../services/relay/deepseekRelayService')
const logger = require('../utils/logger')

const router = express.Router()

router.post('/v1/chat/completions', authenticateApiKey, async (req, res) => {
  try {
    if (!req.body || !Array.isArray(req.body.messages) || req.body.messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Messages array is required and cannot be empty',
          type: 'invalid_request_error',
          code: 'invalid_request'
        }
      })
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

module.exports = router
