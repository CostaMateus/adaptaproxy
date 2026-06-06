import { config } from '../core/config.ts'
import { newAdaptaMessageId, touchAdaptaChatSession } from '../core/chat-sessions.ts'
import type { Message } from '../utils/types.ts'
import {
  getDefaultAdaptaChatRequest,
  getAdaptaProjectFolderById,
  getAdaptaProjectFolderByName,
  getAdaptaSessionHeaders,
  getCachedAdaptaChatRequest,
} from './playwright.ts'

export interface AdaptaRequestOptions {
  chatId?: string
  projectName?: string
  folderId?: string
}

export interface AdaptaCompletion {
  content: string
  raw: unknown
  chatId: string
  messageId: string
  refinementQuestions: AdaptaRefinementQuestion[]
}

export interface AdaptaStreamCompletion {
  chatId: string
  messageId: string
  content: string
  raw: string
  refinementQuestions: AdaptaRefinementQuestion[]
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

export function applyProjectFolderToPayload(payload: unknown, folderId: string): unknown {
  if (!folderId || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  return {
    ...(payload as Record<string, unknown>),
    folderId,
  }
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

  const refinementText = formatRefinementQuestions(payload)
  if (refinementText) return refinementText

  return ''
}

export function extractRefinementQuestionsFromAdaptaPayload(payload: unknown): AdaptaRefinementQuestion[] {
  if (typeof payload === 'string') return extractRefinementQuestionsFromSse(payload)
  return extractRefinementQuestions(payload)
}

export function extractTextFromSse(raw: string): string {
  let text = ''
  const events: unknown[] = []

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue

    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue

    try {
      const event = JSON.parse(data)
      events.push(event)
      if (event?.type === 'text-delta' && typeof event.delta === 'string') {
        text += event.delta
      } else if (event?.type === 'text' && typeof event.text === 'string') {
        text += event.text
      }
    } catch {
      // Ignore non-JSON SSE frames.
    }
  }

  return text || formatRefinementQuestions(events)
}

export function extractRefinementQuestionsFromSse(raw: string): AdaptaRefinementQuestion[] {
  const events: unknown[] = []

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue

    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue

    try {
      events.push(JSON.parse(data))
    } catch {
      // Ignore non-JSON SSE frames.
    }
  }

  return extractRefinementQuestions(events)
}

export interface AdaptaRefinementQuestion {
  question: string
  options: string[]
}

export function formatRefinementQuestions(payload: unknown): string {
  const questions = extractRefinementQuestions(payload)
  if (!questions.length) return ''

  const lines = [
    'A Adapta pediu refinamento antes de responder. Escolha uma opcao para cada pergunta e envie a resposta neste mesmo chat.',
    '',
  ]

  questions.forEach((item, questionIndex) => {
    lines.push(`${questionIndex + 1}. ${item.question}`)
    item.options.forEach((option, optionIndex) => {
      lines.push(`   ${String.fromCharCode(65 + optionIndex)}. ${option}`)
    })
    lines.push('')
  })

  return lines.join('\n').trim()
}

export function extractRefinementQuestions(payload: unknown): AdaptaRefinementQuestion[] {
  const seen = new Set<unknown>()
  const output: AdaptaRefinementQuestion[] = []

  function visit(value: unknown): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)

    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }

    const record = value as Record<string, unknown>
    const direct = questionFromRecord(record)
    if (direct) output.push(direct)

    for (const child of Object.values(record)) {
      visit(child)
    }
  }

  visit(payload)
  return dedupeQuestions(output)
}

function questionFromRecord(record: Record<string, unknown>): AdaptaRefinementQuestion | null {
  const options = extractOptionList(record)
  if (options.length < 2) return null

  const question = firstString(record, [
    'question',
    'pergunta',
    'title',
    'label',
    'text',
    'content',
    'message',
    'prompt',
    'description',
  ])
  if (!question) return null

  return { question, options }
}

