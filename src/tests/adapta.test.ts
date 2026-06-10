import assert from 'node:assert/strict'
import test from 'node:test'
import { app } from '../api/server.ts'
import { getAdaptaChatSessionByKey, touchAdaptaChatSessionMapping } from '../core/chat-sessions.ts'
import { getDefaultAdaptaChatRequest } from '../services/playwright.ts'
import {
  applyProjectFolderToPayload,
  extractRefinementQuestionsFromAdaptaPayload,
  extractTextFromAdaptaPayload,
  formatRefinementQuestions,
  openAiMessagesToPrompt,
  prepareAdaptaPayload,
  replacePromptInPayload,
} from '../services/adapta.ts'
import { redactSecrets } from '../utils/redact.ts'
import { createUser, generateApiKeyForUser, saveAdaptaAccount } from '../services/auth-store.ts'

function createTestAuthHeaders(): Record<string, string> {
  process.env.TEST_MOCK_PLAYWRIGHT = '1'
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const user = createUser({
    name: 'Test User',
    email: `test-${suffix}@example.com`,
    password: 'local-password',
  })
  saveAdaptaAccount({
    userId: user.id,
    adaptaEmail: `adapta-${suffix}@example.com`,
    adaptaPassword: 'adapta-password',
  })
  const apiKey = generateApiKeyForUser(user.id)
  return {
    Authorization: `Bearer ${apiKey}`,
  }
}

test('converts OpenAI messages into an Adapta prompt', () => {
  const prompt = openAiMessagesToPrompt([
    { role: 'system', content: 'Responda em portugues.' },
    { role: 'user', content: 'Ola' },
    { role: 'assistant', content: 'Oi' },
    { role: 'user', content: [{ type: 'text', text: 'Continue' }] as any },
  ])

  assert.equal(prompt, [
    'System: Responda em portugues.',
    'User: Ola',
    'Assistant: Oi',
    'User: Continue',
  ].join('\n\n'))
})

test('replaces prompt in captured payload shapes', () => {
  assert.deepEqual(
    replacePromptInPayload({ message: 'old', session_id: 'abc' }, 'new'),
    { message: 'new', session_id: 'abc' },
  )

  assert.deepEqual(
    replacePromptInPayload({ messages: [{ role: 'user', content: 'old' }] }, 'new'),
    { messages: [{ role: 'user', content: 'new' }] },
  )

  assert.deepEqual(
    replacePromptInPayload({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'old' }] }] }, 'new'),
    { messages: [{ role: 'user', parts: [{ type: 'text', text: 'new' }] }] },
  )

  assert.deepEqual(
    replacePromptInPayload({ unrelated: true }, 'new'),
    { unrelated: true, message: 'new' },
  )

  assert.deepEqual(
    replacePromptInPayload({ nested: { userMessage: 'old' } }, 'new'),
    { nested: { userMessage: 'new' } },
  )
})

test('extracts assistant text from common upstream payloads', () => {
  assert.equal(extractTextFromAdaptaPayload({ answer: 'ok' }), 'ok')
  assert.equal(extractTextFromAdaptaPayload({ data: { content: 'nested' } }), 'nested')
  assert.equal(extractTextFromAdaptaPayload({ choices: [{ message: { content: 'choice' } }] }), 'choice')
  assert.equal(
    extractTextFromAdaptaPayload('data: {"type":"text-delta","delta":"O"}\n\ndata: {"type":"text-delta","delta":"K"}\n\ndata: [DONE]\n\n'),
    'OK',
  )
})

test('formats Adapta refinement questions with options', () => {
  const content = formatRefinementQuestions({
    data: {
      questions: [
        {
          question: 'Qual nivel de detalhe voce quer?',
          options: [
            { label: 'Resumo' },
            { label: 'Detalhado' },
          ],
        },
        {
          title: 'Qual formato?',
          choices: ['Lista', 'Tabela', 'Texto corrido'],
        },
      ],
    },
  })

  assert.match(content, /A Adapta pediu refinamento/)
  assert.match(content, /1\. Qual nivel de detalhe/)
  assert.match(content, /A\. Resumo/)
  assert.match(content, /2\. Qual formato/)
  assert.match(content, /C\. Texto corrido/)
})

test('extracts Adapta refinement questions from SSE events', () => {
  const content = extractTextFromAdaptaPayload([
    'data: {"type":"form","payload":{"questions":[{"text":"Escolha o publico","options":["Tecnico","Executivo"]}]}}\n\n',
    'data: [DONE]\n\n',
  ].join(''))

  assert.match(content, /Escolha o publico/)
  assert.match(content, /A\. Tecnico/)
  assert.match(content, /B\. Executivo/)
})

test('extracts structured Adapta refinement questions', () => {
  const questions = extractRefinementQuestionsFromAdaptaPayload([
    'data: {"type":"form","payload":{"questions":[{"text":"Escolha o publico","options":["Tecnico","Executivo"]}]}}\n\n',
    'data: [DONE]\n\n',
  ].join(''))

  assert.deepEqual(questions, [{
    question: 'Escolha o publico',
    options: ['Tecnico', 'Executivo'],
  }])
})

