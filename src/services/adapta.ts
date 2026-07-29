import { config } from '../core/config.ts'
import { logger } from '../core/logger.ts'
import {
  getAdaptaChatSessionByKey,
  newAdaptaMessageId,
  setAdaptaChatSessionsFile,
  touchAdaptaChatSession,
  touchAdaptaChatSessionMapping,
} from '../core/chat-sessions.ts'
import type { Message } from '../utils/types.ts'
import {
  getDefaultAdaptaChatRequest,
  ensureAdaptaProjectFolder,
  getAdaptaProjectFolderById,
  getAdaptaProjectFolderByName,
  getAdaptaSessionHeaders,
  getCachedAdaptaChatRequestForAccount,
  refreshAdaptaSession,
  usePlaywrightAccount,
} from './playwright.ts'
import { AdaptaAccountContext } from './adapta-account-resolver.ts'

export type AdaptaPromptMode = 'full' | 'structured' | 'last_user'

export interface AdaptaRequestOptions {
  account?: AdaptaAccountContext
  requestId?: string
  promptMode?: AdaptaPromptMode
  messages?: Message[]
  chatId?: string
  sessionKey?: string
  newChat?: boolean
  projectName?: string
  folderId?: string
}

export interface AdaptaCompletion {
  content: string
  reasoningContent?: string
  raw: unknown
  chatId: string
  messageId: string
  refinementQuestions: AdaptaRefinementQuestion[]
}

export interface AdaptaStreamCompletion {
  chatId: string
  messageId: string
  content: string
  reasoningContent?: string
  raw: string
  refinementQuestions: AdaptaRefinementQuestion[]
}

export interface AdaptaStreamDelta {
  type: 'text' | 'reasoning'
  content: string
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

export function lastUserMessageToPrompt(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== 'user') continue
    return extractClineTask(stringifyMessageContent(messages[index].content))
  }

  const lastMessage = messages[messages.length - 1]
  return lastMessage ? extractClineTask(stringifyMessageContent(lastMessage.content)) : ''
}

function extractClineTask(content: string): string {
  const task = content.match(/<task>\s*([\s\S]*?)\s*<\/task>/i)
  return task?.[1]?.trim() || content
}

export interface AdaptaStructuredMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  parts: Array<{ type: 'text', text: string }>
}

export function openAiMessagesToAdaptaMessages(
  messages: Message[],
  finalMessageId: string,
): AdaptaStructuredMessage[] {
  return messages.map((message, index) => {
    const originalRole = message.role
    const role = originalRole === 'system' || originalRole === 'assistant'
      ? originalRole
      : 'user'
    let content = stringifyMessageContent(message.content)

    if (originalRole === 'tool' || originalRole === 'function') {
      content = `Tool Response${message.name ? ` (${message.name})` : ''}: ${content}`
    } else if (!['system', 'user', 'assistant'].includes(originalRole)) {
      content = `${originalRole}: ${content}`
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const toolCalls = message.tool_calls.map(toolCall => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      }))
      content = [content, `Tool calls:\n${JSON.stringify(toolCalls)}`]
        .filter(Boolean)
        .join('\n\n')
    }

    return {
      id: index === messages.length - 1 ? finalMessageId : newAdaptaMessageId(),
      role,
      content,
      parts: [{ type: 'text', text: content }],
    }
  })
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

export function prepareAdaptaPayload(
  payload: unknown,
  prompt: string,
  chatId: string,
  messageId = newAdaptaMessageId(),
  options: {
    mode?: AdaptaPromptMode
    messages?: Message[]
  } = {},
): {
  body: unknown
  chatId: string
  messageId: string
} {
  const mode = options.mode || 'full'
  if (mode === 'structured') {
    if (!options.messages?.length) {
      throw new Error('Structured prompt mode requires at least one OpenAI message.')
    }
    const patched = replaceIdsInPayload(payload, chatId, messageId)
    const state = { replaced: false }
    const structuredMessages = openAiMessagesToAdaptaMessages(options.messages, messageId)
    const body = replaceMessagesInPayload(patched, structuredMessages, state)
    if (!state.replaced) {
      throw new Error('Structured prompt mode requires an Adapta payload with a messages array.')
    }
    return { body, chatId, messageId }
  }

  const lastUserPrompt = lastUserMessageToPrompt(options.messages || [])
  const effectivePrompt = mode === 'last_user' && lastUserPrompt
    ? lastUserPrompt
    : prompt
  const body = replacePromptInPayload(payload, effectivePrompt)
  const patched = replaceIdsInPayload(body, chatId, messageId)
  return { body: patched, chatId, messageId }
}

