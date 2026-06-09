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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function completionPayload(id: string, model: string, content: string, prompt: string, metadata: CompletionMetadata) {
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
    const requestedChatId = typeof body.metadata?.adapta_chat_id === 'string'
      ? body.metadata.adapta_chat_id
      : undefined
    const requestedSessionKey = typeof body.metadata?.adapta_session_key === 'string'
      ? body.metadata.adapta_session_key
      : c.req.header('x-adapta-session-key') || config.chats.defaultChatId
    const requestedNewChat = body.metadata?.adapta_new_chat === true ||
      c.req.header('x-adapta-new-chat') === 'true'
    const adaptaOptions = {
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

    if (!body.stream) {
      const completion = await createAdaptaCompletion(prompt, adaptaOptions)
      return c.json(completionPayload(completionId, model, completion.content, prompt, {
        adapta_chat_id: completion.chatId,
        adapta_session_key: requestedChatId ? undefined : requestedSessionKey,
        ...(completion.refinementQuestions.length
          ? { adapta_refinement_questions: completion.refinementQuestions }
          : {}),
      }))
    }

    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')

    return honoStream(c, async writer => {
      const created = Math.floor(Date.now() / 1000)
      let streamChatId = requestedChatId || ''
      let streamedContent = ''
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

      const completion = await createAdaptaCompletionStream(prompt, adaptaOptions, async chunk => {
        streamedContent += chunk
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          metadata: streamChatId ? { adapta_chat_id: streamChatId } : undefined,
          choices: [{
            index: 0,
            delta: { content: chunk },
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
        })
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
    const status = err.upstreamStatus || 500
    if (status >= 500) metrics.increment('requests.errors')
    return c.json({ error: { message: redactSecrets(err.message) } }, status)
  }
}

export async function chatCompletionsStop(c: Context) {
  return c.json({
    error: 'Stop is not supported by Adaptaproxy v1 because the Adapta upstream cancellation endpoint has not been discovered.',
  }, 501)
}
