import { config } from '../core/config.ts'
import { newAdaptaMessageId, touchAdaptaChatSession } from '../core/chat-sessions.ts'
import type { Message } from '../utils/types.ts'
import { discoverAdaptaChatRequest, getAdaptaSessionHeaders, getCachedAdaptaChatRequest } from './playwright.ts'

export interface AdaptaCompletion {
  content: string
  raw: unknown
  chatId: string
  messageId: string
}

export class AdaptaUpstreamError extends Error {
  readonly upstreamStatus: number

  constructor(message: string, upstreamStatus: number) {
    super(message)
    this.name = 'AdaptaUpstreamError'
    this.upstreamStatus = upstreamStatus
  }
}

export function openAiMessagesToPrompt(messages: Message[]): string {
  return messages
    .map(message => {
      const content = stringifyMessageContent(message.content)
      switch (message.role) {
        case 'system':
          return `System: ${content}`
        case 'assistant':
          return `Assistant: ${content}`
        case 'user':
          return `User: ${content}`
        case 'tool':
        case 'function':
          return `Tool Response${message.name ? ` (${message.name})` : ''}: ${content}`
        default:
          return `${message.role}: ${content}`
      }
    })
    .filter(Boolean)
    .join('\n\n')
}

function stringifyMessageContent(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text)
      return JSON.stringify(part)
    }).join('\n')
  }
  return JSON.stringify(content)
}

export function replacePromptInPayload(payload: unknown, prompt: string): unknown {
  const state = { replaced: false }
  const replaced = replacePromptDeep(payload, prompt, state)

  if (state.replaced) return replaced
  if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) {
    return { ...(replaced as Record<string, unknown>), message: prompt }
  }
  return { message: prompt }
}

export function prepareAdaptaPayload(payload: unknown, prompt: string, chatId: string, messageId = newAdaptaMessageId()): {
  body: unknown
  chatId: string
  messageId: string
} {
  const body = replacePromptInPayload(payload, prompt)
  const patched = replaceIdsInPayload(body, chatId, messageId)
  return { body: patched, chatId, messageId }
}

function replaceIdsInPayload(payload: unknown, chatId: string, messageId: string): unknown {
  if (Array.isArray(payload)) {
    return payload.map(value => replaceIdsInPayload(value, chatId, messageId))
  }
  if (!payload || typeof payload !== 'object') return payload

  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (key === 'chatId' || key === 'id') {
      output[key] = chatId
      continue
    }
    if (key === 'messageId') {
      output[key] = messageId
      continue
    }
    if (key === 'messages' && Array.isArray(value)) {
      output[key] = value.map(message => {
        if (!message || typeof message !== 'object') return message
        const record = { ...(message as Record<string, unknown>) }
        if (record.role === 'user' || record.id) record.id = messageId
        return replaceNestedIdsInMessage(record, chatId, messageId)
      })
      continue
    }
    output[key] = replaceIdsInPayload(value, chatId, messageId)
  }
  return output
}

function replaceNestedIdsInMessage(payload: unknown, chatId: string, messageId: string): unknown {
  if (Array.isArray(payload)) {
    return payload.map(value => replaceNestedIdsInMessage(value, chatId, messageId))
  }
  if (!payload || typeof payload !== 'object') return payload

  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (key === 'id' || key === 'messageId') {
      output[key] = messageId
      continue
    }
    if (key === 'chatId') {
      output[key] = chatId
      continue
    }
    output[key] = replaceNestedIdsInMessage(value, chatId, messageId)
  }
  return output
}

function replacePromptDeep(payload: unknown, prompt: string, state: { replaced: boolean }, key = ''): unknown {
  if (payload == null) return payload
  if (typeof payload === 'string') {
    if (isPromptKey(key)) {
      state.replaced = true
      return prompt
    }
    return payload
  }
  if (Array.isArray(payload)) {
    return payload.map(value => replacePromptDeep(value, prompt, state, key))
  }
  if (typeof payload !== 'object') return payload

  const input = payload as Record<string, unknown>
  const output: Record<string, unknown> = {}

  for (const [childKey, value] of Object.entries(input)) {
    if (Array.isArray(value) && childKey === 'messages') {
      output[childKey] = replaceMessagesArray(value, prompt)
      state.replaced = true
      continue
    }

    output[childKey] = replacePromptDeep(value, prompt, state, childKey)
  }

  return output
}

