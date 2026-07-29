import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Logger, sanitizeLogValue } from '../core/logger.ts'

test('writes one structured daily JSONL event and redacts secrets', t => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptaproxy-logger-'))
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }))

  const now = new Date(2026, 6, 29, 12, 30, 0)
  const logger = new Logger({
    level: 'debug',
    context: 'test',
    logDir,
    fileEnabled: true,
    consoleEnabled: false,
    now: () => now,
  })

  logger.info('request.completed', {
    requestId: 'req-123',
    status: 200,
    durationMs: 42,
    authorization: 'Bearer bearer-secret',
    cookie: 'session=cookie-secret',
    password: 'password-secret',
    apiKey: 'api-key-secret',
    nested: {
      access_token: 'access-token-secret',
      safe: 'kept',
    },
    error: new Error('password=inline-secret'),
  })

  const logFile = path.join(logDir, 'adaptaproxy-2026-07-29.log')
  const lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/)
  assert.equal(lines.length, 1)

  const entry = JSON.parse(lines[0])
  assert.equal(entry.level, 'info')
  assert.equal(entry.event, 'request.completed')
  assert.equal(entry.context, 'test')
  assert.equal(entry.requestId, 'req-123')
  assert.equal(entry.data.status, 200)
  assert.equal(entry.data.durationMs, 42)
  assert.equal(entry.data.authorization, '[REDACTED]')
  assert.equal(entry.data.cookie, '[REDACTED]')
  assert.equal(entry.data.password, '[REDACTED]')
  assert.equal(entry.data.apiKey, '[REDACTED]')
  assert.equal(entry.data.nested.access_token, '[REDACTED]')
  assert.equal(entry.data.nested.safe, 'kept')
  assert.match(entry.data.error.message, /password=\[REDACTED\]/)

  const serialized = JSON.stringify(entry)
  for (const secret of [
    'bearer-secret',
    'cookie-secret',
    'password-secret',
    'api-key-secret',
    'access-token-secret',
    'inline-secret',
  ]) {
    assert.equal(serialized.includes(secret), false)
  }
})

test('sanitizes sensitive values nested in arbitrary metadata', () => {
  const sanitized = sanitizeLogValue({
    headers: {
      Authorization: 'Basic dXNlcjpwYXNz',
      'Set-Cookie': 'session=secret',
      Accept: 'application/json',
    },
    credentials: {
      email: 'not-logged-because-parent-is-sensitive@example.com',
    },
  }) as any

  assert.equal(sanitized.headers.Authorization, '[REDACTED]')
  assert.equal(sanitized.headers['Set-Cookie'], '[REDACTED]')
  assert.equal(sanitized.headers.Accept, 'application/json')
  assert.equal(sanitized.credentials, '[REDACTED]')
})
