import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { MemoryCache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { app as chatsApp } from './chats.js'
import { app as adaptaUsersApp } from '../routes/adapta-users.ts'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'
import { redactSecrets } from '../utils/redact.ts'

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

app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY || config.apiKey
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const token = auth.slice(7)
    if (token !== apiKey) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  }
  await next()
})

app.route('', modelsApp)
app.route('', chatsApp)
app.route('', adaptaUsersApp)
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)

app.get('/', (c) => {
  return c.json({
    name: 'adaptaproxy',
    status: 'ok',
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chatCompletions: '/v1/chat/completions',
      adaptaChats: '/v1/adapta/chats',
    },
  })
})

app.get('/health', async (c) => {
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

app.get('/doctor', async (c) => {
  const { buildDoctorReport } = await import('../core/doctor.ts')
  const report = await buildDoctorReport()
  return c.json(report, report.status === 'unhealthy' ? 503 : 200)
})

app.get('/metrics', (c) => {
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
    server?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
