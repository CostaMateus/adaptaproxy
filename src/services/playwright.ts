import { chromium, firefox, webkit, BrowserContext, Page, Request, Route } from 'playwright'
import path from 'path'
import { spawn } from 'node:child_process'
import { config } from '../core/config.ts'
import { logger } from '../core/logger.ts'

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge'

export interface CapturedAdaptaRequest {
  url: string
  method: string
  headers: Record<string, string>
  postData: unknown
}

export interface AdaptaProjectFolder {
  id: string
  name: string
}

export interface AdaptaSessionDiagnostics {
  initialized: boolean
  authenticated: boolean
  authorizationCaptured: boolean
  projectName: string | null
  projectFound: boolean | null
  projectId: string | null
  currentUrl: string | null
}

interface PlaywrightRuntime {
  context: BrowserContext | null
  loginContext: BrowserContext | null
  activePage: Page | null
  cachedChatRequest: CapturedAdaptaRequest | null
  cachedProjectFolders: AdaptaProjectFolder[] | null
  cachedAuthorizationHeader: string | null
  currentProfileDir: string | null
  currentCredentials: { email: string, password: string } | null
  autoLoginPromise: Promise<void> | null
  multipleSessionsRecoveryPromise: Promise<number> | null
  discoveryMutex: Mutex
  loginMutex: Mutex
  pageOperationMutex: Mutex
}

function createRuntime(): PlaywrightRuntime {
  return {
    context: null,
    loginContext: null,
    activePage: null,
    cachedChatRequest: null,
    cachedProjectFolders: null,
    cachedAuthorizationHeader: null,
    currentProfileDir: null,
    currentCredentials: null,
    autoLoginPromise: null,
    multipleSessionsRecoveryPromise: null,
    discoveryMutex: new Mutex(),
    loginMutex: new Mutex(),
    pageOperationMutex: new Mutex(),
  }
}

let currentBrowserType: BrowserType = 'chromium'
let currentHeadless = true

export class Mutex {
  private queue: (() => void)[] = []
  private locked = false

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true
      return () => this.release()
    }

    return new Promise(resolve => {
      this.queue.push(() => resolve(() => this.release()))
    })
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
      return
    }
    this.locked = false
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const sessionLogger = logger.child('adapta-session')

const MULTIPLE_SESSIONS_ERROR =
  'A Adapta bloqueou esta conta por excesso de sessoes ativas e a recuperacao automatica falhou.'

export function isAdaptaMultipleSessionsText(text: string): boolean {
  return /muitas sess(?:o|õ)es ativas/i.test(text) ||
    /limite de dispositivos conectados simultaneamente/i.test(text) ||
    /too many active sessions/i.test(text) ||
    /simultaneous device limit/i.test(text)
}

async function hasMultipleSessionsBlock(page: Page): Promise<boolean> {
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')
  return isAdaptaMultipleSessionsText(text)
}

export function getOtherAdaptaSessionIds(
  currentSessionId: string,
  sessionIds: string[],
): string[] {
  if (!currentSessionId) return []
  return [...new Set(sessionIds)]
    .filter(sessionId => sessionId && sessionId !== currentSessionId)
}

async function revokeOtherSessionsThroughClerk(page: Page): Promise<{
  supported: boolean
  revoked: number
}> {
  const inventory = await page.evaluate(async () => {
    const clerk = (window as any).Clerk
    if (!clerk) return { currentSessionId: '', sessionIds: [] as string[] }
    if (clerk.loaded === false && typeof clerk.load === 'function') {
      await clerk.load()
    }

    const currentSessionId = typeof clerk.session?.id === 'string'
      ? clerk.session.id
      : ''
    const sessions = typeof clerk.user?.getSessions === 'function'
      ? await clerk.user.getSessions()
      : []

    return {
      currentSessionId,
      sessionIds: Array.isArray(sessions)
        ? sessions
          .map((session: any) => session?.id)
          .filter((sessionId: unknown): sessionId is string => typeof sessionId === 'string')
        : [],
    }
  }).catch(() => ({ currentSessionId: '', sessionIds: [] as string[] }))

  const otherSessionIds = getOtherAdaptaSessionIds(
    inventory.currentSessionId,
    inventory.sessionIds,
  )
  if (!inventory.currentSessionId) return { supported: false, revoked: 0 }

  const revoked = await page.evaluate(async ({ currentSessionId, otherSessionIds }) => {
    const clerk = (window as any).Clerk
    if (!clerk || clerk.session?.id !== currentSessionId) {
      throw new Error('Current Adapta session changed during recovery.')
    }

    const sessions = typeof clerk.user?.getSessions === 'function'
      ? await clerk.user.getSessions()
      : []
    let revokedCount = 0

    for (const sessionId of otherSessionIds) {
      const session = Array.isArray(sessions)
        ? sessions.find((candidate: any) => candidate?.id === sessionId)
        : null
      if (!session || session.id === currentSessionId || typeof session.revoke !== 'function') continue
      await session.revoke()
      revokedCount += 1
    }

    if (typeof clerk.session?.touch === 'function') {
      await clerk.session.touch()
    }
    return revokedCount
  }, {
    currentSessionId: inventory.currentSessionId,
    otherSessionIds,
  })

  return { supported: true, revoked }
}

