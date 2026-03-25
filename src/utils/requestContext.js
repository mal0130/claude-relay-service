const { AsyncLocalStorage } = require('async_hooks')

const asyncLocalStorage = new AsyncLocalStorage()

const getReqId = () => asyncLocalStorage.getStore()?.reqId || null

module.exports = { asyncLocalStorage, getReqId }