function replaceMessagesInPayload(
  payload: unknown,
  messages: AdaptaStructuredMessage[],
  state: { replaced: boolean },
): unknown {
  if (Array.isArray(payload)) {
    return payload.map(value => replaceMessagesInPayload(value, messages, state))
  }
  if (!payload || typeof payload !== 'object') return payload

  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (key === 'messages' && Array.isArray(value)) {
      output[key] = messages
      state.replaced = true
      continue
    }
    output[key] = replaceMessagesInPayload(value, messages, state)
  }
  return output
}

export function applyProjectFolderToPayload(payload: unknown, folderId: string): unknown {
  if (!folderId || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  return {
    ...(payload as Record<string, unknown>),
    folderId,
  }
}

export function removeProjectFolderFromPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const { folderId: _folderId, ...rootChatPayload } = payload as Record<string, unknown>
  return rootChatPayload
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
      let replaced = false
      if (Array.isArray(record.parts)) {
        record.parts = record.parts.map(part => {
          if (!part || typeof part !== 'object') return part
          const partRecord = { ...(part as Record<string, unknown>) }
          if (typeof partRecord.text === 'string') partRecord.text = prompt
          return partRecord
        })
        replaced = true
      }
      if ('content' in record) {
        record.content = prompt
        replaced = true
      }
      if ('message' in record) {
        record.message = prompt
        replaced = true
      }
      if (!replaced) {
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

async function buildAdaptaRequest(prompt: string, options: AdaptaRequestOptions = {}): Promise<PreparedAdaptaRequest> {
  const startedAt = Date.now()
  const promptMode = options.promptMode || config.adapta.promptMode
  adaptaLogger.info('request.preparation.started', adaptaLogData(options, {
    accountMode: options.account?.mode || 'default',
    promptMode,
    messageCount: options.messages?.length || 0,
    requestedChatMode: options.chatId ? 'specific' : options.newChat ? 'new' : 'reuse',
    hasProjectName: Boolean(options.projectName),
    hasFolderId: Boolean(options.folderId),
  }))
  if (options.account) {
    setAdaptaChatSessionsFile(options.account.chatSessionsFile)
    const browserStartedAt = Date.now()
    adaptaLogger.info('browser.account_activation.started', adaptaLogData(options))
    await usePlaywrightAccount({
      accountKey: options.account.userId || options.account.userKey,
      profileDir: options.account.profileDir,
      email: options.account.email,
      password: options.account.password,
    })
    adaptaLogger.info('browser.account_activation.completed', adaptaLogData(options, {
      durationMs: Date.now() - browserStartedAt,
    }))
    if (options.account.projectName) {
      await ensureAdaptaProjectFolder(options.account.projectName, options.account.userId || options.account.userKey).catch(error => {
        adaptaLogger.warn('project.ensure_failed', adaptaLogData(options, { error }))
      })
    }
  }

  const accountKey = options.account?.userId || options.account?.userKey
  const captured = getCachedAdaptaChatRequestForAccount(accountKey) ?? getDefaultAdaptaChatRequest()
  adaptaLogger.info('session.headers_capture.started', adaptaLogData(options))
  const sessionHeaders = await getAdaptaSessionHeaders(accountKey)
  adaptaLogger.info('session.headers_capture.completed', adaptaLogData(options))
  const projectFolderId = await resolveProjectFolderId(options)
  const remoteChatId = await resolveAdaptaRemoteChatId(options)
  const prepared = prepareAdaptaPayload(
    captured.postData,
    prompt,
    remoteChatId,
    newAdaptaMessageId(),
    {
      mode: promptMode,
      messages: options.messages,
    },
  )
  const requestBody = projectFolderId
    ? applyProjectFolderToPayload(prepared.body, projectFolderId)
    : removeProjectFolderFromPayload(prepared.body)

  const request = {
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
  adaptaLogger.info('request.preparation.completed', adaptaLogData(options, {
    durationMs: Date.now() - startedAt,
    projectResolved: Boolean(projectFolderId),
    chatId: prepared.chatId,
    upstream: safeUpstreamTarget(captured.url),
  }))
  return request
}

interface PreparedAdaptaRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  chatId: string
  messageId: string
}

const adaptaLogger = logger.child('adapta')

function adaptaLogData(options: AdaptaRequestOptions, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.account?.userId ? { userId: options.account.userId } : {}),
    ...data,
  }
}

