'use strict'

/**
 * 思考链路 SSE 流转换器
 *
 * 工作原理：
 *  1. reasoning_content delta 通过 translator.push() 累积，遇句子边界立即并发翻译
 *  2. 首个正文 chunk 到来时调用 translator.flush()，等待所有翻译完成（大多数已完成）
 *  3. 翻译结果按序注入为 reasoning_content SSE 事件 → 释放缓冲的正文 chunk
 *  4. 翻译 token usage 仅附加到响应中，不自动写入后台统计
 */

const logger = require('./logger')
const config = require('../../config/config')
const { createReasoningTranslator } = require('../services/reasoningTranslationService')

/**
 * @param {import('express').Response} res
 * @param {{ keyId?: string, model?: string }} [options]
 */
function applyReasoningTranslation(res, options = {}) {
  const { keyId, model = config.translation.model } = options

  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)

  let contentStarted = false
  let pendingChunks = []
  let translationDone = false
  let endCalled = false
  let sseBuffer = ''
  let chatId = null
  let translationUsage = null
  let injectedStandaloneUsage = false

  const translator = createReasoningTranslator((text) => {
    const id = chatId || `chatcmpl-translated-${Date.now()}`
    originalWrite(buildReasoningEvent(id, text))
  })

  function mergeUsageIfNeeded(parsed) {
    if (!parsed?.usage || !translationUsage?.trans_total_tokens) return false

    Object.assign(parsed.usage, translationUsage)
    return true
  }

  function flushPending(transUsage) {
    let usageInjected = false
    translationUsage = transUsage && transUsage.trans_total_tokens > 0 ? transUsage : null

    // 将翻译 token 注入 usage chunk；如果上游没带 usage，则补一个仅包含翻译 token 的 usage chunk
    if (translationUsage) {
      for (let i = 0; i < pendingChunks.length; i++) {
        const text = pendingChunks[i]
        const dataLine = text.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        const jsonStr = dataLine.slice(6).trim()
        if (jsonStr === '[DONE]') continue
        try {
          const parsed = JSON.parse(jsonStr)
          if (parsed.usage) {
            mergeUsageIfNeeded(parsed)
            pendingChunks[i] = `data: ${JSON.stringify(parsed)}\n\n`
            usageInjected = true
            break
          }
        } catch {
          // 忽略
        }
      }

      if (!usageInjected) {
        pendingChunks.push(buildUsageEvent(chatId, translationUsage))
        injectedStandaloneUsage = true
      }
    }

    for (const chunk of pendingChunks) originalWrite(chunk)
    pendingChunks = []
    if (endCalled) originalEnd()
  }

  function buildUsageEvent(chatId, transUsage) {
    const payload = {
      id: chatId || `chatcmpl-translated-${Date.now()}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      usage: transUsage
    }
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  function startTranslation() {
    translator
      .flush()
      .then(() => {
        const usage = translator.usage
        if (usage.trans_total_tokens > 0) {
          logger.debug(
            `[ReasoningTranslation] 翻译 token: prompt=${usage.trans_prompt_tokens} completion=${usage.trans_completion_tokens} total=${usage.trans_total_tokens}`
          )
        }
        translationDone = true
        flushPending(usage)
      })
      .catch((err) => {
        logger.warn(`[ReasoningTranslation] flush 异常: ${err.message}`)
        translationDone = true
        flushPending(null)
      })
  }

  function processEvent(eventText) {
    const dataLine = eventText.split('\n').find((l) => l.startsWith('data: '))
    if (!dataLine) {
      if (!contentStarted) originalWrite(eventText)
      else if (!translationDone) pendingChunks.push(eventText)
      else originalWrite(eventText)
      return
    }

    const jsonStr = dataLine.slice(6).trim()
    if (jsonStr === '[DONE]') {
      if (translationDone && injectedStandaloneUsage) {
        originalWrite(buildUsageEvent(chatId, translationUsage))
        injectedStandaloneUsage = false
      }
      if (!translationDone) pendingChunks.push(eventText)
      else originalWrite(eventText)
      return
    }

    let parsed
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      originalWrite(eventText)
      return
    }

    if (!chatId && parsed.id) chatId = parsed.id

    if (mergeUsageIfNeeded(parsed)) {
      if (injectedStandaloneUsage && parsed.usage?.trans_total_tokens > 0) {
        injectedStandaloneUsage = false
      }
      originalWrite(`data: ${JSON.stringify(parsed)}\n\n`)
      return
    }

    const delta = parsed?.choices?.[0]?.delta

    if (delta?.reasoning_content) {
      translator.push(delta.reasoning_content)
      return
    }

    if (!contentStarted) {
      contentStarted = true
      pendingChunks.push(eventText)
      startTranslation()
    } else if (!translationDone) {
      pendingChunks.push(eventText)
    } else {
      originalWrite(eventText)
    }
  }

  function drainBuffer() {
    let idx
    while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
      const eventText = sseBuffer.slice(0, idx + 2)
      sseBuffer = sseBuffer.slice(idx + 2)
      processEvent(eventText)
    }
  }

  res.write = function (chunk, encoding, callback) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')
    sseBuffer += text
    drainBuffer()
    if (typeof callback === 'function') callback()
    return true
  }

  res.end = function (chunk, _encoding, _callback) {
    if (chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      if (text) {
        sseBuffer += text
        drainBuffer()
      }
    }
    if (sseBuffer.trim()) {
      processEvent(sseBuffer)
      sseBuffer = ''
    }

    if (!contentStarted) {
      // 纯思考无正文（极少情况）
      endCalled = true
      startTranslation()
    } else if (!translationDone) {
      endCalled = true
    } else {
      originalEnd()
    }
  }
}

function buildReasoningEvent(chatId, reasoningContent) {
  const payload = {
    id: chatId,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { reasoning_content: reasoningContent }, finish_reason: null }]
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

function isTranslationConfigured() {
  return !!(config.translation.enabled && config.translation.apiKey)
}

function shouldTranslateForKey(keyName) {
  if (!isTranslationConfigured()) return false
  const { keyNames } = config.translation
  if (!keyNames || keyNames.length === 0) return false
  return keyNames.includes(keyName)
}

module.exports = { applyReasoningTranslation, isTranslationConfigured, shouldTranslateForKey }
