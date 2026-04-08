const crypto = require('crypto')
const { asyncLocalStorage } = require('../utils/requestContext')

const requestIdMiddleware = (req, res, next) => {
  const reqId = crypto.randomBytes(4).toString('hex')
  req.reqId = reqId
  res.setHeader('X-Relay-Request-Id', reqId)
  const sessionId = req.headers['session_id'] || req.headers['x-session-id'] || null
  asyncLocalStorage.run({ reqId, ...(sessionId ? { sessionId } : {}) }, next)
}

module.exports = { requestIdMiddleware }
