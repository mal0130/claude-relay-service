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
function applyReasoningTranslation(res, _options = {}) {
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)

  let contentStarted = false
  let contentStartedTime = null
  let pendingChunks = []
  let translationDone = false
  let endCalled = false
  let sseBuffer = ''
  let chatId = null
  let translationUsage = null
  let injectedStandaloneUsage = false
  let streamFormat = 'chat'
  let reasoningItemId = null
  let firstReasoningDeltaTime = null
  let reasoningOutputIndex = 0
  let reasoningSummaryIndex = 0
  let responseObj = null
  let externalMainUsage = null
  let usageSummaryFinalized = false
  let usageSummaryLogged = false
  // 存储被压制的 reasoning output_item.added/done 事件，翻译完成后在正文前发出
  let pendingReasoningAddedEvents = []
  let pendingReasoningDoneEvents = []
  // 防止 startTranslation() 被重复调用（isResponsesDoneEvent 和 res.end 均可能触发）
  let translationStarted = false
  // waitForTranslation() 的 Promise resolve 句柄
  let resolveTranslationWaiter = null
  const translationWaiterPromise = new Promise((resolve) => {
    resolveTranslationWaiter = resolve
  })
  // 按 summary_index 累积翻译后的 reasoning 文本，用于补发各自的 done 事件
  const translatedReasoningBySummary = new Map()
  // 按 summary_index 跟踪是否已向客户端发送 reasoning_summary_text.added
  const emittedReasoningTextAdded = new Set()
  // 按 summary_index 跟踪是否已向客户端发送 reasoning_summary_part.added
  const emittedReasoningPartAdded = new Set()

  let clientSeq = 0
  function logClientReasoningEvent(label, payload) {
    clientSeq += 1
    logger.info(
      `🧩 [ReasoningClient] #${clientSeq} → ${label} | item_id=${payload.item_id ?? '-'} output_index=${payload.output_index ?? '-'} summary_index=${payload.summary_index ?? '-'}${payload.delta !== undefined ? ` delta(len=${String(payload.delta).length})` : ''}${payload.text !== undefined ? ` text(len=${String(payload.text).length})` : ''}`
    )
  }

  function appendTranslatedReasoning(summaryIndex, text) {
    const previous = translatedReasoningBySummary.get(summaryIndex) || ''
    translatedReasoningBySummary.set(summaryIndex, previous + text)
  }

  function emitReasoningLifecycleIfNeeded(summaryIndex) {
    if (streamFormat !== 'responses' || !reasoningItemId) {
      return
    }

    // output_item.added(reasoning) 必须在 part.added 之前到达客户端，否则 SDK 不认识 item_id
    if (pendingReasoningAddedEvents.length > 0) {
      for (const ev of pendingReasoningAddedEvents) {
        try {
          const p = JSON.parse(ev.replace(/^data: /, '').trim())
          logClientReasoningEvent('output_item.added(reasoning)', {
            item_id: p?.item?.id,
            output_index: p?.output_index,
            summary_index: p?.summary_index
          })
        } catch (_e) {
          // 忽略
        }
        originalWrite(ev)
      }
      pendingReasoningAddedEvents = []
    }

    if (!emittedReasoningPartAdded.has(summaryIndex)) {
      emittedReasoningPartAdded.add(summaryIndex)
      const partAddedPayload = {
        type: 'response.reasoning_summary_part.added',
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: summaryIndex,
        part: { type: 'summary_text', text: '' }
      }
      logClientReasoningEvent('reasoning_summary_part.added', partAddedPayload)
      originalWrite(`data: ${JSON.stringify(partAddedPayload)}\n\n`)
    }

    if (!emittedReasoningTextAdded.has(summaryIndex)) {
      emittedReasoningTextAdded.add(summaryIndex)
      const textAddedPayload = {
        type: 'response.reasoning_summary_text.added',
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: summaryIndex
      }
      logClientReasoningEvent('reasoning_summary_text.added', textAddedPayload)
      originalWrite(`data: ${JSON.stringify(textAddedPayload)}\n\n`)
    }
  }

  const translator = createReasoningTranslator((text, meta = {}) => {
    const id = chatId || `chatcmpl-translated-${Date.now()}`
    const summaryIndex =
      typeof meta.summaryIndex === 'number' ? meta.summaryIndex : reasoningSummaryIndex

    appendTranslatedReasoning(summaryIndex, text)
    emitReasoningLifecycleIfNeeded(summaryIndex)

    const deltaPayload = {
      type: 'response.reasoning_summary_text.delta',
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      summary_index: summaryIndex,
      delta: text
    }
    if (streamFormat === 'responses') {
      logClientReasoningEvent('reasoning_summary_text.delta', deltaPayload)
    }
    originalWrite(
      buildReasoningEvent({
        id,
        text,
        streamFormat,
        reasoningItemId,
        reasoningOutputIndex,
        reasoningSummaryIndex: summaryIndex
      })
    )
  })

  function markResponsesFormat(parsed) {
    if (parsed?.type && String(parsed.type).startsWith('response.')) {
      streamFormat = 'responses'
    }
    if (parsed?.response) {
      responseObj = parsed.response
    }
    // 只从 reasoning 类型的 item 捕获 ID 和索引，避免被后续 message/function_call item 污染
    if (parsed?.item?.id && parsed?.item?.type === 'reasoning') {
      reasoningItemId = parsed.item.id
    }
    // reasoning_summary_text.* 事件用顶层 item_id 字段，作为 fallback 兜底
    if (parsed?.item_id && !reasoningItemId) {
      reasoningItemId = parsed.item_id
    }
    // output_index/summary_index 仅从 reasoning 相关事件更新
    const type = String(parsed?.type || '')
    if (parsed?.item?.type === 'reasoning' || type.includes('reasoning')) {
      if (typeof parsed?.output_index === 'number') {
        reasoningOutputIndex = parsed.output_index
      }
      if (typeof parsed?.summary_index === 'number') {
        reasoningSummaryIndex = parsed.summary_index
      }
    }
  }

  function extractReasoningText(parsed) {
    const delta = parsed?.choices?.[0]?.delta
    // 用 'in' 操作符判断字段存在（空字符串也是有效的 reasoning delta）
    if (delta && 'reasoning_content' in delta) {
      markResponsesFormat(parsed)
      return delta.reasoning_content ?? ''
    }

    // 同理，只要 type 匹配就认为是 reasoning delta，不管 delta 内容是否为空
    if (parsed?.type === 'response.reasoning_summary_text.delta') {
      markResponsesFormat(parsed)
      return parsed.delta ?? ''
    }

    return null
  }

  function isContentEvent(parsed) {
    const delta = parsed?.choices?.[0]?.delta
    if (delta?.content) {
      markResponsesFormat(parsed)
      return true
    }

    if (parsed?.type === 'response.output_text.delta' && parsed?.delta) {
      markResponsesFormat(parsed)
      return true
    }

    const itemType = parsed?.item?.type
    if (
      (parsed?.type === 'response.output_item.added' ||
        parsed?.type === 'response.output_item.done') &&
      itemType === 'message'
    ) {
      markResponsesFormat(parsed)
      return true
    }

    return false
  }

  function buildMergedUsage(baseUsage = getMainUsage()) {
    if (!baseUsage && !translationUsage) {
      return null
    }

    return {
      ...(baseUsage || {}),
      ...(translationUsage || {})
    }
  }

  function buildUsageChunk() {
    const mergedUsage = buildMergedUsage()
    if (!mergedUsage) {
      return ''
    }

    if (streamFormat === 'responses') {
      const payload = {
        type: 'response.completed',
        response: {
          ...(responseObj || {}),
          id: chatId || responseObj?.id || `resp-translated-${Date.now()}`,
          usage: mergedUsage
        }
      }
      return `data: ${JSON.stringify(payload)}\n\n`
    }

    return buildUsageEvent(chatId, mergedUsage)
  }

  function mergeUsageIntoResponsesChunk(parsed) {
    if (!translationUsage?.trans_total_tokens || parsed?.type !== 'response.completed') {
      return false
    }

    parsed.response = parsed.response || {}
    parsed.response.usage = {
      ...(parsed.response.usage || {}),
      ...translationUsage
    }
    responseObj = parsed.response
    return true
  }

  function mergeUsageIntoChunk(parsed) {
    if (streamFormat === 'responses') {
      return mergeUsageIntoResponsesChunk(parsed)
    }
    return mergeUsageIfNeeded(parsed)
  }

  function hasChunkUsage(parsed) {
    if (streamFormat === 'responses') {
      return !!parsed?.response?.usage
    }
    return !!parsed?.usage
  }

  function clearStandaloneUsageFlag(parsed) {
    if (!injectedStandaloneUsage || !translationUsage?.trans_total_tokens) {
      return
    }

    const hasTranslationUsage =
      streamFormat === 'responses'
        ? parsed?.response?.usage?.trans_total_tokens > 0
        : parsed?.usage?.trans_total_tokens > 0

    if (hasTranslationUsage) {
      injectedStandaloneUsage = false
    }
  }

  function stringifyEvent(parsed) {
    return `data: ${JSON.stringify(parsed)}\n\n`
  }

  function writeStandaloneUsageIfNeeded() {
    if (translationDone && injectedStandaloneUsage) {
      const usageChunk = buildUsageChunk()
      if (usageChunk) {
        originalWrite(usageChunk)
      }
      injectedStandaloneUsage = false
    }
  }

  function getMainUsage() {
    return externalMainUsage || responseObj?.usage || null
  }

  function maybeLogUsageSummary(force = false) {
    if (usageSummaryLogged || !translationDone) {
      return
    }

    const mainUsage = getMainUsage()
    if (!mainUsage && !force) {
      return
    }

    const mu = mainUsage || {}
    const mainInput = mu.input_tokens || 0
    const cacheRead =
      mu.input_tokens_details?.cached_tokens || mu.prompt_tokens_details?.cached_tokens || 0
    const cacheCreate =
      mu.input_tokens_details?.cache_creation_input_tokens ||
      mu.input_tokens_details?.cache_creation_tokens ||
      mu.prompt_tokens_details?.cache_creation_input_tokens ||
      mu.prompt_tokens_details?.cache_creation_tokens ||
      mu.cache_creation_input_tokens ||
      mu.cache_creation_tokens ||
      0
    const actualInput = Math.max(0, mainInput - cacheRead)
    const mainOutput = mu.output_tokens || 0
    const reasoning = mu.output_tokens_details?.reasoning_tokens || 0
    const textOutput = mainOutput - reasoning
    const transIn = translationUsage?.trans_prompt_tokens || 0
    const transOut = translationUsage?.trans_completion_tokens || 0
    logger.info(
      `📊 [TokenUsage] 主输入=${mainInput}(实际=${actualInput}+缓存读取=${cacheRead}+缓存写入=${cacheCreate}) | 思考链=${reasoning} 文本输出=${textOutput} 输出合计=${mainOutput} | 翻译输入=${transIn} 翻译输出=${transOut}`
    )
    usageSummaryLogged = true
  }

  function updateResponseObject(parsed) {
    if (parsed?.type === 'response.completed' && parsed?.response) {
      responseObj = parsed.response
      maybeLogUsageSummary(usageSummaryFinalized)
    }
  }

  function updateReasoningIndexes(parsed) {
    // 只从 reasoning item 或 reasoning 类型事件更新，避免 message/function_call item 污染
    const type = String(parsed?.type || '')
    const isReasoningRelated = parsed?.item?.type === 'reasoning' || type.includes('reasoning')
    if (!isReasoningRelated) {
      return
    }
    if (typeof parsed?.output_index === 'number') {
      reasoningOutputIndex = parsed.output_index
    }
    if (typeof parsed?.summary_index === 'number') {
      reasoningSummaryIndex = parsed.summary_index
    }
    if (parsed?.item?.id) {
      reasoningItemId = parsed.item.id
    }
  }

  function getReasoningLogLabel(parsed) {
    if (parsed?.type) {
      return parsed.type
    }
    return 'reasoning_content'
  }

  function getReasoningPreview(text) {
    return text.substring(0, 50)
  }

  function isResponsesDoneEvent(parsed) {
    return parsed?.type === 'response.completed'
  }

  function isResponsesReasoningAddedEvent(parsed) {
    return parsed?.type === 'response.output_item.added' && parsed?.item?.type === 'reasoning'
  }

  function isResponsesReasoningOutputItemDoneEvent(parsed) {
    return parsed?.type === 'response.output_item.done' && parsed?.item?.type === 'reasoning'
  }

  function sanitizeReasoningOutputItemEvent(parsed) {
    return stringifyEvent({
      ...parsed,
      item: {
        ...(parsed?.item || {}),
        summary: []
      }
    })
  }

  function shouldSuppressOriginalEvent(parsed) {
    // 压制所有 reasoning_summary_* 上游事件（含 part.added / text.added / part.done / text.done），
    // 翻译完成后我们会按正确顺序合成并发出完整事件序列。
    // reasoning output_item.added/done 也延迟到翻译完成后再发，避免客户端基于上游半成品 summary 建立错误状态。
    const type = parsed?.type
    if (typeof type === 'string' && type.startsWith('response.reasoning_summary_')) {
      return true
    }
    return isResponsesReasoningAddedEvent(parsed) || isResponsesReasoningOutputItemDoneEvent(parsed)
  }

  function maybeTrackResponsesReasoningItem(parsed) {
    if (isResponsesReasoningAddedEvent(parsed)) {
      markResponsesFormat(parsed)
      updateReasoningIndexes(parsed)
    }
  }

  function mergeUsageIfNeeded(parsed) {
    if (!parsed?.usage || !translationUsage?.trans_total_tokens) {
      return false
    }

    Object.assign(parsed.usage, translationUsage)
    return true
  }

  function writeChunk(chunk) {
    originalWrite(chunk)
  }

  function endResponse() {
    originalEnd()
  }

  function flushBufferedChunks() {
    const flushStartTime = Date.now()
    if (contentStartedTime) {
      const firstOutputDelayMs = flushStartTime - contentStartedTime
      logger.info(
        `🌐 [ReasoningTranslation] 首次输出延迟=${firstOutputDelayMs}ms（从翻译触发到内容开始输出）`
      )
    }
    // 先补发被延迟的 reasoning output_item.added/done 事件，保证正确顺序：
    //   翻译后的 reasoning delta → output_item.added(reasoning) → output_item.done(reasoning) → 正文内容
    for (const event of pendingReasoningAddedEvents) {
      try {
        const p = JSON.parse(event.replace(/^data: /, '').trim())
        logClientReasoningEvent('output_item.added(reasoning)', {
          item_id: p?.item?.id,
          output_index: p?.output_index,
          summary_index: p?.summary_index
        })
      } catch (_e) {
        // JSON 解析失败，跳过日志
      }
      writeChunk(event)
    }
    pendingReasoningAddedEvents = []
    for (const event of pendingReasoningDoneEvents) {
      try {
        const p = JSON.parse(event.replace(/^data: /, '').trim())
        logClientReasoningEvent('output_item.done(reasoning)', {
          item_id: p?.item?.id,
          output_index: p?.output_index,
          summary_index: p?.summary_index
        })
      } catch (_e) {
        // JSON 解析失败，跳过日志
      }
      writeChunk(event)
    }
    pendingReasoningDoneEvents = []
    for (const chunk of pendingChunks) {
      writeChunk(chunk)
    }
    pendingChunks = []
    if (endCalled) {
      logger.info(
        `🌐 [ReasoningTranslation] flush完成，调用originalEnd，flush耗时=${Date.now() - flushStartTime}ms`
      )
      endResponse()
    }
  }

  function flushPending(transUsage) {
    let usageInjected = false
    translationUsage = transUsage && transUsage.trans_total_tokens > 0 ? transUsage : null

    // 将翻译 token 注入 usage chunk；如果上游没带 usage，则补一个仅包含翻译 token 的 usage chunk
    if (translationUsage) {
      for (let i = 0; i < pendingChunks.length; i++) {
        const text = pendingChunks[i]
        const dataLine = text.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) {
          continue
        }
        const jsonStr = dataLine.slice(6).trim()
        if (jsonStr === '[DONE]') {
          continue
        }
        try {
          const parsed = JSON.parse(jsonStr)
          markResponsesFormat(parsed)
          updateResponseObject(parsed)
          if (hasChunkUsage(parsed)) {
            mergeUsageIntoChunk(parsed)
            pendingChunks[i] = stringifyEvent(parsed)
            usageInjected = true
            break
          }
        } catch {
          // 忽略
        }
      }

      if (!usageInjected) {
        const usageChunk = buildUsageChunk()
        if (usageChunk) {
          pendingChunks.push(usageChunk)
          injectedStandaloneUsage = true
        }
      }
    }

    flushBufferedChunks()
  }

  function buildUsageEvent(responseId, usage) {
    const payload = {
      id: responseId || `chatcmpl-translated-${Date.now()}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      usage
    }
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  function startTranslation() {
    if (translationStarted) {
      return
    }
    translationStarted = true
    // responses 格式由 response.completed 触发翻译（而非正文 content 事件），此时 contentStartedTime 为 null
    // 统一在翻译启动时记录，确保 flushBufferedChunks 能正确打印首次输出延迟
    if (!contentStartedTime) {
      contentStartedTime = Date.now()
    }
    logger.info(`🌐 [ReasoningTranslation] 开始 flush 翻译队列`)
    translator
      .flush()
      .then(() => {
        const { usage } = translator
        const elapsedMs = firstReasoningDeltaTime ? Date.now() - firstReasoningDeltaTime : 0
        if (usage.trans_total_tokens > 0) {
          logger.info(
            `🌐 [ReasoningTranslation] 翻译完成 - 耗时=${elapsedMs}ms prompt=${usage.trans_prompt_tokens} completion=${usage.trans_completion_tokens} total=${usage.trans_total_tokens}`
          )
        } else {
          logger.info(`🌐 [ReasoningTranslation] 翻译完成 - 耗时=${elapsedMs}ms 无翻译 token 消耗`)
        }

        translationUsage = usage
        maybeLogUsageSummary(usageSummaryFinalized)

        logger.info(`🌐 [ReasoningTranslation] ===原文===\n${translator.originalAccumulated}`)
        logger.info(
          `🌐 [ReasoningTranslation] ===译文===\n${Array.from(translatedReasoningBySummary.values()).join('')}`
        )
        // 按 summary_index 补发 reasoning_summary_text.done 和 reasoning_summary_part.done
        if (streamFormat === 'responses' && reasoningItemId) {
          for (const [summaryIndex, translatedText] of translatedReasoningBySummary.entries()) {
            if (!translatedText) {
              continue
            }
            emitReasoningLifecycleIfNeeded(summaryIndex)
            const donePayload = {
              type: 'response.reasoning_summary_text.done',
              item_id: reasoningItemId,
              output_index: reasoningOutputIndex,
              summary_index: summaryIndex,
              text: translatedText
            }
            logClientReasoningEvent('reasoning_summary_text.done', donePayload)
            originalWrite(`data: ${JSON.stringify(donePayload)}\n\n`)
            const partDonePayload = {
              type: 'response.reasoning_summary_part.done',
              item_id: reasoningItemId,
              output_index: reasoningOutputIndex,
              summary_index: summaryIndex,
              part: { type: 'summary_text', text: translatedText }
            }
            logClientReasoningEvent('reasoning_summary_part.done', partDonePayload)
            originalWrite(`data: ${JSON.stringify(partDonePayload)}\n\n`)
          }
        }
        // 如果没有任何翻译 delta，但客户端已经看到 reasoning item，也要补齐被压制的 output_item.added/done
        if (
          streamFormat === 'responses' &&
          reasoningItemId &&
          translatedReasoningBySummary.size === 0
        ) {
          emitReasoningLifecycleIfNeeded(reasoningSummaryIndex)
        }
        if (pendingReasoningDoneEvents.length > 0) {
          for (const event of pendingReasoningDoneEvents) {
            try {
              const p = JSON.parse(event.replace(/^data: /, '').trim())
              logClientReasoningEvent('output_item.done(reasoning)', {
                item_id: p?.item?.id,
                output_index: p?.output_index,
                summary_index: p?.summary_index
              })
            } catch (_e) {
              // 忽略
            }
            originalWrite(event)
          }
          pendingReasoningDoneEvents = []
        }
        pendingReasoningAddedEvents = []
        translationDone = true
        flushPending(usage)
        maybeLogUsageSummary(usageSummaryFinalized)
        resolveTranslationWaiter?.(translationUsage)
      })
      .catch((err) => {
        logger.warn(`[ReasoningTranslation] flush 异常: ${err.message}`)
        translationDone = true
        flushPending(null)
        resolveTranslationWaiter?.(null)
      })
  }

  function processEvent(eventText) {
    const dataLine = eventText.split('\n').find((l) => l.startsWith('data: '))
    if (!dataLine) {
      if (!contentStarted) {
        writeChunk(eventText)
      } else if (!translationDone) {
        pendingChunks.push(eventText)
      } else {
        writeChunk(eventText)
      }
      return
    }

    const jsonStr = dataLine.slice(6).trim()
    if (jsonStr === '[DONE]') {
      writeStandaloneUsageIfNeeded()
      if (!translationDone) {
        pendingChunks.push(eventText)
      } else {
        writeChunk(eventText)
      }
      return
    }

    let parsed
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      originalWrite(eventText)
      return
    }

    markResponsesFormat(parsed)
    updateResponseObject(parsed)
    maybeTrackResponsesReasoningItem(parsed)
    updateReasoningIndexes(parsed)

    if (!chatId && parsed.id) {
      chatId = parsed.id
    }
    if (!chatId && parsed.response?.id) {
      chatId = parsed.response.id
    }

    if (mergeUsageIntoChunk(parsed)) {
      clearStandaloneUsageFlag(parsed)
      originalWrite(stringifyEvent(parsed))
      return
    }

    const reasoningText = extractReasoningText(parsed)
    if (reasoningText !== null) {
      // 只有非空文本才推入翻译器和打日志；空 delta 仅做拦截
      if (reasoningText) {
        logger.info(
          `🌐 [ReasoningTranslation] 收到 ${getReasoningLogLabel(parsed)}: ${getReasoningPreview(reasoningText)}...`
        )
        if (!firstReasoningDeltaTime) {
          firstReasoningDeltaTime = Date.now()
        }
        translator.push(reasoningText, { summaryIndex: reasoningSummaryIndex })
      }
      // 无论内容是否为空，reasoning delta 事件一律不转发给客户端
      return
    }

    if (shouldSuppressOriginalEvent(parsed)) {
      // reasoning output_item.added/done 需要缓存，等翻译完成后在正文前补发
      if (isResponsesReasoningAddedEvent(parsed)) {
        pendingReasoningAddedEvents.push(sanitizeReasoningOutputItemEvent(parsed))
      } else if (isResponsesReasoningOutputItemDoneEvent(parsed)) {
        pendingReasoningDoneEvents.push(sanitizeReasoningOutputItemEvent(parsed))
      }
      return
    }

    if (!contentStarted && isContentEvent(parsed)) {
      contentStarted = true
      contentStartedTime = Date.now()
      pendingChunks.push(eventText)
      startTranslation()
    } else if (!contentStarted && isResponsesDoneEvent(parsed)) {
      pendingChunks.push(eventText)
      startTranslation()
    } else if (!contentStarted) {
      originalWrite(eventText)
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
    if (typeof callback === 'function') {
      callback()
    }
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

    usageSummaryFinalized = true
    maybeLogUsageSummary(true)

    if (!contentStarted) {
      endCalled = true
      startTranslation()
      // responses 格式下翻译可能在 res.end() 之前就已完成（如推理内容极短时 flush 瞬间结束）
      // 此时 flushBufferedChunks 已发送完数据但因 endCalled=false 跳过了 originalEnd
      // 需要在这里补调，否则 HTTP 连接永远不关闭
      if (translationDone) {
        logger.info('🌐 [ReasoningTranslation] 翻译已提前完成，res.end() 补调 originalEnd')
        originalEnd()
      }
    } else if (!translationDone) {
      endCalled = true
    } else {
      originalEnd()
    }
  }

  return {
    updateMainUsage(usage) {
      if (!usage || typeof usage !== 'object') {
        return
      }
      externalMainUsage = usage
      maybeLogUsageSummary(usageSummaryFinalized)
    },
    // 等待翻译完成，返回 { trans_prompt_tokens, trans_completion_tokens, trans_total_tokens } 或 null
    waitForTranslation() {
      if (!translationStarted) {
        // 翻译从未触发，直接 resolve null
        return Promise.resolve(null)
      }
      return translationWaiterPromise
    }
  }
}

function buildReasoningEvent({
  id,
  text,
  streamFormat = 'chat',
  reasoningItemId = null,
  reasoningOutputIndex = 0,
  reasoningSummaryIndex = 0
}) {
  if (streamFormat === 'responses') {
    const payload = {
      type: 'response.reasoning_summary_text.delta',
      item_id: reasoningItemId || `rs_${Date.now()}`,
      output_index: reasoningOutputIndex,
      summary_index: reasoningSummaryIndex,
      delta: text
    }
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  const payload = {
    id,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }]
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

function isTranslationConfigured() {
  return !!(config.translation.enabled && config.translation.apiKey)
}

function shouldTranslateForKey(keyName) {
  if (!isTranslationConfigured()) {
    return false
  }
  if (config.translation.enabled) {
    return true // 全局开启，对所有人开放
  }
  // 全局关闭，仅对指定 keyName 开放
  const { keyNames } = config.translation
  if (!keyNames || keyNames.length === 0) {
    return false
  }
  return keyNames.includes(keyName)
}

module.exports = { applyReasoningTranslation, isTranslationConfigured, shouldTranslateForKey }
