import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { redactSecrets } from '../utils/redact.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LoggerOptions {
  level?: LogLevel
  context?: string
  logDir?: string
  fileEnabled?: boolean
  consoleEnabled?: boolean
  now?: () => Date
}

export interface StructuredLogEntry {
  timestamp: string
  level: LogLevel
  event: string
  context?: string
  requestId?: string
  data?: Record<string, unknown>
}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']
const SENSITIVE_KEY = /(^|[_-])(authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|senha|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|client[_-]?secret|credential|credentials)([_-]|$)/i
const MAX_DEPTH = 8
const MAX_STRING_LENGTH = 2_000

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function sanitizeString(value: string): string {
  const redacted = redactSecrets(value)
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`
    : redacted
}

export function sanitizeLogValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]'
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return sanitizeString(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      ...(value.stack ? { stack: sanitizeString(value.stack) } : {}),
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => sanitizeLogValue(item, '', depth + 1))
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = sanitizeLogValue(childValue, childKey, depth + 1)
    }
    return output
  }
  return sanitizeString(String(value))
}

class DailyLogWriter {
  private readonly logDir: string
  private readonly enabled: boolean
  private readonly now: () => Date
  private filesystemErrorReported = false

  constructor(logDir: string, enabled: boolean, now: () => Date) {
    this.logDir = path.resolve(logDir)
    this.enabled = enabled
    this.now = now
  }

  write(entry: StructuredLogEntry): void {
    if (!this.enabled) return
    try {
      fs.mkdirSync(this.logDir, { recursive: true })
      const file = path.join(this.logDir, `adaptaproxy-${localDateKey(this.now())}.log`)
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' })
    } catch (error) {
      if (this.filesystemErrorReported) return
      this.filesystemErrorReported = true
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'logger.file_write_failed',
        data: sanitizeLogValue(error),
      }))
    }
  }
}

export class Logger {
  private readonly level: LogLevel
  private readonly context?: string
  private readonly consoleEnabled: boolean
  private readonly now: () => Date
  private readonly writer: DailyLogWriter

  constructor(options: LoggerOptions = {}, writer?: DailyLogWriter) {
    this.level = options.level || 'info'
    this.context = options.context
    this.consoleEnabled = options.consoleEnabled ?? true
    this.now = options.now || (() => new Date())
    this.writer = writer || new DailyLogWriter(
      options.logDir || './logs',
      options.fileEnabled ?? true,
      this.now,
    )
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVELS.indexOf(level) >= LEVELS.indexOf(this.level)
  }

  private write(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return
    const sanitized = data
      ? sanitizeLogValue(data) as Record<string, unknown>
      : undefined
    const requestId = typeof sanitized?.requestId === 'string'
      ? sanitized.requestId
      : undefined
    const entryData = sanitized ? { ...sanitized } : undefined
    if (entryData) delete entryData.requestId

    const entry: StructuredLogEntry = {
      timestamp: this.now().toISOString(),
      level,
      event: sanitizeString(event),
      ...(this.context ? { context: this.context } : {}),
      ...(requestId ? { requestId } : {}),
      ...(entryData && Object.keys(entryData).length ? { data: entryData } : {}),
    }

    this.writer.write(entry)
    if (!this.consoleEnabled) return
    const output = JSON.stringify(entry)
    if (level === 'error') {
      console.error(output)
    } else if (level === 'warn') {
      console.warn(output)
    } else {
      console.log(output)
    }
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.write('debug', event, data)
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.write('info', event, data)
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.write('warn', event, data)
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.write('error', event, data)
  }

  child(context: string): Logger {
    return new Logger({
      level: this.level,
      context: this.context ? `${this.context}.${context}` : context,
      consoleEnabled: this.consoleEnabled,
      now: this.now,
    }, this.writer)
  }
}

export const logger = new Logger({
  level: config.logging.level,
  logDir: config.logging.dir,
  fileEnabled: config.logging.fileEnabled,
  consoleEnabled: config.logging.consoleEnabled,
})
