import { Hono } from 'hono'
import {
  createAdaptaChatSession,
  deleteAdaptaChatSession,
  getAdaptaChatSession,
  listAdaptaChatSessions,
  setAdaptaChatSessionsFile,
} from '../core/chat-sessions.ts'
import { deleteAdaptaRemoteChat, listAdaptaRemoteChats } from '../services/adapta.ts'

const app = new Hono()

function accountForRequest(c: any) {
  return c.get('adaptaAccount')
}

app.post('/v1/adapta/chats', async c => {
  const account = accountForRequest(c)
  setAdaptaChatSessionsFile(account.chatSessionsFile)
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

app.get('/v1/adapta/chats', async c => {
  const account = accountForRequest(c)
  setAdaptaChatSessionsFile(account.chatSessionsFile)
  if (c.req.query('source') === 'remote') {
    const limit = Number(c.req.query('limit') || 20)
    const page = Number(c.req.query('page') || 1)
    const data = await listAdaptaRemoteChats({
      account,
      limit: Number.isFinite(limit) ? limit : 20,
      page: Number.isFinite(page) ? page : 1,
      folderId: c.req.query('folderId') || undefined,
      projectName: c.req.query('projectName') || undefined,
    })

    return c.json({
      object: 'list',
      source: 'remote',
      data: data.map(chat => ({
        object: 'adapta.remote_chat',
        ...chat,
      })),
    })
  }

  return c.json({
    object: 'list',
    source: 'local',
    data: listAdaptaChatSessions().map(session => ({
      object: 'adapta.chat',
      ...session,
    })),
  })
})

app.get('/v1/adapta/chats/:id', c => {
  const account = accountForRequest(c)
  setAdaptaChatSessionsFile(account.chatSessionsFile)
  const session = getAdaptaChatSession(c.req.param('id'))
  if (!session) {
    return c.json({ error: 'Chat not found' }, 404)
  }

  return c.json({
    object: 'adapta.chat',
    ...session,
  })
})

app.delete('/v1/adapta/chats/:id', async c => {
  const account = accountForRequest(c)
  setAdaptaChatSessionsFile(account.chatSessionsFile)
  if (c.req.query('source') === 'remote') {
    const deleted = await deleteAdaptaRemoteChat(c.req.param('id'), { account })
    return c.json({
      id: c.req.param('id'),
      object: 'adapta.remote_chat.deleted',
      deleted,
    })
  }

  const deleted = deleteAdaptaChatSession(c.req.param('id'))
  return c.json({
    id: c.req.param('id'),
    object: 'adapta.chat.deleted',
    deleted,
  })
})

export { app }