function isPromptKey(key: string): boolean {
  return [
    'message',
    'prompt',
    'query',
    'content',
    'text',
    'input',
    'userMessage',
    'user_message',
  ].includes(key)
}

function replaceMessagesArray(messages: unknown[], prompt: string): unknown[] {
  if (messages.length === 0) return [{ role: 'user', content: prompt }]

  const cloned = messages.map(message => {
    if (!message || typeof message !== 'object') return message
    return { ...(message as Record<string, unknown>) }
  })

  for (let index = cloned.length - 1; index >= 0; index--) {
    const message = cloned[index]
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    if (record.role === 'user' || typeof record.content === 'string' || typeof record.message === 'string') {
      if (Array.isArray(record.parts)) {
        record.parts = record.parts.map(part => {
          if (!part || typeof part !== 'object') return part
          const partRecord = { ...(part as Record<string, unknown>) }
          if (typeof partRecord.text === 'string') partRecord.text = prompt
          return partRecord
        })
      } else if ('content' in record) {
        record.content = prompt
      } else if ('message' in record) {
        record.message = prompt
      } else {
        record.content = prompt
      }
      return cloned
    }
  }

  cloned.push({ role: 'user', content: prompt })
  return cloned
}

export function extractTextFromAdaptaPayload(payload: unknown): string {
  if (typeof payload === 'string') return extractTextFromSse(payload) || payload
  if (!payload || typeof payload !== 'object') return ''

  const record = payload as Record<string, unknown>
  const directKeys = ['content', 'text', 'message', 'answer', 'response', 'output', 'result']
  for (const key of directKeys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }

  const nestedKeys = ['data', 'payload', 'assistant', 'completion']
  for (const key of nestedKeys) {
    const nested = extractTextFromAdaptaPayload(record[key])
    if (nested) return nested
  }

  if (Array.isArray(record.messages)) {
    for (let index = record.messages.length - 1; index >= 0; index--) {
      const text = extractTextFromAdaptaPayload(record.messages[index])
      if (text) return text
    }
  }

  if (Array.isArray(record.choices)) {
    const first = record.choices[0] as Record<string, unknown> | undefined
    const text = extractTextFromAdaptaPayload(first?.message ?? first?.delta ?? first)
    if (text) return text
  }

  return ''
}

export function extractTextFromSse(raw: string): string {
  let text = ''

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue

    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue

    try {
      const event = JSON.parse(data)
      if (event?.type === 'text-delta' && typeof event.delta === 'string') {
        text += event.delta
      } else if (event?.type === 'text' && typeof event.text === 'string') {
        text += event.text
      }
    } catch {
      // Ignore non-JSON SSE frames.
    }
  }

  return text
}

export async function createAdaptaCompletion(prompt: string, requestedChatId?: string): Promise<AdaptaCompletion> {
  const captured = getCachedAdaptaChatRequest() ?? await discoverAdaptaChatRequest('__adaptaproxy_discovery__')
  const sessionHeaders = await getAdaptaSessionHeaders()
  const session = touchAdaptaChatSession(requestedChatId || newAdaptaMessageId())
  const prepared = prepareAdaptaPayload(captured.postData, prompt, session.id)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeouts.chat)

  try {
    const response = await fetch(captured.url, {
      method: captured.method,
      headers: {
        ...captured.headers,
        ...sessionHeaders,
      },
      body: JSON.stringify(prepared.body),
      signal: controller.signal,
    })

    const contentType = response.headers.get('content-type') || ''
    const rawText = await response.text()

    if (!response.ok) {
      throw new AdaptaUpstreamError(
        `Adapta upstream error: ${response.status} ${response.statusText} - ${rawText.slice(0, 500)}`,
        response.status,
      )
    }

    const raw = contentType.includes('application/json') ? JSON.parse(rawText) : rawText
    const content = extractTextFromAdaptaPayload(raw)
    if (!content) {
      throw new AdaptaUpstreamError(
        `Adapta response did not contain recognizable assistant text: ${rawText.slice(0, 500)}`,
        502,
      )
    }

    return { content, raw, chatId: prepared.chatId, messageId: prepared.messageId }
  } finally {
    clearTimeout(timeout)
  }
}
