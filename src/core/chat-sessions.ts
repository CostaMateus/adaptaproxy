import { v4 as uuidv4 } from 'uuid'

export interface AdaptaChatSession {
  id: string
  createdAt: number
  updatedAt: number
  title?: string
}

const sessions = new Map<string, AdaptaChatSession>()

export function createAdaptaChatSession(input: { id?: string, title?: string } = {}): AdaptaChatSession {
  const now = Date.now()
  const session: AdaptaChatSession = {
    id: input.id || uuidv4(),
    title: input.title,
    createdAt: now,
    updatedAt: now,
  }
  sessions.set(session.id, session)
  return session
}

export function getAdaptaChatSession(id: string): AdaptaChatSession | undefined {
  return sessions.get(id)
}

export function touchAdaptaChatSession(id: string): AdaptaChatSession {
  const existing = sessions.get(id)
  if (existing) {
    existing.updatedAt = Date.now()
    return existing
  }
  return createAdaptaChatSession({ id })
}

export function listAdaptaChatSessions(): AdaptaChatSession[] {
  return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function deleteAdaptaChatSession(id: string): boolean {
  return sessions.delete(id)
}

export function newAdaptaMessageId(): string {
  return uuidv4()
}
