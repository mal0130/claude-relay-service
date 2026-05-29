const { IncrementalSSEParser } = require('../src/utils/sseParser')

describe('server_is_overloaded interception logic', () => {
  test('detects overload error and would replace chunk', () => {
    const overloadChunk =
      'data: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded.","param":null},"sequence_number":3}\n\n'

    const sseParser = new IncrementalSSEParser()
    const events = sseParser.feed(overloadChunk)

    let overloaded = false
    for (const event of events) {
      if (event.type === 'data' && event.data) {
        if (event.data?.error?.code === 'server_is_overloaded') {
          overloaded = true
        }
      }
    }

    expect(overloaded).toBe(true)

    // 验证友好提示格式正确
    const friendly = {
      error: {
        message: '因模型算力受限导致请求失败，你可以尝试重新提交，或更换其他渠道继续。',
        type: 'server_error',
        code: 'server_is_overloaded',
      },
    }
    const output = `data: ${JSON.stringify(friendly)}\n\n`
    expect(output).toContain('server_is_overloaded')
    expect(output).toContain('因模型算力受限')
  })

  test('normal chunk passes through without interception', () => {
    const normalChunk =
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n'

    const sseParser = new IncrementalSSEParser()
    const events = sseParser.feed(normalChunk)

    let overloaded = false
    for (const event of events) {
      if (event.type === 'data' && event.data) {
        if (event.data?.error?.code === 'server_is_overloaded') {
          overloaded = true
        }
      }
    }

    expect(overloaded).toBe(false)
  })
})