async function disconnectOtherSessionsThroughUi(page: Page): Promise<boolean> {
  const disconnectAllButton = page.getByRole('button', {
    name: /Desconectar todos os outros|Disconnect all other/i,
  })
  if (await disconnectAllButton.count() !== 1) return false
  await disconnectAllButton.click()
  return true
}

async function waitForMultipleSessionsBlockToClear(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!(await hasMultipleSessionsBlock(page))) return
    await sleep(500)
    if (attempt === 1 || attempt === 3) {
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: config.timeouts.navigation,
      }).catch(() => {})
    }
  }
  throw new Error(MULTIPLE_SESSIONS_ERROR)
}

async function keepCurrentAdaptaSessionActive(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const clerk = (window as any).Clerk
    if (typeof clerk?.session?.touch === 'function') {
      await clerk.session.touch()
    }
  }).catch(() => {})
}

async function recoverFromMultipleSessionsBlock(page: Page, accountKey?: string): Promise<number> {
  const rt = runtime(accountKey)
  if (!config.adapta.autoDisconnectOtherSessions) {
    throw new Error(MULTIPLE_SESSIONS_ERROR)
  }
  if (!rt.multipleSessionsRecoveryPromise) {
    rt.multipleSessionsRecoveryPromise = (async () => {
      sessionLogger.warn('multiple_sessions.recovery_started', {
        accountMode: accountKey ? 'account' : 'default',
      })

      let revoked = 0
      let usedUiFallback = false
      const clerkResult = await revokeOtherSessionsThroughClerk(page).catch(() => ({
        supported: false,
        revoked: 0,
      }))
      revoked = clerkResult.revoked

      if (await hasMultipleSessionsBlock(page)) {
        usedUiFallback = await disconnectOtherSessionsThroughUi(page).catch(() => false)
      }

      await waitForMultipleSessionsBlockToClear(page)
      await keepCurrentAdaptaSessionActive(page)
      rt.cachedAuthorizationHeader = null
      rt.cachedProjectFolders = null
      rt.cachedChatRequest = null

      sessionLogger.info('multiple_sessions.recovery_completed', {
        accountMode: accountKey ? 'account' : 'default',
        revoked,
        usedClerkApi: clerkResult.supported,
        usedUiFallback,
      })
      return revoked
    })().finally(() => {
      rt.multipleSessionsRecoveryPromise = null
    })
  }
  return rt.multipleSessionsRecoveryPromise
}

async function ensureNoMultipleSessionsBlock(page: Page | null, accountKey?: string): Promise<boolean> {
  if (!page || !(await hasMultipleSessionsBlock(page))) return false
  await recoverFromMultipleSessionsBlock(page, accountKey)
  return true
}

function resolveConfiguredBrowserType(): BrowserType {
  return (process.env.BROWSER as BrowserType | undefined) || currentBrowserType || 'chromium'
}

const defaultRuntime = createRuntime()
const accountRuntimes = new Map<string, PlaywrightRuntime>()

function runtime(accountKey?: string): PlaywrightRuntime {
  if (!accountKey) return defaultRuntime
  let rt = accountRuntimes.get(accountKey)
  if (!rt) {
    rt = createRuntime()
    accountRuntimes.set(accountKey, rt)
  }
  return rt
}

export let activePage: Page | null = null