function extractOptionList(record: Record<string, unknown>): string[] {
  for (const key of ['options', 'choices', 'answers', 'suggestions', 'items']) {
    const value = record[key]
    if (!Array.isArray(value)) continue

    const options = value
      .map(optionToText)
      .filter((option): option is string => Boolean(option))

    if (options.length) return options
  }

  return []
}

function optionToText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  return firstString(value as Record<string, unknown>, [
    'label',
    'title',
    'text',
    'content',
    'value',
    'name',
    'description',
  ])
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function dedupeQuestions(questions: AdaptaRefinementQuestion[]): AdaptaRefinementQuestion[] {
  const seen = new Set<string>()
  return questions.filter(item => {
    const key = `${item.question}\n${item.options.join('\n')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function buildAdaptaRequest(prompt: string, options: AdaptaRequestOptions = {}): Promise<{
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  chatId: string
  messageId: string
}> {
  const captured = getCachedAdaptaChatRequest() ?? getDefaultAdaptaChatRequest()
  const sessionHeaders = await getAdaptaSessionHeaders()
  const session = touchAdaptaChatSession(options.chatId || newAdaptaMessageId())
  const prepared = prepareAdaptaPayload(captured.postData, prompt, session.id)
  const projectFolderId = await resolveProjectFolderId(options)
  const requestBody = projectFolderId
    ? applyProjectFolderToPayload(prepared.body, projectFolderId)
    : prepared.body

  return {
    url: captured.url,
    method: captured.method,
    headers: {
      ...captured.headers,
      ...sessionHeaders,
    },
    body: requestBody,
    chatId: prepared.chatId,
    messageId: prepared.messageId,
  }
}

export async function createAdaptaCompletion(prompt: string, options: AdaptaRequestOptions = {}): Promise<AdaptaCompletion> {
  const request = await buildAdaptaRequest(prompt, options)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeouts.chat)

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
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
    const refinementQuestions = extractRefinementQuestionsFromAdaptaPayload(raw)
    if (!content) {
      throw new AdaptaUpstreamError(
        `Adapta response did not contain recognizable assistant text: ${rawText.slice(0, 500)}`,
        502,
      )
    }

    return { content, raw, chatId: request.chatId, messageId: request.messageId, refinementQuestions }
  } finally {
    clearTimeout(timeout)
  }
}

export async function createAdaptaCompletionStream(
  prompt: string,
  options: AdaptaRequestOptions,
  onText: (chunk: string) => Promise<void> | void,
): Promise<AdaptaStreamCompletion> {
  const request = await buildAdaptaRequest(prompt, options)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeouts.chat)
  let raw = ''
  let content = ''

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const rawText = await response.text()
      throw new AdaptaUpstreamError(
        `Adapta upstream error: ${response.status} ${response.statusText} - ${rawText.slice(0, 500)}`,
        response.status,
      )
    }

    if (!response.body) {
      const rawText = await response.text()
      const text = extractTextFromAdaptaPayload(rawText)
      if (text) await onText(text)
      return {
        content: text,
        raw: rawText,
        chatId: request.chatId,
        messageId: request.messageId,
        refinementQuestions: extractRefinementQuestionsFromAdaptaPayload(rawText),
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const decoded = decoder.decode(value, { stream: true })
      raw += decoded
      buffer += decoded

      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''

      for (const line of lines) {
        const text = extractTextDeltaFromSseLine(line)
        if (!text) continue
        content += text
        await onText(text)
      }
    }

    const tail = decoder.decode()
    if (tail) {
      raw += tail
      buffer += tail
    }

    if (buffer) {
      const text = extractTextDeltaFromSseLine(buffer)
      if (text) {
        content += text
        await onText(text)
      }
    }

    if (!content) {
      content = extractTextFromAdaptaPayload(raw)
      if (content) await onText(content)
    }

    if (!content) {
      throw new AdaptaUpstreamError(
        `Adapta response did not contain recognizable assistant text: ${raw.slice(0, 500)}`,
        502,
      )
    }

    return {
      content,
      raw,
      chatId: request.chatId,
      messageId: request.messageId,
      refinementQuestions: extractRefinementQuestionsFromAdaptaPayload(raw),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function extractTextDeltaFromSseLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return ''

  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return ''

  try {
    const event = JSON.parse(data)
    if (event?.type === 'text-delta' && typeof event.delta === 'string') return event.delta
    if (event?.type === 'text' && typeof event.text === 'string') return event.text
  } catch {
    return ''
  }

  return ''
}

async function resolveProjectFolderId(options: AdaptaRequestOptions = {}): Promise<string | null> {
  if (options.folderId) {
    const project = await getAdaptaProjectFolderById(options.folderId)
    if (!project) {
      throw new Error(`Adapta project folder "${options.folderId}" was not found. Remove metadata.adapta_folder_id or choose a valid folder.`)
    }
    return project.id
  }

  const projectName = options.projectName || config.adapta.projectName
  if (!projectName) return null

  const project = await getAdaptaProjectFolderByName(projectName)
  if (!project) {
    throw new Error(`Adapta project "${projectName}" was not found. Clear ADAPTA_PROJECT_NAME or remove metadata.adapta_project_name to use the default Chats menu.`)
  }

  return project.id
}

export interface AdaptaRemoteChat {
  id: string
  title?: string
  folderId?: string
  createdAt?: unknown
  updatedAt?: unknown
  raw: unknown
}

export async function listAdaptaRemoteChats(options: {
  folderId?: string
  projectName?: string
  limit?: number
  page?: number
} = {}): Promise<AdaptaRemoteChat[]> {
  const headers = await getAdaptaSessionHeaders()
  const folderId = await resolveProjectFolderId({
    folderId: options.folderId,
    projectName: options.projectName,
  })
  const url = new URL(`${config.adapta.baseUrl}/api/chat/v2`)
  url.searchParams.set('limit', String(options.limit || 20))
  url.searchParams.set('page', String(options.page || 1))
  if (folderId) url.searchParams.set('folderId', folderId)

  const response = await fetch(url, { headers })
  const rawText = await response.text()
  if (!response.ok) {
    throw new AdaptaUpstreamError(
      `Adapta upstream error: ${response.status} ${response.statusText} - ${rawText.slice(0, 500)}`,
      response.status,
    )
  }

  const payload = JSON.parse(rawText)
  const items = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.data?.items)
      ? payload.data.items
      : Array.isArray(payload?.data?.paginatedChats)
        ? payload.data.paginatedChats
        : Array.isArray(payload?.items)
          ? payload.items
          : []

  return items
    .filter((item: any) => typeof item?.id === 'string' || typeof item?.chatId === 'string')
    .map((item: any) => ({
      id: item.id || item.chatId,
      title: item.title || item.name || item.lastMessage?.content,
      folderId: item.folderId,
      createdAt: item.createdAt || item.created_at,
      updatedAt: item.updatedAt || item.updated_at,
      raw: item,
    }))
}

export async function deleteAdaptaRemoteChat(chatId: string): Promise<boolean> {
  const headers = await getAdaptaSessionHeaders()
  const candidates = [
    `${config.adapta.baseUrl}/api/chat/${encodeURIComponent(chatId)}/v1`,
    `${config.adapta.baseUrl}/api/chat/v1/${encodeURIComponent(chatId)}`,
    `${config.adapta.baseUrl}/api/chat/v2/${encodeURIComponent(chatId)}`,
  ]

  let lastError = ''
  for (const url of candidates) {
    const response = await fetch(url, { method: 'DELETE', headers })
    if (response.ok || response.status === 204) return true
    lastError = `${response.status} ${response.statusText} - ${(await response.text()).slice(0, 300)}`
    if (![404, 405].includes(response.status)) break
  }

  throw new AdaptaUpstreamError(
    `Could not delete Adapta remote chat "${chatId}". Tried known internal endpoints. Last response: ${lastError}`,
    502,
  )
}
