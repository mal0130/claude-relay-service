jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../config/config', () => ({
  translation: {
    enabled: true,
    apiKey: 'test-translation-key',
    keyNames: ['test-key']
  }
}))

jest.mock('../src/services/reasoningTranslationService', () => ({
  createReasoningTranslator: jest.fn((onToken) => {
    const pushed = []

    return {
      push(text, meta = {}) {
        pushed.push({ text, meta })
      },
      async flush() {
        for (const entry of pushed) {
          onToken(`译:${entry.text}`, entry.meta)
        }
      },
      get usage() {
        return {
          trans_prompt_tokens: 0,
          trans_completion_tokens: 0,
          trans_total_tokens: 0
        }
      },
      get originalAccumulated() {
        return pushed.map((entry) => entry.text).join('')
      }
    }
  })
}))

const {
  applyReasoningTranslation,
  shouldTranslateForKey
} = require('../src/utils/reasoningTranslationTransformer')

function createMockResponse() {
  const chunks = []

  return {
    chunks,
    destroyed: false,
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      return true
    },
    end(chunk) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      }
      chunks.push('__END__')
    }
  }
}

function parseDataEvents(chunks) {
  return chunks
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line) => line && line.slice(6) !== '[DONE]')
    .map((line) => JSON.parse(line.slice(6)))
}

describe('reasoningTranslationTransformer', () => {
  it('emits lifecycle events for each summary_index before translated delta output', async () => {
    const res = createMockResponse()
    applyReasoningTranslation(res, { keyId: 'key-1', model: 'gpt-4.1' })

    res.write(
      'data: {"type":"response.output_item.added","item":{"id":"rs_test","type":"reasoning","summary":[{"type":"summary_text","text":"upstream"}]},"output_index":0}\n\n'
    )
    res.write(
      'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_test","output_index":0,"summary_index":0,"delta":"First reasoning chunk."}\n\n'
    )
    res.write(
      'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_test","output_index":0,"summary_index":1,"delta":"Second reasoning chunk."}\n\n'
    )
    res.write(
      'data: {"type":"response.output_item.done","item":{"id":"rs_test","type":"reasoning","summary":[{"type":"summary_text","text":"upstream done"}]},"output_index":0}\n\n'
    )
    res.write(
      'data: {"type":"response.output_text.delta","output_index":1,"delta":"Final answer."}\n\n'
    )
    res.write(
      'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":20}}}\n\n'
    )
    res.write('data: [DONE]\n\n')
    res.end()

    await new Promise((resolve) => setImmediate(resolve))

    const events = parseDataEvents(res.chunks)
    const eventTypes = events.map((event) =>
      event.type === 'response.reasoning_summary_text.delta'
        ? `${event.type}:${event.summary_index}`
        : event.type === 'response.reasoning_summary_part.added'
          ? `${event.type}:${event.summary_index}`
          : event.type === 'response.reasoning_summary_text.added'
            ? `${event.type}:${event.summary_index}`
            : event.type === 'response.reasoning_summary_text.done'
              ? `${event.type}:${event.summary_index}`
              : event.type === 'response.reasoning_summary_part.done'
                ? `${event.type}:${event.summary_index}`
                : event.type
    )

    expect(eventTypes).toEqual([
      'response.output_item.added',
      'response.reasoning_summary_part.added:0',
      'response.reasoning_summary_text.added:0',
      'response.reasoning_summary_text.delta:0',
      'response.reasoning_summary_part.added:1',
      'response.reasoning_summary_text.added:1',
      'response.reasoning_summary_text.delta:1',
      'response.reasoning_summary_text.done:0',
      'response.reasoning_summary_part.done:0',
      'response.reasoning_summary_text.done:1',
      'response.reasoning_summary_part.done:1',
      'response.output_item.done',
      'response.output_text.delta',
      'response.completed'
    ])

    expect(events[0].item.summary).toEqual([])
    expect(events[3]).toMatchObject({
      item_id: 'rs_test',
      summary_index: 0,
      delta: '译:First reasoning chunk.'
    })
    expect(events[6]).toMatchObject({
      item_id: 'rs_test',
      summary_index: 1,
      delta: '译:Second reasoning chunk.'
    })
    expect(events[7]).toMatchObject({
      item_id: 'rs_test',
      summary_index: 0,
      text: '译:First reasoning chunk.'
    })
    expect(events[9]).toMatchObject({
      item_id: 'rs_test',
      summary_index: 1,
      text: '译:Second reasoning chunk.'
    })
  })

  it('checks translation key whitelist from config', () => {
    expect(shouldTranslateForKey('test-key')).toBe(true)
    expect(shouldTranslateForKey('other-key')).toBe(false)
  })
})
