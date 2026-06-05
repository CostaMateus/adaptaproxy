import assert from 'node:assert/strict'
import test from 'node:test'
import { app } from '../api/server.ts'
import {
  extractTextFromAdaptaPayload,
  openAiMessagesToPrompt,
  replacePromptInPayload,
} from '../services/adapta.ts'

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

test('/v1/models returns adapta-chat', async () => {
  const response = await app.request('/v1/models')
  assert.equal(response.status, 200)

  const body = await response.json() as any
  assert.equal(body.object, 'list')
  assert.equal(body.data[0].id, 'adapta-chat')
  assert.equal(body.data[0].owned_by, 'adapta')
})
