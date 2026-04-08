const { AsyncLocalStorage } = require('async_hooks')

const asyncLocalStorage = new AsyncLocalStorage()

const getReqId = () => asyncLocalStorage.getStore()?.reqId || null
const getSessionId = () => asyncLocalStorage.getStore()?.sessionId || null
const setSessionId = (sessionId) => {
  const store = asyncLocalStorage.getStore()
  if (store) store.sessionId = sessionId
}

module.exports = { asyncLocalStorage, getReqId, getSessionId, setSessionId }
