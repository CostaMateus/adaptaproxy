import { Hono } from 'hono'
import {
  createAdaptaChatSession,
  deleteAdaptaChatSession,
  getAdaptaChatSession,
  listAdaptaChatSessions,
} from '../core/chat-sessions.ts'

const app = new Hono()

app.post('/v1/adapta/chats', async c => {
  const body = await c.req.json().catch(() => ({})) as { id?: string, title?: string }
  const session = createAdaptaChatSession({
    id: typeof body.id === 'string' && body.id ? body.id : undefined,
    title: typeof body.title === 'string' && body.title ? body.title : undefined,
  })

  return c.json({
    object: 'adapta.chat',
    ...session,
  }, 201)
})

app.get('/v1/adapta/chats', c => {
  return c.json({
    object: 'list',
    data: listAdaptaChatSessions().map(session => ({
      object: 'adapta.chat',
      ...session,
    })),
  })
})

app.get('/v1/adapta/chats/:id', c => {
  const session = getAdaptaChatSession(c.req.param('id'))
  if (!session) {
    return c.json({ error: 'Chat not found' }, 404)
  }

  return c.json({
    object: 'adapta.chat',
    ...session,
  })
})

app.delete('/v1/adapta/chats/:id', c => {
  const deleted = deleteAdaptaChatSession(c.req.param('id'))
  return c.json({
    id: c.req.param('id'),
    object: 'adapta.chat.deleted',
    deleted,
  })
})

export { app }
