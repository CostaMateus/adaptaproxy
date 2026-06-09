import { chromium, firefox, webkit, BrowserContext, Page, Request, Route } from 'playwright'
import path from 'path'
import { spawn } from 'node:child_process'
import { config } from '../core/config.ts'

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

let context: BrowserContext | null = null
export let activePage: Page | null = null
let cachedChatRequest: CapturedAdaptaRequest | null = null
let cachedProjectFolders: AdaptaProjectFolder[] | null = null
let cachedAuthorizationHeader: string | null = null
let currentBrowserType: BrowserType = 'chromium'
let currentHeadless = true
let autoLoginPromise: Promise<void> | null = null

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

const discoveryMutex = new Mutex()
const pageOperationMutex = new Mutex()
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function resolveConfiguredBrowserType(): BrowserType {
  return (process.env.BROWSER as BrowserType | undefined) || currentBrowserType || 'chromium'
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

function profilePath(): string {
  return path.resolve(config.browser.userDataDir, '_default')
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

async function captureAuthorizationHeader(page: Page): Promise<string> {
  if (cachedAuthorizationHeader) return cachedAuthorizationHeader

  const release = await pageOperationMutex.acquire()
  try {
    const existingAuth = await waitForAuthorizationHeader(page, false)
    if (existingAuth) return existingAuth

    const authPromise = waitForAuthorizationHeader(page, true)
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

async function waitForAuthorizationHeader(page: Page, wait: boolean): Promise<string> {
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
      cachedAuthorizationHeader = authorization
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
  return cachedChatRequest
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

export async function getAdaptaProjectFolderByName(name: string): Promise<AdaptaProjectFolder | null> {
  const normalizedName = name.trim().toLowerCase()
  if (!normalizedName) return null

  const folders = await getAdaptaProjectFolders()
  return folders.find(folder => folder.name.trim().toLowerCase() === normalizedName) || null
}

export async function getAdaptaProjectFolderById(id: string): Promise<AdaptaProjectFolder | null> {
  const normalizedId = id.trim()
  if (!normalizedId) return null

  const folders = await getAdaptaProjectFolders()
  return folders.find(folder => folder.id === normalizedId) || null
}

export async function listAdaptaProjectFolders(): Promise<AdaptaProjectFolder[]> {
  return getAdaptaProjectFolders()
}

async function getAdaptaProjectFolders(): Promise<AdaptaProjectFolder[]> {
  if (cachedProjectFolders) return cachedProjectFolders
  if (!activePage) throw new Error('Playwright not initialized')

  const release = await pageOperationMutex.acquire()
  try {
    if (cachedProjectFolders) return cachedProjectFolders

  const page = activePage
  const responsePromise = page.waitForResponse(response =>
    response.url().includes('/api/folders/v2') &&
    response.url().includes('type=CHATS') &&
    response.status() === 200,
  { timeout: config.timeouts.navigation })

  await page.goto(config.adapta.chatUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeouts.navigation,
  })

  const response = await responsePromise
  const payload = await response.json().catch(() => null) as any
  const data = Array.isArray(payload?.data) ? payload.data : []

  const folders = data
    .filter((folder: any) => typeof folder?.id === 'string' && typeof folder?.name === 'string')
    .map((folder: any) => ({ id: folder.id, name: folder.name }))

  cachedProjectFolders = folders
  return folders
  } finally {
    release()
  }
}

export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium'): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return
  currentHeadless = headless
  currentBrowserType = browserType
  if (context && activePage) return

  const { engine, channel } = getBrowser(browserType)
  console.log(`[Playwright] Launching ${browserType} with profile ${profilePath()}`)

  context = await engine.launchPersistentContext(profilePath(), {
    headless,
    channel,
    userAgent: config.browser.userAgent,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', ...config.browser.args],
  })

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  activePage = await context.newPage()
  await activePage.goto(config.adapta.chatUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeouts.navigation,
  }).catch(err => {
    console.warn(`[Playwright] Initial navigation failed: ${err.message}`)
  })

  if (!(await hasValidSession())) {
    console.warn('[Playwright] No valid Adapta session detected. Run `npm run login` and login manually.')
  }
}

export async function closePlaywright(): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return
  cachedChatRequest = null
  cachedProjectFolders = null
  cachedAuthorizationHeader = null
  await context?.close()
  context = null
  activePage = null
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

async function clearStoredAuthState(): Promise<void> {
  if (!activePage || !context) return

  await context.clearCookies().catch(() => {})
  await activePage.goto(config.adapta.baseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeouts.navigation,
  }).catch(() => {})
  await activePage.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  }).catch(() => {})
}

