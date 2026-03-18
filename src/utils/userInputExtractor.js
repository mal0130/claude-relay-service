/**
 * 用户输入提取和项目类型分类工具
 * 从不同格式的请求体中提取用户最后一条输入，并分类项目类型
 */

/**
 * 从请求体中提取最后一条用户消息（数组格式）
 * @param {Object} body - 请求体
 * @param {string} format - 格式类型: 'anthropic' | 'openai' | 'gemini'
 * @param {number} maxLength - 每条内容最大截断长度
 * @returns {Array<string>} 用户输入内容数组
 */
function extractUserInput(body, format = 'anthropic', maxLength = 100) {
  if (!body || typeof body !== 'object') {
    return []
  }

  let result = []

  try {
    switch (format) {
      case 'anthropic':
        result = extractFromAnthropic(body)
        break
      case 'openai':
        result = extractFromOpenAI(body)
        break
      case 'gemini':
        result = extractFromGemini(body)
        break
      default:
        if (body.contents) {
          result = extractFromGemini(body)
        } else if (body.input || body.messages) {
          result = extractFromOpenAI(body)
        }
    }
  } catch (_err) {
    return []
  }

  if (!Array.isArray(result) || result.length === 0) {
    return []
  }

  // 替换换行符为空格，压缩连续空白，再截断
  return result.map((text) => {
    const cleaned = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
    if (cleaned.length > maxLength) {
      return `${cleaned.substring(0, maxLength)}...`
    }
    return cleaned
  })
}

/**
 * 从 Anthropic (Claude Code) 格式提取用户输入
 * messages 中 role='user' 的 content(数组) 中 type='text' 的 text 内容
 * 正序收集前 maxCount 条 user 消息
 * @returns {Array<string>}
 */
function extractFromAnthropic(body, maxCount = 10) {
  const { messages } = body
  if (!Array.isArray(messages) || messages.length === 0) {
    return []
  }

  const result = []
  for (const msg of messages) {
    if (msg.role !== 'user') {
      continue
    }

    if (typeof msg.content === 'string') {
      result.push(msg.content)
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((part) => part.type === 'text' && part.text)
        .map((part) => part.text)
        .join('\n')
      if (text) {
        result.push(text)
      }
    }

    if (result.length >= maxCount) {
      break
    }
  }

  return result
}

/**
 * 从 OpenAI 格式提取用户输入
 * input/messages 中 role='user' 的 content(数组) 中 type='input_text' 的 text 内容
 * 正序收集前 maxCount 条 user 消息
 * @returns {Array<string>}
 */
function extractFromOpenAI(body, maxCount = 10) {
  const items = body.input || body.messages
  if (!Array.isArray(items) || items.length === 0) {
    return []
  }

  const result = []
  for (const msg of items) {
    if (msg.role !== 'user') {
      continue
    }

    if (typeof msg.content === 'string') {
      result.push(msg.content)
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((part) => (part.type === 'input_text' || part.type === 'text') && part.text)
        .map((part) => part.text)
        .join('\n')
      if (text) {
        result.push(text)
      }
    }

    if (result.length >= maxCount) {
      break
    }
  }

  return result
}

/**
 * 从 Gemini 格式提取用户输入
 * contents 中 role='user' 的 parts 中有 text 的内容
 * 正序收集前 maxCount 条 user 消息
 * @returns {Array<string>}
 */
function extractFromGemini(body, maxCount = 10) {
  const { contents } = body
  if (!Array.isArray(contents) || contents.length === 0) {
    if (body.messages) {
      return extractFromOpenAI(body, maxCount)
    }
    return []
  }

  const result = []
  for (const item of contents) {
    if (item.role !== 'user') {
      continue
    }

    if (Array.isArray(item.parts)) {
      const text = item.parts
        .filter((part) => part.text)
        .map((part) => part.text)
        .join('\n')
      if (text) {
        result.push(text)
      }
    }

    if (result.length >= maxCount) {
      break
    }
  }

  return result
}

/**
 * 根据请求体中 developer/system 内容分类项目类型
 *
 * OpenAI: input/messages 中 role='developer' 的 content 数组
 * Anthropic: system 数组中 type='text' 的 text
 *
 * 匹配规则（以文本开头判断）：
 * - "# Project\nThis is a uni-app x project" → 'uni-app-x'
 * - "# Project\nThis is a uni-app project" → 'uni-app'
 * - 否则 → 'other'
 *
 * @param {Object} body - 请求体
 * @param {string} format - 格式类型: 'anthropic' | 'openai' | 'gemini'
 * @returns {string} 项目类型: 'uni-app' | 'uni-app-x' | 'other'
 */
function classifyProjectType(body, format = 'anthropic') {
  if (!body || typeof body !== 'object') {
    return 'other'
  }

  try {
    let texts = []

    switch (format) {
      case 'openai':
        texts = extractDeveloperTextsOpenAI(body)
        break
      case 'anthropic':
        texts = extractDeveloperTextsAnthropic(body)
        break
      case 'gemini':
        texts = extractDeveloperTextsGemini(body)
        break
      default:
        if (body.input || body.messages) {
          texts = extractDeveloperTextsOpenAI(body)
        }
    }

    // 逐条检查内容中是否包含项目类型标识
    for (const text of texts) {
      // uni-app-x 先判断（避免被 "uni-app" 匹配吃掉）
      if (text.includes('This is a uni-app x project')) {
        return 'uni-app-x'
      }
      if (text.includes('This is a uni-app project')) {
        return 'uni-app'
      }
    }

    return 'other'
  } catch (_err) {
    return 'other'
  }
}

/**
 * 从 OpenAI 格式提取 developer 内容（返回文本数组）
 * input/messages 中 role='developer' 的 content 数组中每条 text
 * @returns {Array<string>}
 */
function extractDeveloperTextsOpenAI(body) {
  const items = body.input || body.messages
  if (!Array.isArray(items)) {
    return []
  }

  const texts = []
  for (const msg of items) {
    if (msg.role !== 'developer' && msg.role !== 'system') {
      continue
    }

    if (typeof msg.content === 'string') {
      texts.push(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ((part.type === 'input_text' || part.type === 'text') && part.text) {
          texts.push(part.text)
        }
      }
    }
  }

  return texts
}

/**
 * 从 Anthropic (Claude Code) 格式提取 developer 内容（返回文本数组）
 * system 数组中 type='text' 的 text
 * @returns {Array<string>}
 */
function extractDeveloperTextsAnthropic(body) {
  if (typeof body.system === 'string') {
    return [body.system]
  }

  if (Array.isArray(body.system)) {
    return body.system.filter((part) => part.type === 'text' && part.text).map((part) => part.text)
  }

  return []
}

/**
 * 从 Gemini 格式提取 developer 内容（返回文本数组）
 * systemInstruction 的 parts 中有 text 的内容
 * @returns {Array<string>}
 */
function extractDeveloperTextsGemini(body) {
  const si = body.systemInstruction || body.system_instruction
  if (!si) {
    return []
  }

  if (typeof si === 'string') {
    return [si]
  }

  if (si.parts && Array.isArray(si.parts)) {
    return si.parts.filter((part) => part.text).map((part) => part.text)
  }

  return []
}

module.exports = {
  extractUserInput,
  classifyProjectType
}
