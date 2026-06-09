import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../core/config.ts'

export interface CorporateUser {
  email: string
  encryptedPassword: string
  profileDir: string
  projectName: string
  projectId?: string
  createdAt: number
  updatedAt: number
}

interface CorporateUsersFile {
  users?: Record<string, CorporateUser>
}

function usersFile(): string {
  return path.resolve(config.adapta.corporateUsersFile)
}

export function normalizeAdaptaUserKey(userKey: string): string {
  const normalized = userKey.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  return normalized.replace(/^-+|-+$/g, '')
}

function readUsers(): CorporateUsersFile {
  try {
    return JSON.parse(fs.readFileSync(usersFile(), 'utf8')) as CorporateUsersFile
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[adapta-users] Could not load users file: ${error.message}`)
    }
    return { users: {} }
  }
}

function writeUsers(data: CorporateUsersFile): void {
  const file = usersFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ users: data.users || {} }, null, 2))
}

function encryptionKey(): Buffer {
  const secret = config.adapta.credentialsSecret
  if (!secret) {
    throw new Error('ADAPTA_CREDENTIALS_SECRET is required in CORPORATE mode to store user credentials.')
  }
  return crypto.createHash('sha256').update(secret).digest()
}

export function encryptCorporatePassword(password: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, encrypted].map(part => part.toString('base64url')).join('.')
}

export function decryptCorporatePassword(encryptedPassword: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = encryptedPassword.split('.')
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid encrypted corporate password format.')
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivRaw, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

export function corporateProfileDir(userKey: string): string {
  return path.resolve(config.adapta.corporateSessionsDir, normalizeAdaptaUserKey(userKey))
}

export function corporateChatSessionsFile(userKey: string): string {
  return path.resolve(corporateProfileDir(userKey), 'chat-sessions.json')
}

export function getCorporateUser(userKey: string): CorporateUser | null {
  const key = normalizeAdaptaUserKey(userKey)
  if (!key) return null
  return readUsers().users?.[key] || null
}

export function saveCorporateUser(input: {
  userKey: string
  email: string
  password: string
  projectName?: string
  projectId?: string
}): CorporateUser {
  const key = normalizeAdaptaUserKey(input.userKey)
  if (!key) throw new Error('Invalid corporate userKey.')

  const data = readUsers()
  const existing = data.users?.[key]
  const now = Date.now()
  const user: CorporateUser = {
    email: input.email,
    encryptedPassword: encryptCorporatePassword(input.password),
    profileDir: corporateProfileDir(key),
    projectName: input.projectName || config.adapta.projectName,
    projectId: input.projectId || existing?.projectId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
  data.users = { ...(data.users || {}), [key]: user }
  writeUsers(data)
  return user
}

export function updateCorporateUserProject(userKey: string, projectId: string): void {
  const key = normalizeAdaptaUserKey(userKey)
  const data = readUsers()
  const user = data.users?.[key]
  if (!user) return
  user.projectId = projectId
  user.updatedAt = Date.now()
  writeUsers(data)
}
