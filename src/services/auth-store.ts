import crypto from 'node:crypto'
import path from 'node:path'
import { getDatabase } from '../core/database.ts'
import { config } from '../core/config.ts'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface LocalUser {
  id: string
  name: string
  email: string
  passwordHash: string
  apiKeyHash: string | null
  apiKeyPrefix: string | null
  createdAt: number
  updatedAt: number
}

export interface AdaptaAccount {
  id: string
  userId: string
  adaptaEmail: string
  encryptedAdaptaPassword: string
  profileDir: string
  sessionStatus: string
  lastLoginAt: number | null
  lastValidatedAt: number | null
  projectName: string | null
  projectId: string | null
  createdAt: number
  updatedAt: number
}

export interface UserWithAdaptaAccount {
  user: LocalUser
  adaptaAccount: AdaptaAccount | null
}

function now(): number {
  return Date.now()
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function rowToUser(row: any): LocalUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    apiKeyHash: row.api_key_hash || null,
    apiKeyPrefix: row.api_key_prefix || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToAdaptaAccount(row: any): AdaptaAccount {
  return {
    id: row.id,
    userId: row.user_id,
    adaptaEmail: row.adapta_email,
    encryptedAdaptaPassword: row.encrypted_adapta_password,
    profileDir: row.profile_dir,
    sessionStatus: row.session_status,
    lastLoginAt: row.last_login_at,
    lastValidatedAt: row.last_validated_at,
    projectName: row.project_name,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function hashSecret(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function hashLocalPassword(password: string, salt = crypto.randomBytes(16).toString('base64url')): string {
  const hash = crypto.scryptSync(password, salt, 64).toString('base64url')
  return `scrypt:${salt}:${hash}`
}

export function verifyLocalPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split(':')
  if (scheme !== 'scrypt' || !salt || !expected) return false
  const actual = crypto.scryptSync(password, salt, 64).toString('base64url')
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

function encryptionKey(): Buffer {
  const secret = config.adapta.credentialsSecret || config.apiKey
  if (!secret && process.env.TEST_MOCK_PLAYWRIGHT) {
    return crypto.createHash('sha256').update('adaptaproxy-test-secret').digest()
  }
  if (!secret) {
    throw new Error('ADAPTA_CREDENTIALS_SECRET is required to store Adapta passwords.')
  }
  return crypto.createHash('sha256').update(secret).digest()
}

export function encryptAdaptaPassword(password: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, encrypted].map(part => part.toString('base64url')).join('.')
}

export function decryptAdaptaPassword(encryptedPassword: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = encryptedPassword.split('.')
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid encrypted Adapta password format.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

export function userProfileDir(userId: string): string {
  return path.resolve(config.adapta.corporateSessionsDir, userId)
}

export function userChatSessionsFile(userId: string): string {
  return path.resolve(userProfileDir(userId), 'chat-sessions.json')
}

export function createUser(input: { name: string, email: string, password: string }): LocalUser {
  const email = normalizeEmail(input.email)
  if (!input.name.trim()) throw new Error('Nome e obrigatorio.')
  if (!email) throw new Error('Email e obrigatorio.')
  if (!input.password) throw new Error('Senha e obrigatoria.')

  const db = getDatabase()
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) throw new Error('Este email ja esta cadastrado.')

  const id = crypto.randomUUID()
  const timestamp = now()
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.name.trim(), email, hashLocalPassword(input.password), timestamp, timestamp)

  return getUserById(id)!
}

export function getUserByEmail(email: string): LocalUser | null {
  const row = getDatabase()
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(normalizeEmail(email))
  return row ? rowToUser(row) : null
}

export function getUserById(id: string): LocalUser | null {
  const row = getDatabase().prepare('SELECT * FROM users WHERE id = ?').get(id)
  return row ? rowToUser(row) : null
}

export function verifyUserLogin(email: string, password: string): LocalUser | null {
  const user = getUserByEmail(email)
  if (!user) return null
  return verifyLocalPassword(password, user.passwordHash) ? user : null
}

export function createWebSession(userId: string): string {
  const id = crypto.randomBytes(32).toString('base64url')
  const timestamp = now()
  getDatabase().prepare(`
    INSERT INTO web_sessions (id, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, userId, timestamp + SESSION_TTL_MS, timestamp)
  return id
}

export function getUserBySession(sessionId: string): LocalUser | null {
  if (!sessionId) return null
  const row = getDatabase().prepare(`
    SELECT u.* FROM web_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?
  `).get(sessionId, now())
  return row ? rowToUser(row) : null
}

export function deleteWebSession(sessionId: string): void {
  if (!sessionId) return
  getDatabase().prepare('DELETE FROM web_sessions WHERE id = ?').run(sessionId)
}

export function generateApiKeyForUser(userId: string): string {
  const apiKey = `apx_${crypto.randomBytes(32).toString('base64url')}`
  getDatabase().prepare(`
    UPDATE users
    SET api_key_hash = ?, api_key_prefix = ?, updated_at = ?
    WHERE id = ?
  `).run(hashSecret(apiKey), apiKey.slice(0, 12), now(), userId)
  return apiKey
}

export function getUserByApiKey(apiKey: string): UserWithAdaptaAccount | null {
  if (!apiKey) return null
  const userRow = getDatabase().prepare('SELECT * FROM users WHERE api_key_hash = ?').get(hashSecret(apiKey))
  if (!userRow) return null
  const user = rowToUser(userRow)
  return { user, adaptaAccount: getAdaptaAccountForUser(user.id) }
}

export function getAdaptaAccountForUser(userId: string): AdaptaAccount | null {
  const row = getDatabase().prepare('SELECT * FROM adapta_accounts WHERE user_id = ?').get(userId)
  return row ? rowToAdaptaAccount(row) : null
}

export function saveAdaptaAccount(input: {
  userId: string
  adaptaEmail: string
  adaptaPassword: string
  projectName?: string
  projectId?: string | null
}): AdaptaAccount {
  const db = getDatabase()
  const existingForEmail = db.prepare(`
    SELECT user_id FROM adapta_accounts WHERE adapta_email = ? AND user_id <> ?
  `).get(normalizeEmail(input.adaptaEmail), input.userId)
  if (existingForEmail) throw new Error('Este email da Adapta ja esta conectado a outro usuario.')

  const existing = getAdaptaAccountForUser(input.userId)
  const timestamp = now()
  const id = existing?.id || crypto.randomUUID()
  const profileDir = existing?.profileDir || userProfileDir(input.userId)

  db.prepare(`
    INSERT INTO adapta_accounts (
      id, user_id, adapta_email, encrypted_adapta_password, profile_dir,
      session_status, last_login_at, last_validated_at, project_name, project_id,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      adapta_email = excluded.adapta_email,
      encrypted_adapta_password = excluded.encrypted_adapta_password,
      profile_dir = excluded.profile_dir,
      session_status = excluded.session_status,
      last_login_at = excluded.last_login_at,
      last_validated_at = excluded.last_validated_at,
      project_name = excluded.project_name,
      project_id = excluded.project_id,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.userId,
    normalizeEmail(input.adaptaEmail),
    encryptAdaptaPassword(input.adaptaPassword),
    profileDir,
    timestamp,
    timestamp,
    input.projectName || config.adapta.projectName,
    input.projectId || null,
    existing?.createdAt || timestamp,
    timestamp,
  )

  return getAdaptaAccountForUser(input.userId)!
}

export function updateAdaptaAccountStatus(userId: string, status: string, projectId?: string | null): void {
  getDatabase().prepare(`
    UPDATE adapta_accounts
    SET session_status = ?, last_validated_at = ?, project_id = COALESCE(?, project_id), updated_at = ?
    WHERE user_id = ?
  `).run(status, now(), projectId || null, now(), userId)
}