async function tryCredentialLogin(page: Page, email: string, password: string): Promise<void> {
  const emailInput = page.locator([
    'input[type="email"]',
    'input[name*="email" i]',
    'input[autocomplete="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="e-mail" i]',
  ].join(', ')).first()

  await emailInput.waitFor({ timeout: config.timeouts.page })
  await emailInput.fill(email)

  const passwordInput = page.locator([
    'input[type="password"]',
    'input[name*="password" i]',
    'input[autocomplete="current-password"]',
    'input[placeholder*="senha" i]',
    'input[placeholder*="password" i]',
  ].join(', ')).first()

  await passwordInput.waitFor({ timeout: config.timeouts.page })
  await passwordInput.fill(password)

  const submit = page.locator([
    'button[data-localization-key="formButtonPrimary"]:visible',
    'button:visible:has-text("Continuar")',
    'button:visible:has-text("Entrar")',
    'button:visible:has-text("Sign in")',
    'button:visible:has-text("Login")',
    'button[type="submit"]:visible',
  ].join(', ')).first()

  if (await submit.count()) {
    await submit.click()
  } else {
    await page.keyboard.press('Enter')
  }
}

function getBrowser(browserType: BrowserType) {
  switch (browserType) {
    case 'firefox':
      return { engine: firefox, channel: undefined }
    case 'webkit':
      return { engine: webkit, channel: undefined }
    case 'chrome':
      return { engine: chromium, channel: 'chrome' }
    case 'edge':
      return { engine: chromium, channel: 'msedge' }
    case 'chromium':
    default:
      return { engine: chromium, channel: undefined }
  }
}

function profilePath(profileDir = defaultRuntime.currentProfileDir): string {
  return path.resolve(profileDir || config.browser.userDataDir, '_default')
}

export function getActiveProfilePath(): string {
  return profilePath()
}

function looksLikeAuthCookie(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized.includes('token') ||
    normalized.includes('session') ||
    normalized.includes('auth') ||
    normalized.includes('jwt')
}

async function getLocalAuthValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const tokenPattern = /(token|session|auth|jwt)/i
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key || !tokenPattern.test(key)) continue
      const value = localStorage.getItem(key) || ''
      if (value) return value
    }
    return ''
  }).catch(() => '')
}

async function hasAuthState(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies(config.adapta.baseUrl)
  if (cookies.some(cookie => looksLikeAuthCookie(cookie.name))) return true
  return Boolean(await getLocalAuthValue(page))
}

async function captureAuthorizationHeader(page: Page, accountKey?: string): Promise<string> {
  const rt = runtime(accountKey)
  if (rt.cachedAuthorizationHeader) return rt.cachedAuthorizationHeader

  const release = await rt.pageOperationMutex.acquire()
  try {
    const existingAuth = await waitForAuthorizationHeader(page, false, accountKey)
    if (existingAuth) return existingAuth

    const authPromise = waitForAuthorizationHeader(page, true, accountKey)
    await page.goto(config.adapta.chatUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeouts.navigation,
    }).catch(error => {
      if (!String(error?.message || error).includes('ERR_ABORTED')) throw error
    })

    return authPromise
  } finally {
    release()
  }
}

async function waitForAuthorizationHeader(page: Page, wait: boolean, accountKey?: string): Promise<string> {
  const rt = runtime(accountKey)
  const capture = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      page.off('request', onRequest)
      if (wait) {
        reject(new Error('Could not capture Adapta authorization header from the logged browser session. Run `npm run login` and authenticate again.'))
      } else {
        resolve('')
      }
    }, wait ? config.timeouts.navigation : 500)

    const onRequest = (request: Request) => {
      if (!request.url().startsWith(config.adapta.baseUrl)) return
      const authorization = request.headers().authorization
      if (!authorization) return

      clearTimeout(timeout)
      page.off('request', onRequest)
      rt.cachedAuthorizationHeader = authorization
      resolve(authorization)
    }

    page.on('request', onRequest)
  })

  return capture.catch(error => {
    if (wait) throw error
    return ''
  })
}

function parsePostData(request: Request): unknown {
  const raw = request.postData()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function isLikelyChatRequest(request: Request): boolean {
  if (request.method() !== 'POST') return false

  const url = request.url()
  if (!url.startsWith(config.adapta.baseUrl)) return false
  if (/\/(_vercel|monitoring|telemetry|analytics|sentry|log|logs|metrics|insights)(\?|\/|$)/i.test(url)) return false
  if (/\.(js|css|png|jpg|jpeg|webp|svg|ico|woff2?)($|\?)/i.test(url)) return false

  const lowerUrl = url.toLowerCase()
  const data = request.postData() || ''
  const lowerData = data.toLowerCase()

  if (lowerUrl.includes('/api/prompts/') ||
      lowerUrl.includes('/prompts/enhance')) {
    return false
  }

  if (lowerUrl.includes('monitoring') ||
      lowerUrl.includes('telemetry') ||
      lowerUrl.includes('analytics') ||
      lowerUrl.includes('sentry') ||
      lowerUrl.includes('_vercel') ||
      lowerUrl.includes('insights')) {
    return false
  }

  if (lowerUrl.includes('/api/chat/stream')) {
    return lowerData.includes('"messages"') && lowerData.includes('"trigger"')
  }

  const hasChatUrl = lowerUrl.includes('chat') ||
    lowerUrl.includes('message') ||
    lowerUrl.includes('completion') ||
    lowerUrl.includes('agent')

  const hasChatPayload = lowerData.includes('"message"') ||
    lowerData.includes('"prompt"') ||
    lowerData.includes('"messages"') ||
    lowerData.includes('"content"') ||
    lowerData.includes('responda apenas')

  return hasChatUrl && hasChatPayload
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const forbidden = new Set([
    'content-length',
    'connection',
    'host',
    'accept-encoding',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
  ])

  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !forbidden.has(key.toLowerCase())),
  )
}

