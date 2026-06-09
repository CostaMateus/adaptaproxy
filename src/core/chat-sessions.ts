import { v4 as uuidv4 } from 'uuid'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'

export interface AdaptaChatSession {
  id: string
  key?: string
  remoteChatId?: string
  createdAt: number
  updatedAt: number
  title?: string
}

const sessions = new Map<string, AdaptaChatSession>()
let loaded = false

function sessionsFile(): string {
  return path.resolve(config.chats.sessionsFile)
}

function loadSessions(): void {
  if (loaded) return
  loaded = true

  try {
    const raw = fs.readFileSync(sessionsFile(), 'utf8')
    const parsed = JSON.parse(raw) as { sessions?: AdaptaChatSession[] }
    for (const session of parsed.sessions || []) {
      if (!session?.id || typeof session.id !== 'string') continue
      sessions.set(session.id, {
        id: session.id,
        key: typeof session.key === 'string' ? session.key : undefined,
        remoteChatId: typeof session.remoteChatId === 'string' ? session.remoteChatId : undefined,
        title: session.title,
        createdAt: Number(session.createdAt) || Date.now(),
        updatedAt: Number(session.updatedAt) || Date.now(),
      })
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[chat-sessions] Could not load persisted sessions: ${error.message}`)
    }
  }
}

function saveSessions(): void {
  loadSessions()
  const file = sessionsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    sessions: listAdaptaChatSessions({ persist: false }),
  }, null, 2))
}

export function createAdaptaChatSession(input: {
  id?: string
  key?: string
  remoteChatId?: string
  title?: string
} = {}): AdaptaChatSession {
  loadSessions()
  const now = Date.now()
  const session: AdaptaChatSession = {
    id: input.id || uuidv4(),
    key: input.key,
    remoteChatId: input.remoteChatId,
    title: input.title,
    createdAt: now,
    updatedAt: now,
  }
  sessions.set(session.id, session)
  saveSessions()
  return session
}

export function getAdaptaChatSession(id: string): AdaptaChatSession | undefined {
  loadSessions()
  return sessions.get(id)
}

export function getAdaptaChatSessionByKey(key: string): AdaptaChatSession | undefined {
  loadSessions()
  return [...sessions.values()].find(session => session.key === key)
}

export function touchAdaptaChatSession(id: string): AdaptaChatSession {
  loadSessions()
  const existing = sessions.get(id)
  if (existing) {
    existing.updatedAt = Date.now()
    saveSessions()
    return existing
  }
  return createAdaptaChatSession({ id })
}

export function touchAdaptaChatSessionMapping(input: {
  key: string
  remoteChatId: string
  title?: string
}): AdaptaChatSession {
  loadSessions()
  const existing = getAdaptaChatSessionByKey(input.key)
  const now = Date.now()
  if (existing) {
    existing.remoteChatId = input.remoteChatId
    existing.title = input.title || existing.title
    existing.updatedAt = now
    saveSessions()
    return existing
  }

  return createAdaptaChatSession({
    id: input.key,
    key: input.key,
    remoteChatId: input.remoteChatId,
    title: input.title,
  })
}

export function listAdaptaChatSessions(options: { persist?: boolean } = {}): AdaptaChatSession[] {
  if (options.persist !== false) loadSessions()
  return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function deleteAdaptaChatSession(id: string): boolean {
  loadSessions()
  const deleted = sessions.delete(id)
  if (deleted) saveSessions()
  return deleted
}

export function newAdaptaMessageId(): string {
  return uuidv4()
}