async function ensureAuthenticatedSession(forceRefresh = false): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return
  if (!forceRefresh && await hasValidSession().catch(() => false)) return

  if (!autoLoginPromise) {
    autoLoginPromise = (async () => {
      console.warn(forceRefresh
        ? '[Playwright] Adapta token was rejected upstream. Refreshing login automatically...'
        : '[Playwright] Adapta session is not authenticated. Running `npm run login` automatically...')
      if (forceRefresh) {
        cachedAuthorizationHeader = null
        cachedProjectFolders = null
        cachedChatRequest = null
        await clearStoredAuthState()
      }
      await closePlaywright()
      await runNpmLogin()
      await initPlaywright(currentHeadless, resolveConfiguredBrowserType())
      if (!(await hasValidSession())) {
        throw new Error('Adapta session is not authenticated after automatic login.')
      }
      console.log('[Playwright] Automatic Adapta login completed.')
    })().finally(() => {
      autoLoginPromise = null
    })
  }

  await autoLoginPromise
}

export async function refreshAdaptaSession(): Promise<void> {
  await ensureAuthenticatedSession(true)
}

export async function hasValidSession(): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return true
  if (!activePage) return false

  const url = activePage.url()
  return !url.includes('/sign-in') && !url.includes('/login') && await hasAuthState(activePage)
}

export async function getAdaptaSessionHeaders(): Promise<Record<string, string>> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return { cookie: 'token=mock', 'user-agent': 'mock' }
  }
  if (!activePage) throw new Error('Playwright not initialized')

  if (!(await hasValidSession())) {
    await ensureAuthenticatedSession()
  }
  if (!activePage) throw new Error('Playwright not initialized')

  const cookieHeader = (await activePage.context().cookies(config.adapta.baseUrl))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ')

  const localAuthValue = await getLocalAuthValue(activePage)
  const headers: Record<string, string> = {
    'user-agent': await activePage.evaluate(() => navigator.userAgent),
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
    headers.authorization = await captureAuthorizationHeader(activePage)
  }

  if (!headers.authorization && !cookieHeader && !localAuthValue) {
    throw new Error('No Adapta session data found. Run `npm run login` and authenticate first.')
  }

  return headers
}

export async function getAdaptaSessionDiagnostics(): Promise<AdaptaSessionDiagnostics> {
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

  const diagnostics: AdaptaSessionDiagnostics = {
    initialized: Boolean(activePage),
    authenticated: false,
    authorizationCaptured: Boolean(cachedAuthorizationHeader),
    projectName: config.adapta.projectName || null,
    projectFound: config.adapta.projectName ? false : null,
    projectId: null,
    currentUrl: activePage?.url() || null,
  }

  if (!activePage) return diagnostics

  diagnostics.authenticated = await hasValidSession().catch(() => false)
  if (diagnostics.authenticated) {
    const headers = await getAdaptaSessionHeaders().catch((): Record<string, string> => ({}))
    diagnostics.authorizationCaptured = Boolean(headers.authorization)
  }

  if (diagnostics.authenticated && config.adapta.projectName) {
    const project = await getAdaptaProjectFolderByName(config.adapta.projectName).catch(() => null)
    diagnostics.projectFound = Boolean(project)
    diagnostics.projectId = project?.id || null
  }

  diagnostics.currentUrl = activePage.url()
  return diagnostics
}

export async function launchManualLogin(browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext, page: Page }> {
  const { engine, channel } = getBrowser(browserType)
  const loginContext = await engine.launchPersistentContext(profilePath(), {
    headless: false,
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

export async function waitForManualLogin(page: Page): Promise<void> {
  while (true) {
    const url = page.url()
    if (!url.includes('/sign-in') && !url.includes('/login') && await hasAuthState(page)) {
      return
    }
    await sleep(2000)
  }
}

export async function discoverAdaptaChatRequest(prompt: string): Promise<CapturedAdaptaRequest> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return {
      url: `${config.adapta.baseUrl}/api/chat`,
      method: 'POST',
      headers: { cookie: 'token=mock', 'user-agent': 'mock' },
      postData: { message: prompt },
    }
  }

  const release = await discoveryMutex.acquire()
  try {
    if (cachedChatRequest) return cachedChatRequest
    if (!activePage) throw new Error('Playwright not initialized')

    await activePage.goto(config.adapta.chatUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeouts.navigation,
    })

    if (!(await hasValidSession())) {
      await ensureAuthenticatedSession()
    }
    if (!activePage) throw new Error('Playwright not initialized')

    const page = activePage
    if (config.adapta.projectName) {
      await selectProjectFolderInUi(page, config.adapta.projectName)
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

        cachedChatRequest = req
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

async function selectProjectFolderInUi(page: Page, projectName: string): Promise<void> {
  const project = await getAdaptaProjectFolderByName(projectName)
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
