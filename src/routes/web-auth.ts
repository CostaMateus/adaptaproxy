import { Hono } from 'hono'
import { config } from '../core/config.ts'
import {
  createUser,
  createWebSession,
  deleteWebSession,
  generateApiKeyForUser,
  getAdaptaAccountForUser,
  getUserBySession,
  saveAdaptaAccount,
  updateAdaptaAccountStatus,
  verifyUserLogin,
} from '../services/auth-store.ts'
import { ensureAdaptaProjectFolder, loginWithCredentialsForAccount, usePlaywrightAccount } from '../services/playwright.ts'
import { redactSecrets } from '../utils/redact.ts'

const app = new Hono()

function getCookie(header: string | undefined, name: string): string {
  if (!header) return ''
  const cookies = header.split(';').map(part => part.trim())
  for (const cookie of cookies) {
    const [key, ...rawValue] = cookie.split('=')
    if (key === name) return decodeURIComponent(rawValue.join('='))
  }
  return ''
}

function sessionCookie(value: string, maxAge = 7 * 24 * 60 * 60): string {
  return `adaptaproxy_session=${encodeURIComponent(value)}; Path=/adaptaproxy; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
}

function html(title: string, body: string): Response {
  return new Response(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #1f2933; }
    main { width: min(920px, calc(100vw - 32px)); margin: 40px auto; }
    .panel { background: #fff; border: 1px solid #d8dee6; border-radius: 8px; padding: 24px; box-shadow: 0 8px 28px rgba(15, 23, 42, 0.06); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 18px; margin: 0 0 16px; }
    p { line-height: 1.5; }
    label { display: block; font-size: 13px; font-weight: 650; margin: 12px 0 6px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #b9c2cf; border-radius: 6px; font: inherit; }
    button, .button { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 0 14px; border: 0; border-radius: 6px; background: #165dff; color: #fff; font-weight: 700; text-decoration: none; cursor: pointer; }
    .button.secondary, button.secondary { background: #334155; }
    .danger { color: #b42318; background: #fff1f0; border: 1px solid #ffccc7; padding: 10px 12px; border-radius: 6px; }
    .success { color: #05603a; background: #ecfdf3; border: 1px solid #abefc6; padding: 10px 12px; border-radius: 6px; }
    .muted { color: #5f6b7a; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    code { background: #eef2f7; border: 1px solid #d8dee6; border-radius: 6px; padding: 2px 6px; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function formBody(c: any): Promise<Record<string, string>> {
  const form = await c.req.formData()
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]))
}

function currentUser(c: any) {
  const sessionId = getCookie(c.req.header('Cookie'), 'adaptaproxy_session')
  return getUserBySession(sessionId)
}

function loginPage(message = '', kind: 'danger' | 'success' = 'danger') {
  return html('Adaptaproxy Login', `
    <h1>Adaptaproxy</h1>
    ${message ? `<p class="${kind}">${escapeHtml(message)}</p>` : ''}
    <div class="grid">
      <section class="panel">
        <h2>Entrar</h2>
        <form method="post" action="/adaptaproxy/login">
          <label>Email</label>
          <input name="email" type="email" autocomplete="email" required>
          <label>Senha</label>
          <input name="password" type="password" autocomplete="current-password" required>
          <p><button type="submit">Entrar</button></p>
        </form>
      </section>
      <section class="panel">
        <h2>Cadastrar</h2>
        <form method="post" action="/adaptaproxy/register">
          <label>Nome</label>
          <input name="name" autocomplete="name" required>
          <label>Email da conta ADAPTA</label>
          <input name="email" type="email" autocomplete="email" required>
          <label>Senha local do Adaptaproxy</label>
          <input name="password" type="password" autocomplete="new-password" required>
          <p><button class="secondary" type="submit">Criar conta</button></p>
        </form>
      </section>
    </div>
  `)
}

app.get('/adaptaproxy', c => c.redirect('/adaptaproxy/login'))

app.get('/adaptaproxy/login', c => {
  if (currentUser(c)) return c.redirect('/adaptaproxy/account')
  return loginPage()
})

app.post('/adaptaproxy/login', async c => {
  const body = await formBody(c)
  const user = verifyUserLogin(body.email || '', body.password || '')
  if (!user) return loginPage('Email ou senha invalidos.')
  c.header('Set-Cookie', sessionCookie(createWebSession(user.id)))
  return c.redirect('/adaptaproxy/account')
})

app.post('/adaptaproxy/register', async c => {
  try {
    const body = await formBody(c)
    const user = createUser({
      name: body.name || '',
      email: body.email || '',
      password: body.password || '',
    })
    c.header('Set-Cookie', sessionCookie(createWebSession(user.id)))
    return c.redirect('/adaptaproxy/account')
  } catch (error: any) {
    return loginPage(error.message || 'Nao foi possivel cadastrar.')
  }
})

app.post('/adaptaproxy/logout', c => {
  deleteWebSession(getCookie(c.req.header('Cookie'), 'adaptaproxy_session'))
  c.header('Set-Cookie', sessionCookie('', 0))
  return c.redirect('/adaptaproxy/login')
})

app.get('/adaptaproxy/account', c => {
  const user = currentUser(c)
  if (!user) return c.redirect('/adaptaproxy/login')
  const account = getAdaptaAccountForUser(user.id)
  const apiKeyHint = user.apiKeyPrefix ? `${user.apiKeyPrefix}...` : 'Nenhuma API key gerada'
  return html('Adaptaproxy Conta', `
    <section class="panel">
      <div class="row" style="justify-content: space-between">
        <div>
          <h1>Conta</h1>
          <p class="muted">${escapeHtml(user.name)} · ${escapeHtml(user.email)}</p>
        </div>
        <form method="post" action="/adaptaproxy/logout"><button class="secondary" type="submit">Sair</button></form>
      </div>
      <hr>
      <h2>API</h2>
      <p>Use sua chave em <code>Authorization: Bearer &lt;api_key&gt;</code> nas rotas <code>/adaptaproxy/api/v1/*</code>.</p>
      <p>Chave atual: <code>${escapeHtml(apiKeyHint)}</code></p>
      <form method="post" action="/adaptaproxy/account/api-key">
        <button type="submit">Gerar nova API key</button>
      </form>
    </section>
    <section class="panel" style="margin-top:16px">
      <h2>Conta ADAPTA</h2>
      <p>Status: <code>${escapeHtml(account?.sessionStatus || 'desconectada')}</code></p>
      ${account ? `<p>Email conectado: <code>${escapeHtml(account.adaptaEmail)}</code></p>` : ''}
      <form method="post" action="/adaptaproxy/account/adapta">
        <label>Email ADAPTA</label>
        <input name="email" type="email" value="${escapeHtml(account?.adaptaEmail || user.email)}" autocomplete="email" required>
        <label>Senha ADAPTA</label>
        <input name="password" type="password" autocomplete="current-password" required>
        <p><button type="submit">Conectar ou atualizar ADAPTA</button></p>
      </form>
    </section>
  `)
})

app.post('/adaptaproxy/account/api-key', c => {
  const user = currentUser(c)
  if (!user) return c.redirect('/adaptaproxy/login')
  const apiKey = generateApiKeyForUser(user.id)
  return html('API key gerada', `
    <section class="panel">
      <h1>API key gerada</h1>
      <p class="success">Guarde esta chave agora. Ela nao sera exibida novamente.</p>
      <p><code>${escapeHtml(apiKey)}</code></p>
      <p><a class="button" href="/adaptaproxy/account">Voltar</a></p>
    </section>
  `)
})

app.post('/adaptaproxy/account/adapta', async c => {
  const user = currentUser(c)
  if (!user) return c.redirect('/adaptaproxy/login')
  const body = await formBody(c)

  try {
    const profileDir = `./adapta_profiles/users/${user.id}`
    await loginWithCredentialsForAccount({
      accountKey: user.id,
      profileDir,
      email: body.email || '',
      password: body.password || '',
    })
    await usePlaywrightAccount({
      accountKey: user.id,
      profileDir,
      email: body.email || '',
      password: body.password || '',
    })
    const project = await ensureAdaptaProjectFolder(config.adapta.projectName, user.id).catch(error => {
      console.warn(`[web-auth] Could not ensure project: ${redactSecrets(error.message)}`)
      return null
    })
    saveAdaptaAccount({
      userId: user.id,
      adaptaEmail: body.email || '',
      adaptaPassword: body.password || '',
      projectName: config.adapta.projectName,
      projectId: project?.id || null,
    })
    updateAdaptaAccountStatus(user.id, 'valid', project?.id || null)
    return html('Conta ADAPTA conectada', `
      <section class="panel">
        <h1>Conta ADAPTA conectada</h1>
        <p class="success">Login automatico concluido e senha salva criptografada.</p>
        <p><a class="button" href="/adaptaproxy/account">Voltar</a></p>
      </section>
    `)
  } catch (error: any) {
    return html('Erro ADAPTA', `
      <section class="panel">
        <h1>Conta ADAPTA</h1>
        <p class="danger">${escapeHtml(redactSecrets(error.message || 'Nao foi possivel conectar a conta ADAPTA.'))}</p>
        <p><a class="button" href="/adaptaproxy/account">Voltar</a></p>
      </section>
    `)
  }
})

export { app }