function safeUpstreamTarget(rawUrl: string): { host: string, path: string } {
  try {
    const url = new URL(rawUrl)
    return { host: url.host, path: url.pathname }
  } catch {
    return { host: 'invalid', path: 'invalid' }
  }
}

async function fetchAdaptaUpstream(
  request: PreparedAdaptaRequest,
  signal: AbortSignal,
  options: AdaptaRequestOptions,
  stream: boolean,
  attempt: number,
): Promise<Response> {
  const startedAt = Date.now()
  const target = safeUpstreamTarget(request.url)
  adaptaLogger.info('upstream.request.started', adaptaLogData(options, {
    method: request.method,
    host: target.host,
    path: target.path,
    stream,
    attempt,
  }))
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    })
    adaptaLogger.info('upstream.response.received', adaptaLogData(options, {
      method: request.method,
      host: target.host,
      path: target.path,
      stream,
      attempt,
      status: response.status,
      durationMs: Date.now() - startedAt,
      contentType: response.headers.get('content-type') || '',
    }))
    return response
  } catch (error) {
    adaptaLogger.error('upstream.request.failed', adaptaLogData(options, {
      method: request.method,
      host: target.host,
      path: target.path,
      stream,
      attempt,
      durationMs: Date.now() - startedAt,
      error,
    }))
    throw error
  }
}

export function extractReasoningFromAdaptaPayload(payload: unknown): string {
  if (typeof payload === 'string') return extractReasoningFromSse(payload)
  if (!payload || typeof payload !== 'object') return ''

  const record = payload as Record<string, unknown>
  for (const key of ['reasoning_content', 'reasoningContent', 'reasoning', 'thoughts']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }

  const nestedKeys = ['data', 'payload', 'assistant', 'completion']
  for (const key of nestedKeys) {
    const nested = extractReasoningFromAdaptaPayload(record[key])
    if (nested) return nested
  }

  if (Array.isArray(record.messages)) {
    for (let index = record.messages.length - 1; index >= 0; index--) {
      const text = extractReasoningFromAdaptaPayload(record.messages[index])
      if (text) return text
    }
  }

  if (Array.isArray(record.choices)) {
    const first = record.choices[0] as Record<string, unknown> | undefined
    const text = extractReasoningFromAdaptaPayload(first?.message ?? first?.delta ?? first)
    if (text) return text
  }

  return ''
}

export function extractReasoningFromSse(raw: string): string {
  let reasoning = ''

  for (const line of raw.split(/\r?\n/)) {
    const delta = extractDeltaFromSseLine(line)
    if (delta.type === 'reasoning') reasoning += delta.content
  }

  return reasoning
}

async function resolveAdaptaRemoteChatId(
  options: AdaptaRequestOptions,
): Promise<string> {
  if (options.chatId) {
    touchAdaptaChatSession(options.chatId)
    return options.chatId
  }

  const sessionKey = (options.sessionKey || config.chats.defaultChatId || 'default').trim() || 'default'
  const existing = getAdaptaChatSessionByKey(sessionKey)
  if (!options.newChat && existing?.remoteChatId) {
    existing.updatedAt = Date.now()
    touchAdaptaChatSessionMapping({
      key: sessionKey,
      remoteChatId: existing.remoteChatId,
      title: existing.title,
    })
    return existing.remoteChatId
  }

  const remoteChatId = newAdaptaMessageId()
  touchAdaptaChatSessionMapping({
    key: sessionKey,
    remoteChatId,
    title: `Adaptaproxy ${sessionKey}`,
  })
  return remoteChatId
}

