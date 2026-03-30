'use strict'

/**
 * 思考链路翻译器工厂（参考 reasoning-translator.js 实现）
 *
 * 工作原理：
 *  1. push() 累积 reasoning delta，遇到句子边界立即并发发起翻译
 *  2. outputChain 保证翻译结果按原始顺序输出
 *  3. flush() 在流结束时等待所有翻译完成，返回 usage 统计
 */

const axios = require('axios')
const config = require('../../config/config')
const logger = require('../utils/logger')

const MIN_CHUNK = 40 // 触发翻译的最小字符数
const MAX_CHUNK = 400 // 强制切分的最大字符数
const CHINESE_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 在 text 中找句子边界，返回切分位置；未找到返回 -1 */
function findBoundary(text) {
  if (text.length < MIN_CHUNK) {
    return -1
  }

  if (text.length >= MAX_CHUNK) {
    const slice = text.slice(0, MAX_CHUNK)
    for (const sep of ['\n\n', '.\n', '. ', '!\n', '! ', '?\n', '? ', '\n']) {
      const idx = slice.lastIndexOf(sep)
      if (idx > 0) {
        return idx + sep.length
      }
    }
    return MAX_CHUNK
  }

  const nn = text.indexOf('\n\n')
  if (nn !== -1) {
    return nn + 2
  }

  const nl = text.indexOf('\n')
  if (nl !== -1 && nl + 1 >= MIN_CHUNK) {
    return nl + 1
  }

  const m = text.match(/[.!?][ \n]/)
  if (m) {
    return m.index + m[0].length
  }

  return -1
}

/**
 * 创建翻译器实例
 *
 * @param {(text: string, meta?: object) => void} onToken 每个翻译句子完成时回调（按序）
 * @returns {{ push: Function, flush: Function, usage: object, originalAccumulated: string }}
 */
function createReasoningTranslator(onToken) {
  const { apiKey, baseUrl, model, timeout } = config.translation

  let buffer = ''
  let bufferMeta = {}
  let outputChain = Promise.resolve()
  let chunkIndex = 0
  const tokenUsage = { prompt: 0, completion: 0, total: 0 }
  let originalAccumulated = ''
  let firstChunkChecked = false
  let skipAllTranslation = false

  function isSameMeta(a = {}, b = {}) {
    return a.summaryIndex === b.summaryIndex
  }

  function dispatch(text, meta = {}) {
    const idx = ++chunkIndex
    originalAccumulated += text
    const promise = translate(text, idx)
    outputChain = outputChain.then(async () => {
      const translated = await promise
      if (translated && translated.trim()) {
        onToken(restoreWhitespace(text, translated), meta)
      }
    })
  }

  function flushBufferChunk() {
    if (!buffer) {
      return
    }
    dispatch(buffer, bufferMeta)
    buffer = ''
    bufferMeta = {}
  }

  function appendToBuffer(delta, meta = {}) {
    if (!buffer) {
      bufferMeta = meta
    } else if (!isSameMeta(bufferMeta, meta)) {
      flushBufferChunk()
      bufferMeta = meta
    }
    buffer += delta
  }

  function drainBufferByBoundary() {
    let boundary
    while ((boundary = findBoundary(buffer)) !== -1) {
      const chunk = buffer.slice(0, boundary)
      const meta = bufferMeta
      buffer = buffer.slice(boundary)
      if (!buffer) {
        bufferMeta = {}
      }
      dispatch(chunk, meta)
    }
  }

  async function translate(text, idx) {
    if (!text.trim()) {
      return text
    }
    if (!apiKey) {
      return text
    }
    if (skipAllTranslation) {
      return text
    }
    if (!firstChunkChecked) {
      firstChunkChecked = true
      if (CHINESE_CHAR_RE.test(text)) {
        skipAllTranslation = true
        logger.info(`🌐 [ReasoningTranslation] #${idx} 首块含中文，跳过全部翻译`)
        return text
      }
    }

    logger.info(`🌐 [ReasoningTranslation] #${idx} 开始翻译，长度: ${text.length}`)
    try {
      const response = await axios.post(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          model,
          messages: [
            {
              role: 'system',
              content:
                '将以下英文内容翻译成中文，保留原有格式（换行、代码块、标点等），只输出翻译结果，不要添加任何解释。'
            },
            { role: 'user', content: text }
          ],
          stream: true,
          stream_options: { include_usage: true }
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          responseType: 'stream',
          timeout
        }
      )

      return await new Promise((resolve) => {
        let result = ''
        let lineBuf = ''

        response.data.on('data', (chunk) => {
          lineBuf += chunk.toString()
          let nl
          while ((nl = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, nl).trim()
            lineBuf = lineBuf.slice(nl + 1)
            if (!line.startsWith('data: ')) {
              continue
            }
            const jsonStr = line.slice(6).trim()
            if (jsonStr === '[DONE]') {
              continue
            }
            try {
              const parsed = JSON.parse(jsonStr)
              result += parsed.choices?.[0]?.delta?.content || ''
              if (parsed.usage) {
                tokenUsage.prompt += parsed.usage.prompt_tokens ?? 0
                tokenUsage.completion += parsed.usage.completion_tokens ?? 0
                tokenUsage.total += parsed.usage.total_tokens ?? 0
              }
            } catch {
              // 忽略无效 JSON
            }
          }
        })

        response.data.on('end', () => resolve(result || text))
        response.data.on('error', () => resolve(text))
      })
    } catch (err) {
      logger.warn(`[ReasoningTranslation] #${idx} 翻译失败: ${err.message}，原样返回`)
      return text
    }
  }

  function restoreWhitespace(original, translated) {
    const leadMatch = original.match(/^\s+/)
    const tailMatch = original.match(/\s+$/)
    let result = translated.trim()
    if (leadMatch) {
      result = leadMatch[0] + result
    }
    if (tailMatch) {
      result = result + tailMatch[0]
    }
    return result
  }

  return {
    push(delta, meta = {}) {
      if (!delta) {
        return
      }
      appendToBuffer(delta, meta)
      drainBufferByBoundary()
    },

    async flush() {
      if (buffer.trim()) {
        flushBufferChunk()
      } else {
        buffer = ''
        bufferMeta = {}
      }
      await outputChain
    },

    get usage() {
      return {
        trans_prompt_tokens: tokenUsage.prompt,
        trans_completion_tokens: tokenUsage.completion,
        trans_total_tokens: tokenUsage.total
      }
    },

    get originalAccumulated() {
      return originalAccumulated
    }
  }
}

module.exports = { createReasoningTranslator }
