import { Hono } from 'hono'
import { config } from '../core/config.ts'
import {
  corporateChatSessionsFile,
  corporateProfileDir,
  normalizeAdaptaUserKey,
  saveCorporateUser,
  updateCorporateUserProject,
} from '../services/adapta-user-store.ts'
import {
  ensureAdaptaProjectFolder,
  loginWithCredentials,
  usePlaywrightAccount,
} from '../services/playwright.ts'
import { setAdaptaChatSessionsFile } from '../core/chat-sessions.ts'

const app = new Hono()

app.post('/v1/adapta/users/login', async c => {
  const body = await c.req.json().catch(() => ({})) as {
    userKey?: string
    email?: string
    password?: string
  }

  const userKey = normalizeAdaptaUserKey(body.userKey || '')
  if (!userKey) {
    return c.json({ error: { message: '`userKey` is required', type: 'adapta_user_required' } }, 400)
  }
  if (!body.email || !body.password) {
    return c.json({ error: { message: '`email` and `password` are required' } }, 400)
  }
  if (!config.adapta.credentialsSecret) {
    return c.json({
      error: {
        message: 'ADAPTA_CREDENTIALS_SECRET is required in CORPORATE mode to store user credentials.',
      },
    }, 500)
  }

  const profileDir = corporateProfileDir(userKey)
  await loginWithCredentials({
    profileDir,
    email: body.email,
    password: body.password,
  })
  await usePlaywrightAccount({
    profileDir,
    email: body.email,
    password: body.password,
  })
  setAdaptaChatSessionsFile(corporateChatSessionsFile(userKey))
  const project = await ensureAdaptaProjectFolder(config.adapta.projectName)
  const user = saveCorporateUser({
    userKey,
    email: body.email,
    password: body.password,
    projectName: config.adapta.projectName,
    projectId: project?.id,
  })
  if (project?.id) updateCorporateUserProject(userKey, project.id)

  return c.json({
    object: 'adapta.user',
    userKey,
    email: user.email,
    profileDir: user.profileDir,
    projectName: user.projectName,
    projectId: project?.id || user.projectId,
  }, 201)
})

export { app }
