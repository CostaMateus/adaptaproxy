import 'dotenv/config'
import { BrowserType, launchManualLogin, waitForManualLogin } from './services/playwright.ts'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

function resolveBrowserType(): BrowserType {
  const browserArg = process.argv.find(arg => arg.startsWith('--browser='))
  if (browserArg) return browserArg.split('=')[1] as BrowserType
  if (process.env.BROWSER) return process.env.BROWSER as BrowserType
  return 'chromium'
}

async function askCredentials(): Promise<{ email: string, password: string } | null> {
  if (process.env.ADAPTA_EMAIL && process.env.ADAPTA_PASSWORD) {
    return {
      email: process.env.ADAPTA_EMAIL,
      password: process.env.ADAPTA_PASSWORD,
    }
  }

  if (process.argv.includes('--manual')) return null
  const rl = readline.createInterface({ input, output })
  try {
    const email = await rl.question('Adapta email (leave blank for manual login): ')
    if (!email) return null
    const password = await rl.question('Adapta password: ')
    if (!password) return null
    return { email, password }
  } finally {
    rl.close()
  }
}

async function tryCredentialLogin(page: any, email: string, password: string): Promise<boolean> {
  const emailInput = page.locator([
    'input[type="email"]',
    'input[name*="email" i]',
    'input[autocomplete="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="e-mail" i]',
  ].join(', ')).first()

  await emailInput.waitFor({ timeout: 15000 })
  await emailInput.fill(email)

  const passwordInput = page.locator([
    'input[type="password"]',
    'input[name*="password" i]',
    'input[autocomplete="current-password"]',
    'input[placeholder*="senha" i]',
    'input[placeholder*="password" i]',
  ].join(', ')).first()

  await passwordInput.waitFor({ timeout: 15000 })
  await passwordInput.fill(password)

  const submit = page.locator([
    'button[type="submit"]',
    'button:has-text("Entrar")',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    'button:has-text("Continuar")',
  ].join(', ')).first()

  if (await submit.count()) {
    await submit.click()
  } else {
    await page.keyboard.press('Enter')
  }

  await page.waitForURL(
    (url: URL) => !String(url).includes('/sign-in') && !String(url).includes('/login'),
    { timeout: 30000 },
  ).catch(() => {})

  return !page.url().includes('/sign-in') && !page.url().includes('/login')
}

async function main() {
  const browserType = resolveBrowserType()
  const credentials = await askCredentials()

  console.log(`Opening Adapta login with ${browserType}...`)
  console.log(credentials
    ? 'Trying credential login. If Adapta requires MFA/captcha/SSO, complete it in the browser window.'
    : 'Login manually in the browser window. This command will finish after the session is detected.')

  const { context, page } = await launchManualLogin(browserType)
  try {
    if (credentials) {
      await tryCredentialLogin(page, credentials.email, credentials.password).catch(err => {
        console.warn(`Credential login did not complete automatically: ${err.message}`)
      })
    }
    await waitForManualLogin(page)
    console.log('Adapta session detected and saved in adapta_profiles/.')
  } finally {
    await context.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
