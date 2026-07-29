const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(["']?(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|senha|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret)["']?\s*[:=]\s*["'])[^"'\r\n]+(["'])/gi, '$1[REDACTED]$2'],
  [/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"',}]+/gi, '$1[REDACTED]'],
  [/((?:cookie|set[_-]?cookie)\s*[:=]\s*)[^"',}\r\n]+/gi, '$1[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED]'],
  [/(api[_-]?key\s*[:=]\s*)[^"',}\s]+/gi, '$1[REDACTED]'],
  [/((?:password|passwd|senha|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token)\s*[:=]\s*)[^"',}&\s]+/gi, '$1[REDACTED]'],
]

export function redactSecrets(value: unknown): string {
  let text = value instanceof Error ? value.stack || value.message : String(value)
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  return text
}
