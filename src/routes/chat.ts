import { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../core/config.ts'
import { metrics } from '../core/metrics.js'
import { createAdaptaCompletion, createAdaptaCompletionStream, openAiMessagesToPrompt } from '../services/adapta.ts'
import { OpenAIRequest } from '../utils/types.ts'
import { redactSecrets } from '../utils/redact.ts'

interface CompletionMetadata {
  adapta_chat_id: string
  adapta_session_key?: string
  adapta_refinement_questions?: unknown[]
}

type AdaptaChatMode = 'reuse' | 'new' | 'specific'

function requestedAdaptaChatMode(value: unknown, headerValue: string | undefined): AdaptaChatMode | undefined {
  const mode = typeof value === 'string' ? value : headerValue
  if (!mode) return undefined
  if (mode === 'reuse' || mode === 'new' || mode === 'specific') return mode
  throw Object.assign(new Error('`metadata.adapta_chat_mode` must be one of: reuse, new, specific'), { status: 400 })
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function completionPayload(
  id: string,
  model: string,
  content: string,
  prompt: string,
  metadata: CompletionMetadata,
  reasoningContent?: string,
) {
  const promptTokens = estimateTokens(prompt)
  const completionTokens = estimateTokens(content)

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      },
      logprobs: null,
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 0 },
    },
    metadata,
  }
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json()
    const model = body.model || config.adapta.modelId
    const messages = body.messages || []

    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: { message: '`messages` must be a non-empty array' } }, 400)
    }

    const prompt = openAiMessagesToPrompt(messages)
    const account = c.get('adaptaAccount')
    const requestedChatId = typeof body.metadata?.adapta_chat_id === 'string'
      ? body.metadata.adapta_chat_id
      : undefined
    const requestedChatMode = requestedAdaptaChatMode(
      body.metadata?.adapta_chat_mode,
      c.req.header('x-adapta-chat-mode') || undefined,
    )
    if (requestedChatMode === 'specific' && !requestedChatId) {
      return c.json({
        error: {
          message: '`metadata.adapta_chat_id` is required when `metadata.adapta_chat_mode` is "specific"',
        },
      }, 400)
    }
    const requestedSessionKey = typeof body.metadata?.adapta_session_key === 'string'
      ? body.metadata.adapta_session_key
      : c.req.header('x-adapta-session-key') || config.chats.defaultChatId
    const requestedNewChat = requestedChatMode === 'new' ||
      body.metadata?.adapta_new_chat === true ||
      c.req.header('x-adapta-new-chat') === 'true'
    const adaptaOptions = {
      account,
      chatId: requestedChatId,
      sessionKey: requestedSessionKey,
      newChat: requestedNewChat,
      projectName: typeof body.metadata?.adapta_project_name === 'string'
        ? body.metadata.adapta_project_name
        : undefined,
      folderId: typeof body.metadata?.adapta_folder_id === 'string'
        ? body.metadata.adapta_folder_id
        : undefined,
    }
    const completionId = 'chatcmpl-' + uuidv4()
    const shouldStream = body.stream === true

    if (!shouldStream) {
      const completion = await createAdaptaCompletion(prompt, adaptaOptions)
      return c.json(completionPayload(completionId, model, completion.content, prompt, {
        adapta_chat_id: completion.chatId,
        adapta_session_key: requestedChatId ? undefined : requestedSessionKey,
        ...(completion.refinementQuestions.length
          ? { adapta_refinement_questions: completion.refinementQuestions }
          : {}),
      }, completion.reasoningContent))
    }

    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')

    return honoStream(c, async writer => {
      const created = Math.floor(Date.now() / 1000)
      let streamChatId = requestedChatId || ''
      let streamedContent = ''
      let streamedReasoningContent = ''
      const writeEvent = async (data: unknown) => {
        await writer.write(`data: ${JSON.stringify(data)}\n\n`)
      }

      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        metadata: {
          ...(requestedChatId ? { adapta_chat_id: requestedChatId } : {}),
          ...(!requestedChatId ? { adapta_session_key: requestedSessionKey } : {}),
        },
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '' },
          logprobs: null,
          finish_reason: null,
        }],
      })

      const completion = await createAdaptaCompletionStream(prompt, adaptaOptions, async delta => {
        if (delta.type === 'reasoning') {
          streamedReasoningContent += delta.content
        } else {
          streamedContent += delta.content
        }
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          metadata: streamChatId ? { adapta_chat_id: streamChatId } : undefined,
          choices: [{
            index: 0,
            delta: delta.type === 'reasoning'
              ? { reasoning_content: delta.content }
              : { content: delta.content },
            logprobs: null,
            finish_reason: null,
          }],
        })
      })
      streamChatId = completion.chatId

      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        metadata: {
          adapta_chat_id: completion.chatId,
          adapta_session_key: requestedChatId ? undefined : requestedSessionKey,
          ...(completion.refinementQuestions.length
            ? { adapta_refinement_questions: completion.refinementQuestions }
            : {}),
        },
        choices: [{
          index: 0,
          delta: {},
          logprobs: null,
          finish_reason: 'stop',
        }],
      })

      if (body.stream_options?.include_usage) {
        const payload = completionPayload(completionId, model, streamedContent || completion.content, prompt, {
          adapta_chat_id: completion.chatId,
          adapta_session_key: requestedChatId ? undefined : requestedSessionKey,
          ...(completion.refinementQuestions.length
            ? { adapta_refinement_questions: completion.refinementQuestions }
            : {}),
        }, streamedReasoningContent || completion.reasoningContent)
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          metadata: {
            adapta_chat_id: completion.chatId,
            adapta_session_key: requestedChatId ? undefined : requestedSessionKey,
          },
          choices: [],
          usage: payload.usage,
        })
      }

      await writer.write('data: [DONE]\n\n')
    })
  } catch (err: any) {
    console.error('Error in chatCompletions:', redactSecrets(err))
    const status = err.status || err.upstreamStatus || 500
    if (status >= 500) metrics.increment('requests.errors')
    return c.json({
      error: {
        message: redactSecrets(err.message),
        ...(err.type ? { type: err.type } : {}),
      },
    }, status)
  }
}

export async function chatCompletionsStop(c: Context) {
  return c.json({
    error: 'Stop is not supported by Adaptaproxy v1 because the Adapta upstream cancellation endpoint has not been discovered.',
  }, 501)
}
