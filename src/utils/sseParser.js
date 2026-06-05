/**
 * Server-Sent Events (SSE) 解析工具
 *
 * 用于解析标准 SSE 格式的数据流
 * 当前主要用于 Gemini API 的流式响应处理
 *
 * @module sseParser
 */

/**
 * 解析单行 SSE 数据
 *
 * @param {string} line - SSE 格式的行（如："data: {json}\n"）
 * @returns {Object} 解析结果
 * @returns {'data'|'control'|'other'|'invalid'} .type - 行类型
 * @returns {Object|null} .data - 解析后的 JSON 数据（仅 type='data' 时）
 * @returns {string} .line - 原始行内容
 * @returns {string} [.jsonStr] - JSON 字符串
 * @returns {Error} [.error] - 解析错误（仅 type='invalid' 时）
 *
 * @example
 * // 数据行
 * parseSSELine('data: {"key":"value"}')
 * // => { type: 'data', data: {key: 'value'}, line: '...', jsonStr: '...' }
 *
 * @example
 * // 控制行
 * parseSSELine('data: [DONE]')
 * // => { type: 'control', data: null, line: '...', jsonStr: '[DONE]' }
 */
function getSSEFieldValue(line, fieldName) {
  const prefix = `${fieldName}:`
  if (!line.startsWith(prefix)) {
    return null
  }

  const value = line.slice(prefix.length)
  return (value.startsWith(' ') ? value.slice(1) : value).trimEnd()
}

function findEventBoundary(buffer) {
  const candidates = [
    { idx: buffer.indexOf('\n\n'), length: 2 },
    { idx: buffer.indexOf('\r\n\r\n'), length: 4 },
    { idx: buffer.indexOf('\r\r'), length: 2 }
  ].filter((candidate) => candidate.idx !== -1)

  if (candidates.length === 0) {
    return null
  }

  candidates.sort((a, b) => a.idx - b.idx)
  return candidates[0]
}

function parseSSELine(line) {
  const jsonStr = getSSEFieldValue(line, 'data')
  if (jsonStr === null) {
    return { type: 'other', line, data: null }
  }

  if (!jsonStr || jsonStr === '[DONE]') {
    return { type: 'control', line, data: null, jsonStr }
  }

  try {
    const data = JSON.parse(jsonStr)
    return { type: 'data', line, data, jsonStr }
  } catch (e) {
    return { type: 'invalid', line, data: null, jsonStr, error: e }
  }
}

/**
 * 增量 SSE 解析器类
 * 用于处理流式数据，避免每次都 split 整个 buffer
 */
class IncrementalSSEParser {
  constructor() {
    this.buffer = ''
  }

  /**
   * 添加数据块并返回完整的事件
   * @param {string} chunk - 数据块
   * @returns {Array<Object>} 解析出的完整事件数组
   */
  feed(chunk) {
    this.buffer += chunk
    const events = []

    // 查找完整的事件（兼容 \n\n、\r\n\r\n、\r\r 分隔）
    let boundary
    while ((boundary = findEventBoundary(this.buffer))) {
      const event = this.buffer.slice(0, boundary.idx)
      this.buffer = this.buffer.slice(boundary.idx + boundary.length)

      if (event.trim()) {
        // 解析事件中的每一行
        const lines = event.split(/\r\n|\n|\r/)
        for (const line of lines) {
          const jsonStr = getSSEFieldValue(line, 'data')
          if (jsonStr !== null) {
            if (jsonStr && jsonStr !== '[DONE]') {
              try {
                events.push({ type: 'data', data: JSON.parse(jsonStr) })
              } catch (e) {
                events.push({ type: 'invalid', raw: jsonStr, error: e })
              }
            } else if (jsonStr === '[DONE]') {
              events.push({ type: 'done' })
            }
          } else {
            const eventName = getSSEFieldValue(line, 'event')
            if (eventName !== null) {
              events.push({ type: 'event', name: eventName.trim() })
            }
          }
        }
      }
    }

    return events
  }

  /**
   * 获取剩余的 buffer 内容
   * @returns {string}
   */
  getRemaining() {
    return this.buffer
  }

  /**
   * 重置解析器
   */
  reset() {
    this.buffer = ''
  }
}

module.exports = {
  parseSSELine,
  IncrementalSSEParser
}
