import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { MemoryCache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { app as chatsApp } from './chats.js'
import { app as adaptaUsersApp } from '../routes/adapta-users.ts'
import { app as webAuthApp } from '../routes/web-auth.ts'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'
import { redactSecrets } from '../utils/redact.ts'
import { getUserByApiKey } from '../services/auth-store.ts'
import { accountContextFromAuthenticatedUser } from '../services/adapta-account-resolver.ts'

const app = new Hono()

let cache: MemoryCache
let watchdog: Watchdog
let server: any

app.use('*', async (c, next) => {
  metrics.increment('requests.total')
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  metrics.histogram('latency.request', duration)
  c.header('X-Response-Time', `${duration}ms`)
})

app.use('/adaptaproxy/api/v1/*', async (c, next) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: { message: 'Missing or invalid Authorization header' } }, 401)
  }
  const token = auth.slice(7)
  const authUser = getUserByApiKey(token)
  if (!authUser) {
    return c.json({ error: { message: 'Invalid API key' } }, 401)
  }
  try {
    ;(c as any).set('adaptaproxyUser', authUser.user)
    ;(c as any).set('adaptaAccount', accountContextFromAuthenticatedUser(authUser))
  } catch (error: any) {
    return c.json({
      error: {
        message: error.message,
        type: error.type || 'adapta_account_login_required',
        login_url: error.loginUrl || '/adaptaproxy/account',
      },
    }, error.status || 401)
  }
  await next()
})

app.route('', webAuthApp)
app.route('/adaptaproxy/api', modelsApp)
app.route('/adaptaproxy/api', chatsApp)
app.route('/adaptaproxy/api', adaptaUsersApp)
app.post('/adaptaproxy/api/v1/chat/completions', chatCompletions)
app.post('/adaptaproxy/api/v1/chat/completions/stop', chatCompletionsStop)

app.get('/', (c) => {
  return c.redirect('/adaptaproxy/login')
})

app.get('/adaptaproxy/api', (c) => {
  return c.json({
    name: 'adaptaproxy',
    status: 'ok',
    endpoints: {
      health: '/adaptaproxy/health',
      models: '/adaptaproxy/api/v1/models',
      chatCompletions: '/adaptaproxy/api/v1/chat/completions',
      adaptaChats: '/adaptaproxy/api/v1/adapta/chats',
    },
  })
})

app.get('/adaptaproxy/health', async (c) => {
  const status = await watchdog?.getStatus()
  const { buildDoctorReport } = await import('../core/doctor.ts')
  const doctor = await buildDoctorReport()
  return c.json({
    status: doctor.status === 'ok' && status?.overall === 'healthy'
      ? 'healthy'
      : doctor.status === 'unhealthy' || status?.overall === 'unhealthy'
        ? 'unhealthy'
        : 'degraded',
    timestamp: Date.now(),
    checks: doctor.checks,
    adapta: doctor.adapta,
    chats: doctor.chats,
    metrics: {
      watchdog: status,
      cache: await cache?.getStats(),
    },
  })
})

app.get('/adaptaproxy/doctor', async (c) => {
  const { buildDoctorReport } = await import('../core/doctor.ts')
  const report = await buildDoctorReport()
  return c.json(report, report.status === 'unhealthy' ? 503 : 200)
})

app.get('/adaptaproxy/metrics', (c) => {
  return c.text(metrics.formatPrometheus(), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  })
})

app.onError((err, c) => {
  metrics.increment('requests.errors')
  console.error('API Error:', redactSecrets(err))
  return c.json({ error: redactSecrets(err.message) }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export async function startServer(): Promise<void> {
  cache = new MemoryCache()
  await cache.connect()

  if (config.adapta.accountMode === 'PERSONAL') {
    const { initPlaywright, usePlaywrightAccount } = await import('../services/playwright.ts')
    const { personalAccountContext } = await import('../services/adapta-account-resolver.ts')
    const account = personalAccountContext()
    await usePlaywrightAccount({
      profileDir: account.profileDir,
      headless: config.browser.headless,
      email: account.email,
      password: account.password,
    })
    await initPlaywright(config.browser.headless)
  }

  watchdog = new Watchdog()
  watchdog.start()

  metrics.startCollection()

  server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  }, (info) => {
    const browserHost = info.address === '0.0.0.0' ? 'localhost' : info.address
    console.log(`Server listening on http://${info.address}:${info.port}`)
    console.log(`Open http://${browserHost}:${info.port}`)
  })

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`)
    watchdog.stop()
    metrics.stopCollection()
    await cache.close()
    const { closePlaywright } = await import('../services/playwright.js')
    await closePlaywright()
    const { closeDatabase } = await import('../core/database.ts')
    closeDatabase()
    server?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
