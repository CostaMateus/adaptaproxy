const GENERIC_ADAPTA_CONNECTION_ERROR =
  'Não foi possível conectar sua conta ADAPTA. Tente novamente. Se o problema continuar, entre em contato com o suporte.'

export function getAdaptaConnectionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')

  if (/excesso de sessoes ativas|muitas sess(?:o|õ)es ativas|limite de dispositivos/i.test(message)) {
    return 'A ADAPTA atingiu o limite de dispositivos conectados. Desconecte as outras sessoes na plataforma e tente novamente.'
  }

  if (/executable does(?: not|n't) exist/i.test(message)) {
    return 'O navegador necessário para conectar sua conta está indisponível no servidor. Entre em contato com o suporte.'
  }

  if (
    /target page, context or browser has been closed/i.test(message) ||
    /opening in existing browser session/i.test(message) ||
    /profile.*(?:in use|locked)/i.test(message)
  ) {
    return 'Não foi possível iniciar uma nova sessão com a ADAPTA. Aguarde alguns segundos e tente novamente.'
  }

  if (/timeout|timed out/i.test(message)) {
    return 'A ADAPTA demorou mais que o esperado para responder. Tente novamente em alguns instantes.'
  }

  if (/net::err_|enotfound|econnrefused|econnreset/i.test(message)) {
    return 'Não foi possível acessar a ADAPTA no momento. Verifique sua conexão e tente novamente.'
  }

  return GENERIC_ADAPTA_CONNECTION_ERROR
}