export function getCachedAdaptaChatRequest(): CapturedAdaptaRequest | null {
  return defaultRuntime.cachedChatRequest
}

export function getCachedAdaptaChatRequestForAccount(accountKey?: string): CapturedAdaptaRequest | null {
  return runtime(accountKey).cachedChatRequest
}

export function getDefaultAdaptaChatRequest(): CapturedAdaptaRequest {
  return {
    url: `${config.adapta.baseUrl}/api/chat/stream/v1`,
    method: 'POST',
    headers: {
      accept: 'text/event-stream, application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: config.adapta.baseUrl,
      referer: config.adapta.chatUrl,
    },
    postData: {
      chatId: 'adaptaproxy-chat-id',
      id: 'adaptaproxy-message-id',
      trigger: 'submit-message',
      isTemporaryChat: false,
      messages: [{
        id: 'adaptaproxy-message-id',
        role: 'user',
        content: '__adaptaproxy_prompt__',
        parts: [{
          type: 'text',
          text: '__adaptaproxy_prompt__',
        }],
      }],
    },
  }
}

export async function getAdaptaProjectFolderByName(name: string, accountKey?: string): Promise<AdaptaProjectFolder | null> {
  const normalizedName = name.trim().toLowerCase()
  if (!normalizedName) return null

  const folders = await getAdaptaProjectFolders(accountKey)
  return folders.find(folder => folder.name.trim().toLowerCase() === normalizedName) || null
}

export async function getAdaptaProjectFolderById(id: string, accountKey?: string): Promise<AdaptaProjectFolder | null> {
  const normalizedId = id.trim()
  if (!normalizedId) return null

  const folders = await getAdaptaProjectFolders(accountKey)
  return folders.find(folder => folder.id === normalizedId) || null
}

export async function listAdaptaProjectFolders(accountKey?: string): Promise<AdaptaProjectFolder[]> {
  return getAdaptaProjectFolders(accountKey)
}

export async function ensureAdaptaProjectFolder(name: string, accountKey?: string): Promise<AdaptaProjectFolder | null> {
  const rt = runtime(accountKey)
  const normalizedName = name.trim()
  if (!normalizedName) return null

  await getAdaptaSessionHeaders(accountKey)
  const existing = await getAdaptaProjectFolderByName(normalizedName, accountKey)
  if (existing) return existing
  if (!rt.activePage) throw new Error('Playwright not initialized')

  const headers = await getAdaptaSessionHeaders(accountKey)
  const response = await fetch(`${config.adapta.baseUrl}/api/folders/v2`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: normalizedName, type: 'CHATS' }),
  })
  const rawText = await response.text()
  if (!response.ok) {
    throw new Error(`Could not create Adapta project "${normalizedName}": ${response.status} ${response.statusText} - ${rawText.slice(0, 300)}`)
  }
  rt.cachedProjectFolders = null
  const payload = JSON.parse(rawText)
  const folder = payload?.data || payload
  if (typeof folder?.id !== 'string') {
    throw new Error(`Could not read created Adapta project id for "${normalizedName}".`)
  }
  return { id: folder.id, name: folder.name || normalizedName }
}