test('redacts auth secrets from logs and errors', () => {
  const redacted = redactSecrets('authorization: Bearer abc.def.ghi cookie: token=secret api_key=local-secret')
  assert.equal(redacted.includes('ghi'), false)
  assert.equal(redacted.includes('secret'), false)
  assert.match(redacted, /\[REDACTED\]/)
})

test('prepares Adapta payload with explicit chat and message ids', () => {
  const prepared = prepareAdaptaPayload({
    chatId: 'old-chat',
    id: 'old-chat',
    messages: [{
      id: 'old-message',
      role: 'user',
      parts: [{ type: 'text', text: 'old' }],
    }],
    messageId: 'old-message',
  }, 'new prompt', 'chat-1', 'message-1')

  assert.deepEqual(prepared, {
    chatId: 'chat-1',
    messageId: 'message-1',
    body: {
      chatId: 'chat-1',
      id: 'chat-1',
      messages: [{
        id: 'message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'new prompt' }],
      }],
      messageId: 'message-1',
    },
  })
})

test('default Adapta chat request does not create discovery chats', () => {
  const request = getDefaultAdaptaChatRequest()
  const serialized = JSON.stringify(request)

  assert.equal(request.url.endsWith('/api/chat/stream/v1'), true)
  assert.equal(serialized.includes('__adaptaproxy_discovery__'), false)
})

test('applies project folder id to Adapta payload', () => {
  assert.deepEqual(
    applyProjectFolderToPayload({ chatId: 'chat-1', messages: [] }, 'folder-1'),
    { chatId: 'chat-1', messages: [], folderId: 'folder-1' },
  )

  assert.equal(applyProjectFolderToPayload(null, 'folder-1'), null)
})

test('persists Adapta session key to remote chat id mapping', () => {
  const key = `test-session-${Date.now()}`
  const first = touchAdaptaChatSessionMapping({
    key,
    remoteChatId: 'remote-chat-1',
    title: 'Mapped chat',
  })
  assert.equal(first.key, key)
  assert.equal(first.remoteChatId, 'remote-chat-1')

  const second = touchAdaptaChatSessionMapping({
    key,
    remoteChatId: 'remote-chat-2',
  })
  assert.equal(second.id, first.id)
  assert.equal(getAdaptaChatSessionByKey(key)?.remoteChatId, 'remote-chat-2')
})

test('/adaptaproxy/api/v1/models lists Adapta models with GPT_55 as default', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: {
      text: {
        views: {
          general: {
            models: [
              { key: 'GPT_54', label: 'GPT-5.4', enabled: true, order: 1, familyKey: 'GPT' },
            ],
          },
          workspace: {
            models: [
              { key: 'GPT_55', label: 'GPT-5.5', enabled: true, order: 0, familyKey: 'GPT' },
            ],
          },
        },
      },
    },
  }))) as typeof fetch

  try {
    const response = await app.request('/adaptaproxy/api/v1/models', {
      headers: createTestAuthHeaders(),
    })
    assert.equal(response.status, 200)

    const body = await response.json() as any
    assert.equal(body.object, 'list')
    assert.equal(body.data[0].id, 'GPT_55')
    assert.equal(body.data[0].default, true)
    assert.ok(body.data.some((model: any) => model.id === 'GPT_54'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('/adaptaproxy/api/v1/adapta/chats creates, lists, reads, and deletes chat sessions', async () => {
  const authHeaders = createTestAuthHeaders()
  const createResponse = await app.request('/adaptaproxy/api/v1/adapta/chats', {
    method: 'POST',
    body: JSON.stringify({ id: 'chat-test', title: 'Test chat' }),
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
  })
  assert.equal(createResponse.status, 201)

  const created = await createResponse.json() as any
  assert.equal(created.id, 'chat-test')
  assert.equal(created.title, 'Test chat')

  const listResponse = await app.request('/adaptaproxy/api/v1/adapta/chats', { headers: authHeaders })
  const list = await listResponse.json() as any
  assert.ok(list.data.some((chat: any) => chat.id === 'chat-test'))

  const getResponse = await app.request('/adaptaproxy/api/v1/adapta/chats/chat-test', { headers: authHeaders })
  assert.equal(getResponse.status, 200)

  const deleteResponse = await app.request('/adaptaproxy/api/v1/adapta/chats/chat-test', {
    method: 'DELETE',
    headers: authHeaders,
  })
  const deleted = await deleteResponse.json() as any
  assert.equal(deleted.deleted, true)
})

test('/adaptaproxy/doctor reports mock Adapta diagnostics', async () => {
  process.env.TEST_MOCK_PLAYWRIGHT = '1'
  try {
    const response = await app.request('/adaptaproxy/doctor')
    assert.equal(response.status, 200)

    const body = await response.json() as any
    assert.notEqual(body.status, 'unhealthy')
    assert.equal(body.adapta.playwrightInitialized, true)
    assert.equal(body.adapta.authenticated, true)
    assert.equal(body.adapta.authorizationCaptured, true)
    assert.equal(typeof body.chats.persistedSessions, 'number')
  } finally {
    delete process.env.TEST_MOCK_PLAYWRIGHT
  }
})