export async function createAdaptaCompletion(prompt: string, options: AdaptaRequestOptions = {}): Promise<AdaptaCompletion> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeouts.chat)

  try {
    let request = await buildAdaptaRequest(prompt, options)
    let response = await fetchAdaptaUpstream(request, controller.signal, options, false, 1)

    if (response.status === 401) {
      adaptaLogger.warn('session.refresh.started', adaptaLogData(options, {
        reason: 'upstream_401',
        stream: false,
      }))
      await response.body?.cancel().catch(() => {})
      await refreshAdaptaSession(options.account?.userId || options.account?.userKey)
      adaptaLogger.info('session.refresh.completed', adaptaLogData(options, {
        reason: 'upstream_401',
        stream: false,
      }))
      request = await buildAdaptaRequest(prompt, options)
      response = await fetchAdaptaUpstream(request, controller.signal, options, false, 2)
    }

    const contentType = response.headers.get('content-type') || ''
    const rawText = await response.text()

    if (!response.ok) {
      throw new AdaptaUpstreamError(
        `Adapta upstream error: ${response.status} ${response.statusText}`,
        response.status,
      )
    }

    const raw = contentType.includes('application/json') ? JSON.parse(rawText) : rawText
    const content = extractTextFromAdaptaPayload(raw)
    const reasoningContent = extractReasoningFromAdaptaPayload(raw) || undefined
    const refinementQuestions = extractRefinementQuestionsFromAdaptaPayload(raw)
    if (!content) {
      throw new AdaptaUpstreamError(
        'Adapta response did not contain recognizable assistant text',
        502,
      )
    }

    adaptaLogger.info('completion.parsed', adaptaLogData(options, {
      stream: false,
      status: response.status,
      durationMs: Date.now() - startedAt,
      chatId: request.chatId,
      contentLength: content.length,
      reasoningLength: reasoningContent?.length || 0,
      refinementQuestionCount: refinementQuestions.length,
    }))
    return { content, reasoningContent, raw, chatId: request.chatId, messageId: request.messageId, refinementQuestions }
  } catch (error) {
    adaptaLogger.error('completion.failed', adaptaLogData(options, {
      stream: false,
      durationMs: Date.now() - startedAt,
      error,
    }))
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function createAdaptaCompletionStream(
  prompt: string,
  options: AdaptaRequestOptions,
  onDelta: (delta: AdaptaStreamDelta) => Promise<void> | void,
): Promise<AdaptaStreamCompletion> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeouts.chat)
  let raw = ''
  let content = ''
  let reasoningContent = ''

  try {
    let request = await buildAdaptaRequest(prompt, options)
    let response = await fetchAdaptaUpstream(request, controller.signal, options, true, 1)

    if (response.status === 401) {
      adaptaLogger.warn('session.refresh.started', adaptaLogData(options, {
        reason: 'upstream_401',
        stream: true,
      }))
      await response.body?.cancel().catch(() => {})
      await refreshAdaptaSession(options.account?.userId || options.account?.userKey)
      adaptaLogger.info('session.refresh.completed', adaptaLogData(options, {
        reason: 'upstream_401',
        stream: true,
      }))
      request = await buildAdaptaRequest(prompt, options)
      response = await fetchAdaptaUpstream(request, controller.signal, options, true, 2)
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new AdaptaUpstreamError(
        `Adapta upstream error: ${response.status} ${response.statusText}`,
        response.status,
      )
    }

    if (!response.body) {
      const rawText = await response.text()
      const text = extractTextFromAdaptaPayload(rawText)
      const reasoning = extractReasoningFromAdaptaPayload(rawText)
      if (reasoning) await onDelta({ type: 'reasoning', content: reasoning })
      if (text) await onDelta({ type: 'text', content: text })
      const refinementQuestions = extractRefinementQuestionsFromAdaptaPayload(rawText)
      adaptaLogger.info('completion.parsed', adaptaLogData(options, {
        stream: true,
        status: response.status,
        durationMs: Date.now() - startedAt,
        chatId: request.chatId,
        contentLength: text.length,
        reasoningLength: reasoning.length,
        refinementQuestionCount: refinementQuestions.length,
      }))
      return {
        content: text,
        reasoningContent: reasoning || undefined,
        raw: rawText,
        chatId: request.chatId,
        messageId: request.messageId,
        refinementQuestions,
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
        const delta = extractDeltaFromSseLine(line)
        if (!delta.content) continue
        if (delta.type === 'reasoning') {
          reasoningContent += delta.content
        } else {
          content += delta.content
        }
        await onDelta(delta)
      }
    }

    const tail = decoder.decode()
    if (tail) {
      raw += tail
      buffer += tail
    }

    if (buffer) {
      const delta = extractDeltaFromSseLine(buffer)
      if (delta.content) {
        if (delta.type === 'reasoning') {
          reasoningContent += delta.content
        } else {
          content += delta.content
        }
        await onDelta(delta)
      }
    }

    if (!content) {
      content = extractTextFromAdaptaPayload(raw)
      reasoningContent = reasoningContent || extractReasoningFromAdaptaPayload(raw)
      if (reasoningContent) await onDelta({ type: 'reasoning', content: reasoningContent })
      if (content) await onDelta({ type: 'text', content })
    }

    if (!content) {
      throw new AdaptaUpstreamError(
        'Adapta response did not contain recognizable assistant text',
        502,
      )
    }

    const refinementQuestions = extractRefinementQuestionsFromAdaptaPayload(raw)
    adaptaLogger.info('completion.parsed', adaptaLogData(options, {
      stream: true,
      status: response.status,
      durationMs: Date.now() - startedAt,
      chatId: request.chatId,
      contentLength: content.length,
      reasoningLength: reasoningContent.length,
      refinementQuestionCount: refinementQuestions.length,
    }))
    return {
      content,
      reasoningContent: reasoningContent || undefined,
      raw,
      chatId: request.chatId,
      messageId: request.messageId,
      refinementQuestions,
    }
  } catch (error) {
    adaptaLogger.error('completion.failed', adaptaLogData(options, {
      stream: true,
      durationMs: Date.now() - startedAt,
      error,
    }))
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function extractDeltaFromSseLine(line: string): AdaptaStreamDelta {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return { type: 'text', content: '' }

  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return { type: 'text', content: '' }

  try {
    const event = JSON.parse(data)
    if (event?.type === 'reasoning-delta' && typeof event.delta === 'string') {
      return { type: 'reasoning', content: event.delta }
    }
    if (event?.type === 'text-delta' && typeof event.delta === 'string') {
      return { type: 'text', content: event.delta }
    }
    if (event?.type === 'text' && typeof event.text === 'string') {
      return { type: 'text', content: event.text }
    }
  } catch {
    return { type: 'text', content: '' }
  }

  return { type: 'text', content: '' }
}

async function resolveProjectFolderId(options: AdaptaRequestOptions = {}): Promise<string | null> {
  if (options.folderId) {
    const project = await getAdaptaProjectFolderById(options.folderId, options.account?.userId || options.account?.userKey)
    if (!project) {
      throw new Error(`Adapta project folder "${options.folderId}" was not found. Remove metadata.adapta_folder_id or choose a valid folder.`)
    }
    return project.id
  }

  const projectName = options.projectName || config.adapta.projectName
  if (!projectName) return null

  const project = await getAdaptaProjectFolderByName(projectName, options.account?.userId || options.account?.userKey).catch(error => {
    if (options.projectName) throw error
    adaptaLogger.warn('project.resolve_failed', adaptaLogData(options, { error }))
    return null
  })
  if (!project) {
    if (!options.projectName) return null
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
  account?: AdaptaAccountContext
  requestId?: string
  folderId?: string
  projectName?: string
  limit?: number
  page?: number
} = {}): Promise<AdaptaRemoteChat[]> {
  const startedAt = Date.now()
  if (options.account) {
    setAdaptaChatSessionsFile(options.account.chatSessionsFile)
    await usePlaywrightAccount({
      accountKey: options.account.userId || options.account.userKey,
      profileDir: options.account.profileDir,
      email: options.account.email,
      password: options.account.password,
    })
    if (options.account.projectName) {
      await ensureAdaptaProjectFolder(options.account.projectName, options.account.userId || options.account.userKey).catch(error => {
        adaptaLogger.warn('project.ensure_failed', adaptaLogData(options, { error }))
      })
    }
  }
  const headers = await getAdaptaSessionHeaders(options.account?.userId || options.account?.userKey)
  const folderId = await resolveProjectFolderId({
    account: options.account,
    requestId: options.requestId,
    folderId: options.folderId,
    projectName: options.projectName,
  })
  const url = new URL(`${config.adapta.baseUrl}/api/chat/v2`)
  url.searchParams.set('limit', String(options.limit || 20))
  url.searchParams.set('page', String(options.page || 1))
  if (folderId) url.searchParams.set('folderId', folderId)

  const target = safeUpstreamTarget(url.toString())
  adaptaLogger.info('remote_chats.list.started', adaptaLogData(options, target))
  let response: Response
  try {
    response = await fetch(url, { headers })
  } catch (error) {
    adaptaLogger.error('remote_chats.list.failed', adaptaLogData(options, {
      ...target,
      durationMs: Date.now() - startedAt,
      error,
    }))
    throw error
  }
  const rawText = await response.text()
  if (!response.ok) {
    adaptaLogger.error('remote_chats.list.failed', adaptaLogData(options, {
      ...target,
      status: response.status,
      durationMs: Date.now() - startedAt,
    }))
    throw new AdaptaUpstreamError(
      `Adapta upstream error: ${response.status} ${response.statusText}`,
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

  const chats = items
    .filter((item: any) => typeof item?.id === 'string' || typeof item?.chatId === 'string')
    .map((item: any) => ({
      id: item.id || item.chatId,
      title: item.title || item.name || item.lastMessage?.content,
      folderId: item.folderId,
      createdAt: item.createdAt || item.created_at,
      updatedAt: item.updatedAt || item.updated_at,
      raw: item,
    }))
  adaptaLogger.info('remote_chats.list.completed', adaptaLogData(options, {
    ...target,
    status: response.status,
    durationMs: Date.now() - startedAt,
    itemCount: chats.length,
  }))
  return chats
}

export async function deleteAdaptaRemoteChat(chatId: string, options: {
  account?: AdaptaAccountContext
  requestId?: string
} = {}): Promise<boolean> {
  const startedAt = Date.now()
  if (options.account) {
    setAdaptaChatSessionsFile(options.account.chatSessionsFile)
    await usePlaywrightAccount({
      accountKey: options.account.userId || options.account.userKey,
      profileDir: options.account.profileDir,
      email: options.account.email,
      password: options.account.password,
    })
    if (options.account.projectName) {
      await ensureAdaptaProjectFolder(options.account.projectName, options.account.userId || options.account.userKey).catch(error => {
        adaptaLogger.warn('project.ensure_failed', adaptaLogData(options, { error }))
      })
    }
  }
  const headers = await getAdaptaSessionHeaders(options.account?.userId || options.account?.userKey)
  const candidates = [
    `${config.adapta.baseUrl}/api/chat/${encodeURIComponent(chatId)}/v1`,
    `${config.adapta.baseUrl}/api/chat/v1/${encodeURIComponent(chatId)}`,
    `${config.adapta.baseUrl}/api/chat/v2/${encodeURIComponent(chatId)}`,
  ]

  let lastStatus = 502
  for (const [index, url] of candidates.entries()) {
    const target = safeUpstreamTarget(url)
    const attemptStartedAt = Date.now()
    adaptaLogger.info('remote_chats.delete_attempt.started', adaptaLogData(options, {
      ...target,
      attempt: index + 1,
    }))
    let response: Response
    try {
      response = await fetch(url, { method: 'DELETE', headers })
    } catch (error) {
      adaptaLogger.error('remote_chats.delete_attempt.failed', adaptaLogData(options, {
        ...target,
        attempt: index + 1,
        durationMs: Date.now() - attemptStartedAt,
        error,
      }))
      throw error
    }
    adaptaLogger.info('remote_chats.delete_attempt.completed', adaptaLogData(options, {
      ...target,
      attempt: index + 1,
      status: response.status,
      durationMs: Date.now() - attemptStartedAt,
    }))
    if (response.ok || response.status === 204) return true
    lastStatus = response.status
    await response.body?.cancel().catch(() => {})
    if (![404, 405].includes(response.status)) break
  }

  adaptaLogger.error('remote_chats.delete_failed', adaptaLogData(options, {
    status: lastStatus,
    durationMs: Date.now() - startedAt,
  }))
  throw new AdaptaUpstreamError(
    `Could not delete Adapta remote chat. Last upstream status: ${lastStatus}`,
    502,
  )
}