async function getAdaptaProjectFolders(accountKey?: string): Promise<AdaptaProjectFolder[]> {
  const rt = runtime(accountKey)
  if (rt.cachedProjectFolders) return rt.cachedProjectFolders
  if (!rt.activePage) throw new Error('Playwright not initialized')

  const release = await rt.pageOperationMutex.acquire()
  try {
    if (rt.cachedProjectFolders) return rt.cachedProjectFolders

  const page = rt.activePage
  const responsePromise = page.waitForResponse(response =>
    response.url().includes('/api/folders/v2') &&
    response.url().includes('type=CHATS') &&
    response.status() === 200,
  { timeout: config.timeouts.navigation }).catch(error => {
    console.warn(`[Playwright] Could not list Adapta project folders: ${error.message}`)
    return null
  })

  await page.goto(config.adapta.chatUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeouts.navigation,
  })

  const response = await responsePromise
  if (!response) return []
  const payload = await response.json().catch(() => null) as any
  const data = Array.isArray(payload?.data) ? payload.data : []

  const folders = data
    .filter((folder: any) => typeof folder?.id === 'string' && typeof folder?.name === 'string')
    .map((folder: any) => ({ id: folder.id, name: folder.name }))

  rt.cachedProjectFolders = folders
  return folders
  } finally {
    release()
  }
}

export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium'): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return
  currentHeadless = headless
  currentBrowserType = browserType
  const rt = defaultRuntime
  if (rt.context && rt.activePage) return

  const { engine, channel } = getBrowser(browserType)
  console.log(`[Playwright] Launching ${browserType} with profile ${profilePath()}`)

  rt.context = await engine.launchPersistentContext(profilePath(rt.currentProfileDir), {
    headless,
    channel,
    userAgent: config.browser.userAgent,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', ...config.browser.args],
  })

  await rt.context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  rt.activePage = await rt.context.newPage()
  if (rt === defaultRuntime) activePage = rt.activePage
  await rt.activePage.goto(config.adapta.chatUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeouts.navigation,
  }).catch(err => {
    console.warn(`[Playwright] Initial navigation failed: ${err.message}`)
  })

  await ensureNoMultipleSessionsBlock(rt.activePage)
  if (!(await hasValidSession())) {
    console.warn('[Playwright] No valid Adapta session detected. Run `npm run login` and login manually.')
  }
}

export async function closePlaywright(): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return
  for (const rt of [defaultRuntime, ...accountRuntimes.values()]) {
    rt.cachedChatRequest = null
    rt.cachedProjectFolders = null
    rt.cachedAuthorizationHeader = null
    rt.multipleSessionsRecoveryPromise = null
    await rt.context?.close()
    rt.context = null
    rt.activePage = null
  }
  activePage = null
}

export async function usePlaywrightAccount(options: {
  accountKey?: string
  profileDir: string
  headless?: boolean
  browserType?: BrowserType
  email?: string
  password?: string
}): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return
  const rt = runtime(options.accountKey)
  const nextProfileDir = path.resolve(options.profileDir)
  const nextHeadless = options.headless ?? currentHeadless
  const nextBrowserType = options.browserType || resolveConfiguredBrowserType()

  rt.currentCredentials = options.email && options.password
    ? { email: options.email, password: options.password }
    : null

  if (
    rt.context &&
    rt.activePage &&
    rt.currentProfileDir === nextProfileDir &&
    currentHeadless === nextHeadless &&
    currentBrowserType === nextBrowserType
  ) {
    return
  }

  await closePlaywrightAccount(options.accountKey)
  rt.currentProfileDir = nextProfileDir
  await initPlaywrightForRuntime(rt, nextHeadless, nextBrowserType, options.accountKey)
}

async function initPlaywrightForRuntime(
  rt: PlaywrightRuntime,
  headless = true,
  browserType: BrowserType = 'chromium',
  accountKey?: string,
): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return
  currentHeadless = headless
  currentBrowserType = browserType
  if (rt.context && rt.activePage) return

  const { engine, channel } = getBrowser(browserType)
  console.log(`[Playwright] Launching ${browserType} for ${accountKey || 'default'} with profile ${profilePath(rt.currentProfileDir)}`)

  rt.context = await engine.launchPersistentContext(profilePath(rt.currentProfileDir), {
    headless,
    channel,
    userAgent: config.browser.userAgent,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', ...config.browser.args],
  })

  await rt.context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  rt.activePage = await rt.context.newPage()
  if (rt === defaultRuntime) activePage = rt.activePage
  await rt.activePage.goto(config.adapta.chatUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeouts.navigation,
  }).catch(err => {
    console.warn(`[Playwright] Initial navigation failed for ${accountKey || 'default'}: ${err.message}`)
  })
  await ensureNoMultipleSessionsBlock(rt.activePage, accountKey)
}

async function closePlaywrightAccount(accountKey?: string): Promise<void> {
  const rt = runtime(accountKey)
  rt.cachedChatRequest = null
  rt.cachedProjectFolders = null
  rt.cachedAuthorizationHeader = null
  rt.multipleSessionsRecoveryPromise = null
  const loginContext = rt.loginContext
  rt.loginContext = null
  await loginContext?.close().catch(() => {})
  await rt.context?.close()
  rt.context = null
  rt.activePage = null
  if (rt === defaultRuntime) activePage = null
}

