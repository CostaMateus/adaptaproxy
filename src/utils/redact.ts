const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*bearer\s+)[^\s"',}]+/gi, '$1[REDACTED]'],
  [/(cookie\s*[:=]\s*)[^"',}]+/gi, '$1[REDACTED]'],
  [/([A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.)[A-Za-z0-9-_]+/g, '$1[REDACTED]'],
  [/(api[_-]?key\s*[:=]\s*)[^"',}\s]+/gi, '$1[REDACTED]'],
]

export function redactSecrets(value: unknown): string {
  let text = value instanceof Error ? value.stack || value.message : String(value)
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  return text
}
