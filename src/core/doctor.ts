import { config } from './config.ts'
import { listAdaptaChatSessions } from './chat-sessions.ts'

export interface DoctorReport {
  status: 'ok' | 'degraded' | 'unhealthy'
  timestamp: number
  server: {
    host: string
    port: number
    apiKeyConfigured: boolean
  }
  adapta: {
    baseUrl: string
    chatUrl: string
    modelId: string
    projectName: string | null
    playwrightInitialized: boolean
    authenticated: boolean
    authorizationCaptured: boolean
    projectFound: boolean | null
    projectId: string | null
    currentUrl: string | null
  }
  chats: {
    sessionsFile: string
    persistedSessions: number
  }
  checks: Array<{
    name: string
    status: 'ok' | 'warning' | 'error'
    message: string
  }>
}

export async function buildDoctorReport(): Promise<DoctorReport> {
  const { getAdaptaSessionDiagnostics } = await import('../services/playwright.ts')
  const diagnostics = await getAdaptaSessionDiagnostics()

  const checks: DoctorReport['checks'] = [
    {
      name: 'playwright',
      status: diagnostics.initialized ? 'ok' : 'error',
      message: diagnostics.initialized ? 'Playwright is initialized' : 'Playwright is not initialized',
    },
    {
      name: 'adapta_session',
      status: diagnostics.authenticated ? 'ok' : 'error',
      message: diagnostics.authenticated ? 'Adapta session looks authenticated' : 'Adapta session is not authenticated; run npm run login',
    },
    {
      name: 'authorization',
      status: diagnostics.authorizationCaptured ? 'ok' : 'error',
      message: diagnostics.authorizationCaptured ? 'Adapta authorization header is available' : 'Could not capture Adapta authorization header',
    },
  ]

  if (config.adapta.projectName) {
    checks.push({
      name: 'adapta_project',
      status: diagnostics.projectFound ? 'ok' : 'error',
      message: diagnostics.projectFound
        ? `Project "${config.adapta.projectName}" was found`
        : `Project "${config.adapta.projectName}" was not found`,
    })
  } else {
    checks.push({
      name: 'adapta_project',
      status: 'warning',
      message: 'ADAPTA_PROJECT_NAME is empty; new chats use the default Chats menu',
    })
  }

  const hasError = checks.some(check => check.status === 'error')
  const hasWarning = checks.some(check => check.status === 'warning')

  return {
    status: hasError ? 'unhealthy' : hasWarning ? 'degraded' : 'ok',
    timestamp: Date.now(),
    server: {
      host: config.server.host,
      port: config.server.port,
      apiKeyConfigured: Boolean(config.apiKey),
    },
    adapta: {
      baseUrl: config.adapta.baseUrl,
      chatUrl: config.adapta.chatUrl,
      modelId: config.adapta.modelId,
      projectName: config.adapta.projectName || null,
      playwrightInitialized: diagnostics.initialized,
      authenticated: diagnostics.authenticated,
      authorizationCaptured: diagnostics.authorizationCaptured,
      projectFound: diagnostics.projectFound,
      projectId: diagnostics.projectId,
      currentUrl: diagnostics.currentUrl,
    },
    chats: {
      sessionsFile: config.chats.sessionsFile,
      persistedSessions: listAdaptaChatSessions().length,
    },
    checks,
  }
}
