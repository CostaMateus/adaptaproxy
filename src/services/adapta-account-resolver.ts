import path from 'node:path'
import { config } from '../core/config.ts'
import {
  corporateChatSessionsFile,
  decryptCorporatePassword,
  getCorporateUser,
  normalizeAdaptaUserKey,
} from './adapta-user-store.ts'
import {
  AdaptaAccount,
  LocalUser,
  decryptAdaptaPassword,
  userChatSessionsFile,
} from './auth-store.ts'

export type AdaptaAccountMode = 'PERSONAL' | 'CORPORATE'

export interface AdaptaAccountContext {
  mode: AdaptaAccountMode
  userKey: string
  userId?: string
  profileDir: string
  chatSessionsFile: string
  email: string
  password: string
  projectName: string
  projectId?: string
}

export class AdaptaAccountLoginRequiredError extends Error {
  readonly status = 401
  readonly type = 'adapta_account_login_required'
  readonly loginUrl = '/adaptaproxy/account'

  constructor() {
    super('Sua conta ADAPTA precisa ser conectada ou atualizada.')
    this.name = 'AdaptaAccountLoginRequiredError'
  }
}

export class AdaptaUserRequiredError extends Error {
  readonly status = 400
  readonly type = 'adapta_user_required'

  constructor() {
    super('CORPORATE mode requires x-adapta-user-key or metadata.adapta_user_key.')
    this.name = 'AdaptaUserRequiredError'
  }
}

export class AdaptaUserLoginRequiredError extends Error {
  readonly status = 401
  readonly type = 'adapta_user_login_required'

  constructor(userKey: string) {
    super(`Corporate user "${userKey}" is not logged in. Call POST /v1/adapta/users/login first.`)
    this.name = 'AdaptaUserLoginRequiredError'
  }
}

export function personalAccountContext(): AdaptaAccountContext {
  return {
    mode: 'PERSONAL',
    userKey: 'personal',
    profileDir: path.resolve(config.browser.userDataDir),
    chatSessionsFile: path.resolve(config.browser.userDataDir, 'personal', 'chat-sessions.json'),
    email: config.adapta.email,
    password: config.adapta.password,
    projectName: config.adapta.projectName,
  }
}

export function resolveAdaptaAccountContext(options: { userKey?: string } = {}): AdaptaAccountContext {
  if (config.adapta.accountMode === 'PERSONAL') return personalAccountContext()

  const userKey = normalizeAdaptaUserKey(options.userKey || '')
  if (!userKey) throw new AdaptaUserRequiredError()

  const user = getCorporateUser(userKey)
  if (!user) throw new AdaptaUserLoginRequiredError(userKey)

  return {
    mode: 'CORPORATE',
    userKey,
    profileDir: path.resolve(user.profileDir),
    chatSessionsFile: corporateChatSessionsFile(userKey),
    email: user.email,
    password: decryptCorporatePassword(user.encryptedPassword),
    projectName: user.projectName || config.adapta.projectName,
    projectId: user.projectId,
  }
}

export function accountContextFromAuthenticatedUser(input: {
  user: LocalUser
  adaptaAccount: AdaptaAccount | null
}): AdaptaAccountContext {
  if (!input.adaptaAccount) throw new AdaptaAccountLoginRequiredError()

  return {
    mode: 'CORPORATE',
    userKey: input.user.id,
    userId: input.user.id,
    profileDir: input.adaptaAccount.profileDir,
    chatSessionsFile: userChatSessionsFile(input.user.id),
    email: input.adaptaAccount.adaptaEmail,
    password: decryptAdaptaPassword(input.adaptaAccount.encryptedAdaptaPassword),
    projectName: input.adaptaAccount.projectName || config.adapta.projectName,
    projectId: input.adaptaAccount.projectId || undefined,
  }
}