async function runNpmLogin(): Promise<void> {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCommand, ['run', 'login'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`npm run login exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function runCredentialLogin(accountKey?: string): Promise<void> {
  const rt = runtime(accountKey)
  if (!rt.currentCredentials) {
    await runNpmLogin()
    return
  }

  const release = await rt.loginMutex.acquire()
  try {
    const { context: loginContext, page } = await launchManualLogin(resolveConfiguredBrowserType(), {
      profileDir: rt.currentProfileDir || undefined,
      headless: config.browser.headless,
    })
    rt.loginContext = loginContext
    await tryCredentialLogin(page, rt.currentCredentials.email, rt.currentCredentials.password)
      .catch(error => console.warn(`[Playwright] Credential login did not complete automatically: ${error.message}`))
    await waitForManualLogin(page, config.timeouts.chat, accountKey)
  } finally {
    const loginContext = rt.loginContext
    rt.loginContext = null
    await loginContext?.close().catch(() => {})
    release()
  }
}

async function clearStoredAuthState(accountKey?: string): Promise<void> {
  const rt = runtime(accountKey)
  if (!rt.activePage || !rt.context) return

  await rt.context.clearCookies().catch(() => {})
  await rt.activePage.goto(config.adapta.baseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeouts.navigation,
  }).catch(() => {})
  await rt.activePage.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  }).catch(() => {})
}

async function ensureAuthenticatedSession(forceRefresh = false, accountKey?: string): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return
  const rt = runtime(accountKey)
  const recovered = await ensureNoMultipleSessionsBlock(rt.activePage, accountKey)
  if (recovered && await hasValidSession(accountKey).catch(() => false)) return
  if (!forceRefresh && await hasValidSession(accountKey).catch(() => false)) return

  if (!rt.autoLoginPromise) {
    rt.autoLoginPromise = (async () => {
      console.warn(forceRefresh
        ? '[Playwright] Adapta token was rejected upstream. Refreshing login automatically...'
        : '[Playwright] Adapta session is not authenticated. Running `npm run login` automatically...')
      if (forceRefresh) {
        rt.cachedAuthorizationHeader = null
        rt.cachedProjectFolders = null
        rt.cachedChatRequest = null
        await clearStoredAuthState(accountKey)
      }
      await closePlaywrightAccount(accountKey)
      await runCredentialLogin(accountKey)
      await initPlaywrightForRuntime(rt, currentHeadless, resolveConfiguredBrowserType(), accountKey)
      if (!(await hasValidSession(accountKey))) {
        throw new Error('Adapta session is not authenticated after automatic login.')
      }
      console.log('[Playwright] Automatic Adapta login completed.')
    })().finally(() => {
      rt.autoLoginPromise = null
    })
  }

  await rt.autoLoginPromise
}

export async function refreshAdaptaSession(accountKey?: string): Promise<void> {
  await ensureAuthenticatedSession(true, accountKey)
}

export async function hasValidSession(accountKey?: string): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return true
  const page = runtime(accountKey).activePage
  if (!page) return false
  if (await hasMultipleSessionsBlock(page)) return false

  const url = page.url()
  return !url.includes('/sign-in') && !url.includes('/login') && await hasAuthState(page)
}

export async function getAdaptaSessionHeaders(accountKey?: string): Promise<Record<string, string>> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return { cookie: 'token=mock', 'user-agent': 'mock' }
  }
  let page = runtime(accountKey).activePage
  if (!page) throw new Error('Playwright not initialized')
  await ensureNoMultipleSessionsBlock(page, accountKey)

  if (!(await hasValidSession(accountKey))) {
    await ensureAuthenticatedSession(false, accountKey)
  }
  page = runtime(accountKey).activePage
  if (!page) throw new Error('Playwright not initialized')
  await ensureNoMultipleSessionsBlock(page, accountKey)

  const cookieHeader = (await page.context().cookies(config.adapta.baseUrl))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ')

  const localAuthValue = await getLocalAuthValue(page)
  const headers: Record<string, string> = {
    'user-agent': await page.evaluate(() => navigator.userAgent),
    referer: config.adapta.chatUrl,
    origin: config.adapta.baseUrl,
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
  }

  if (cookieHeader) headers.cookie = cookieHeader

  if (localAuthValue && /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(localAuthValue)) {
    headers.authorization = `Bearer ${localAuthValue}`
  }

  if (!headers.authorization && (cookieHeader || localAuthValue)) {
    headers.authorization = await captureAuthorizationHeader(page, accountKey)
  }

  if (!headers.authorization && !cookieHeader && !localAuthValue) {
    throw new Error('No Adapta session data found. Run `npm run login` and authenticate first.')
  }

  return headers
}

export async function getAdaptaSessionDiagnostics(accountKey?: string): Promise<AdaptaSessionDiagnostics> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return {
      initialized: true,
      authenticated: true,
      authorizationCaptured: true,
      projectName: config.adapta.projectName || null,
      projectFound: config.adapta.projectName ? true : null,
      projectId: config.adapta.projectName ? 'mock-project' : null,
      currentUrl: config.adapta.chatUrl,
    }
  }

  const rt = runtime(accountKey)
  const diagnostics: AdaptaSessionDiagnostics = {
    initialized: Boolean(rt.activePage),
    authenticated: false,
    authorizationCaptured: Boolean(rt.cachedAuthorizationHeader),
    projectName: config.adapta.projectName || null,
    projectFound: config.adapta.projectName ? false : null,
    projectId: null,
    currentUrl: rt.activePage?.url() || null,
  }

  if (!rt.activePage) return diagnostics

  diagnostics.authenticated = await hasValidSession(accountKey).catch(() => false)
  if (diagnostics.authenticated) {
    const headers = await getAdaptaSessionHeaders(accountKey).catch((): Record<string, string> => ({}))
    diagnostics.authorizationCaptured = Boolean(headers.authorization)
  }

  if (diagnostics.authenticated && config.adapta.projectName) {
    const project = await getAdaptaProjectFolderByName(config.adapta.projectName, accountKey).catch(() => null)
    diagnostics.projectFound = Boolean(project)
    diagnostics.projectId = project?.id || null
  }

  diagnostics.currentUrl = rt.activePage.url()
  return diagnostics
}

export async function launchManualLogin(
  browserType: BrowserType = 'chromium',
  options: { profileDir?: string, headless?: boolean } = {},
): Promise<{ context: BrowserContext, page: Page }> {
  const { engine, channel } = getBrowser(browserType)
  const loginContext = await engine.launchPersistentContext(profilePath(options.profileDir || defaultRuntime.currentProfileDir), {
    headless: options.headless ?? false,
    channel,
    userAgent: config.browser.userAgent,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', ...config.browser.args],
  })

  await loginContext.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  const page = await loginContext.newPage()
  await page.goto(config.adapta.chatUrl, { waitUntil: 'domcontentloaded' })
  return { context: loginContext, page }
}

export async function waitForManualLogin(page: Page, timeoutMs = 0, accountKey?: string): Promise<void> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0
  while (true) {
    await ensureNoMultipleSessionsBlock(page, accountKey)
    const url = page.url()
    if (!url.includes('/sign-in') && !url.includes('/login') && await hasAuthState(page)) {
      return
    }
    if (deadline && Date.now() >= deadline) {
      throw new Error('Timed out waiting for Adapta authentication.')
    }
    await sleep(2000)
  }
}

export async function loginWithCredentials(options: {
  profileDir: string
  email: string
  password: string
  browserType?: BrowserType
}): Promise<void> {
  await loginWithCredentialsForAccount({ ...options })
}

export async function loginWithCredentialsForAccount(options: {
  accountKey?: string
  profileDir: string
  email: string
  password: string
  browserType?: BrowserType
}): Promise<void> {
  const rt = runtime(options.accountKey)
  const release = await rt.loginMutex.acquire()
  try {
    await closePlaywrightAccount(options.accountKey)
    rt.currentProfileDir = path.resolve(options.profileDir)
    rt.currentCredentials = { email: options.email, password: options.password }
    const { context: loginContext, page } = await launchManualLogin(options.browserType || resolveConfiguredBrowserType(), {
      profileDir: rt.currentProfileDir,
      headless: config.browser.headless,
    })
    rt.loginContext = loginContext
    await tryCredentialLogin(page, options.email, options.password)
      .catch(error => console.warn(`[Playwright] Credential login did not complete automatically: ${error.message}`))
    await waitForManualLogin(page, config.timeouts.chat, options.accountKey)
  } finally {
    const loginContext = rt.loginContext
    rt.loginContext = null
    await loginContext?.close().catch(() => {})
    release()
  }
}

export async function discoverAdaptaChatRequest(prompt: string, accountKey?: string): Promise<CapturedAdaptaRequest> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return {
      url: `${config.adapta.baseUrl}/api/chat`,
      method: 'POST',
      headers: { cookie: 'token=mock', 'user-agent': 'mock' },
      postData: { message: prompt },
    }
  }

  const rt = runtime(accountKey)
  const release = await rt.discoveryMutex.acquire()
  try {
    if (rt.cachedChatRequest) return rt.cachedChatRequest
    if (!rt.activePage) throw new Error('Playwright not initialized')

    await rt.activePage.goto(config.adapta.chatUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeouts.navigation,
    })

    if (!(await hasValidSession(accountKey))) {
      await ensureAuthenticatedSession(false, accountKey)
    }
    if (!rt.activePage) throw new Error('Playwright not initialized')

    const page = rt.activePage
    if (config.adapta.projectName) {
      await selectProjectFolderInUi(page, config.adapta.projectName, accountKey)
    }

    let onRoute: ((route: Route, request: Request) => Promise<void>) | undefined

    const captured = new Promise<CapturedAdaptaRequest>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (onRoute) page.unroute('**/*', onRoute).catch(() => {})
        reject(new Error('Could not detect Adapta chat request. Send a message in the opened browser once, then retry.'))
      }, 60000)

      onRoute = async (route: Route, request: Request) => {
        if (!isLikelyChatRequest(request)) {
          await route.continue()
          return
        }

        clearTimeout(timeout)
        if (onRoute) await page.unroute('**/*', onRoute).catch(() => {})

        const req = {
          url: request.url(),
          method: request.method(),
          headers: normalizeHeaders(request.headers()),
          postData: parsePostData(request),
        }

        rt.cachedChatRequest = req
        console.log(`[Playwright] Captured Adapta chat endpoint: ${req.method} ${req.url}`)
        await route.abort('aborted').catch(() => {})
        resolve(req)
      }
    })

    await page.route('**/*', onRoute!)
    await submitPromptThroughUi(page, prompt)
    return captured
  } finally {
    release()
  }
}

async function submitPromptThroughUi(page: Page, prompt: string): Promise<void> {
  const inputSelector = [
    '.ProseMirror[contenteditable="true"]:visible',
    '[contenteditable="true"][aria-label]:visible',
    'textarea:visible',
  ].join(', ')
  const input = page.locator(inputSelector).first()
  await input.waitFor({ timeout: config.timeouts.navigation })
  await input.focus()

  const element = await input.elementHandle()
  const isContentEditable = await element?.evaluate(el => (el as HTMLElement).isContentEditable)
  if (isContentEditable) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.type(prompt)
  } else {
    await input.fill(prompt)
  }

  await page.waitForTimeout(300)

  const box = await element?.boundingBox()
  if (box) {
    const clickedNearbyButton = await page.evaluate(({ x, y, width, height }) => {
      const visibleButtons = Array.from(document.querySelectorAll('button'))
        .map(button => ({ button, rect: button.getBoundingClientRect() }))
        .filter(({ button, rect }) => {
          const style = getComputedStyle(button)
          return !button.disabled &&
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        })

      const candidates = visibleButtons
        .filter(({ rect }) =>
          rect.left >= x + width - 80 &&
          rect.top >= y - 40 &&
          rect.bottom <= y + height + 80)
        .sort((a, b) => {
          const da = Math.abs(a.rect.left - (x + width)) + Math.abs(a.rect.top - y)
          const db = Math.abs(b.rect.left - (x + width)) + Math.abs(b.rect.top - y)
          return da - db
        })

      const target = candidates[0]?.button
      if (!target) return false
      target.click()
      return true
    }, box)

    if (clickedNearbyButton) return
  }

  await page.keyboard.press('Enter')
}

async function selectProjectFolderInUi(page: Page, projectName: string, accountKey?: string): Promise<void> {
  const project = await getAdaptaProjectFolderByName(projectName, accountKey)
  if (!project) {
    throw new Error(`Adapta project "${projectName}" was not found. Clear ADAPTA_PROJECT_NAME to use the default Chats menu.`)
  }

  await page.getByText(project.name, { exact: true }).click({
    timeout: config.timeouts.page,
    force: true,
  }).catch(async () => {
    await page.evaluate((name) => {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
        .filter(element => element.textContent?.trim() === name) as HTMLElement[]
      candidates[0]?.click()
    }, project.name)
  })
  await page.waitForURL(url => String(url).includes(`folderId=${project.id}`), {
    timeout: config.timeouts.page,
  }).catch(() => {})
  await page.waitForTimeout(500)
}
