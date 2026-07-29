import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { randomUUID } from 'node:crypto'
import { config } from '../core/config.js'
import { logger } from '../core/logger.ts'
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
const httpLogger = logger.child('http')
const authLogger = logger.child('auth')
const serverLogger = logger.child('server')

let cache: MemoryCache
let watchdog: Watchdog
let server: any

app.use('*', async (c, next) => {
  const incomingRequestId = c.req.header('x-request-id')?.trim() || ''
  const requestId = /^[A-Za-z0-9._:-]{1,100}$/.test(incomingRequestId)
    ? incomingRequestId
    : randomUUID()
  ;(c as any).set('requestId', requestId)
  c.header('X-Request-ID', requestId)

  metrics.increment('requests.total')
  const start = Date.now()
  try {
    await next()
  } finally {
    const durationMs = Date.now() - start
    const status = c.res?.status || 500
    const user = (c as any).get('adaptaproxyUser')
    metrics.histogram('latency.request', durationMs)
    c.header('X-Response-Time', `${durationMs}ms`)
    const eventData = {
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status,
      durationMs,
      ...(user?.id ? { userId: user.id } : {}),
    }
    if (status >= 500) {
      httpLogger.error('request.completed', eventData)
    } else if (status >= 400) {
      httpLogger.warn('request.completed', eventData)
    } else {
      httpLogger.info('request.completed', eventData)
    }
  }
})

app.use('/adaptaproxy/api/v1/*', async (c, next) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    authLogger.warn('request.rejected', {
      requestId: (c as any).get('requestId'),
      reason: 'missing_or_invalid_authorization',
    })
    return c.json({ error: { message: 'Missing or invalid Authorization header' } }, 401)
  }
  const token = auth.slice(7)
  const authUser = getUserByApiKey(token)
  if (!authUser) {
    authLogger.warn('request.rejected', {
      requestId: (c as any).get('requestId'),
      reason: 'invalid_api_key',
    })
    return c.json({ error: { message: 'Invalid API key' } }, 401)
  }
  try {
    ;(c as any).set('adaptaproxyUser', authUser.user)
    ;(c as any).set('adaptaAccount', accountContextFromAuthenticatedUser(authUser))
  } catch (error: any) {
    authLogger.warn('request.rejected', {
      requestId: (c as any).get('requestId'),
      reason: error.type || 'adapta_account_login_required',
      userId: authUser.user.id,
    })
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
  logger.child('api').error('request.unhandled_error', {
    requestId: (c as any).get('requestId'),
    error: err,
  })
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
    serverLogger.info('started', {
      address: info.address,
      port: info.port,
      localUrl: `http://${browserHost}:${info.port}`,
    })
  })

  const shutdown = async (signal: string) => {
    serverLogger.info('shutdown.started', { signal })
    watchdog.stop()
    metrics.stopCollection()
    await cache.close()
    const { closePlaywright } = await import('../services/playwright.js')
    await closePlaywright()
    const { closeDatabase } = await import('../core/database.ts')
    closeDatabase()
    server?.close()
    serverLogger.info('shutdown.completed', { signal })
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
