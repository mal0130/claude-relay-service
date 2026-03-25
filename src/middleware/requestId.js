const crypto = require('crypto')
const { asyncLocalStorage } = require('../utils/requestContext')

const requestIdMiddleware = (req, res, next) => {
  const reqId = crypto.randomBytes(4).toString('hex')
  req.reqId = reqId
  res.setHeader('X-Relay-Request-Id', reqId)
  asyncLocalStorage.run({ reqId }, next)
}

module.exports = { requestIdMiddleware }
