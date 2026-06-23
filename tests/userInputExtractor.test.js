describe('userInputExtractor', () => {
  const originalStoreInputMessages = process.env.STORE_INPUT_MESSAGES

  afterEach(() => {
    if (originalStoreInputMessages === undefined) {
      delete process.env.STORE_INPUT_MESSAGES
    } else {
      process.env.STORE_INPUT_MESSAGES = originalStoreInputMessages
    }
  })

  test('extractUserInput normalizes anthropic user text blocks', () => {
    const { extractUserInput } = require('../src/utils/userInputExtractor')

    const result = extractUserInput(
      {
        messages: [
          { role: 'assistant', content: 'ignore me' },
          { role: 'user', content: ' hello\nworld ' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'image', source: 'ignored' },
              { type: 'text', text: 'line two' }
            ]
          }
        ]
      },
      'anthropic'
    )

    expect(result).toEqual(['hello world', 'line one line two'])
  })

  test('extractUserInput supports OpenAI input_text/text content arrays', () => {
    const { extractUserInput } = require('../src/utils/userInputExtractor')

    const result = extractUserInput(
      {
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'first' },
              { type: 'text', text: 'second' }
            ]
          },
          { role: 'assistant', content: 'ignored' }
        ]
      },
      'openai'
    )

    expect(result).toEqual(['first second'])
  })

  test('extractUserInput falls back to OpenAI parsing for Gemini-shaped requests with messages', () => {
    const { extractUserInput } = require('../src/utils/userInputExtractor')

    const result = extractUserInput(
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'fallback works' }]
          }
        ]
      },
      'gemini'
    )

    expect(result).toEqual(['fallback works'])
  })

  test('buildUsageMetadata extracts ip, process type and normalizes assistant text', () => {
    const { buildUsageMetadata } = require('../src/utils/userInputExtractor')

    const metadata = buildUsageMetadata({
      body: {
        input: [
          {
            role: 'developer',
            content: [{ type: 'input_text', text: '# Project\nThis is a uni-app x project' }]
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'ship it' }]
          }
        ]
      },
      format: 'openai',
      headers: {
        'x-forwarded-for': '1.1.1.1, 2.2.2.2',
        uni_agent_agent_type: '  CLI  '
      },
      requestIp: {
        ip: '9.9.9.9'
      },
      sessionId: 'hashed-session',
      rawSessionId: 'raw-session',
      assistantContent: ' done '
    })

    expect(metadata).toEqual(
      expect.objectContaining({
        sessionId: 'hashed-session',
        rawSessionId: 'raw-session',
        userInput: ['ship it'],
        userIp: '1.1.1.1',
        processType: 'cli',
        projectType: 'uni-app-x',
        assistantContent: { role: 'assistant', content: 'done' }
      })
    )
  })

  test('classifyProjectType supports anthropic and gemini developer text sources', () => {
    const { classifyProjectType } = require('../src/utils/userInputExtractor')

    expect(
      classifyProjectType(
        {
          system: [{ type: 'text', text: '# Project\nThis is a uni-app project' }]
        },
        'anthropic'
      )
    ).toBe('uni-app')

    expect(
      classifyProjectType(
        {
          systemInstruction: {
            parts: [{ text: '# Project\nThis is a uni-app x project' }]
          }
        },
        'gemini'
      )
    ).toBe('uni-app-x')
  })

  test('buildInputMessagesBlock respects STORE_INPUT_MESSAGES switch', () => {
    const { buildInputMessagesBlock } = require('../src/utils/userInputExtractor')
    const body = { messages: [{ role: 'user', content: 'hi' }] }

    process.env.STORE_INPUT_MESSAGES = 'false'
    expect(buildInputMessagesBlock(body)).toBeNull()

    delete process.env.STORE_INPUT_MESSAGES
    expect(buildInputMessagesBlock(body)).toEqual({
      type: 'input_messages',
      messages: body.messages
    })
  })
})
