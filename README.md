# Adaptaproxy

Proxy local compatível com OpenAI para usar o chat da Adapta (`https://agent.adapta.one/agentic-chat`) via API.

O v1 usa uma sessão persistente do Playwright. Você faz login manualmente uma vez, o perfil fica salvo em `adapta_profiles/`, e o servidor reutiliza cookies/headers para enviar mensagens ao endpoint interno usado pela própria UI da Adapta.

## Status do v1

- `POST /v1/chat/completions`
- `GET /v1/models`
- `POST /v1/adapta/chats`
- `GET /v1/adapta/chats`
- `GET /v1/adapta/chats/:id`
- `DELETE /v1/adapta/chats/:id`
- modelo fixo `adapta-chat`
- login manual via `npm run login`
- streaming SSE real quando `stream: true`
- sessão única
- sessões locais persistidas em arquivo
- diagnóstico via `/doctor` e `npm run doctor`
- projeto padrão global ou por request via `metadata`
- perguntas de refinamento em texto e em `metadata.adapta_refinement_questions`
- listagem de chats reais da Adapta com `source=remote`

Ainda não há suporte para tools, anexos, reasoning, multi-conta, automação de login por email/senha ou cancelamento upstream.

## Instalação

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Opcionalmente defina `API_KEY` no `.env`. Se definido, clientes precisam enviar `Authorization: Bearer <API_KEY>`.

## Login manual

```bash
npm run login
```

Uma janela do navegador será aberta em `https://agent.adapta.one/agentic-chat`. Faça login manualmente. O comando termina quando uma sessão autenticada é detectada e salva em `adapta_profiles/`.

Também há variantes:

```bash
npm run login:chrome
npm run login:firefox
npm run login:edge
```

## Executar

```bash
npm start
```

Servidor padrão:

```text
http://localhost:3000
```

O servidor usa o endpoint interno conhecido da UI da Adapta e captura passivamente os headers de autenticação da sessão salva. Ele não envia mensagem de descoberta nem cria chats com `__adaptaproxy_discovery__`.

## Diagnóstico

```bash
npm run doctor
```

O comando valida Playwright, sessão Adapta, captura de `Authorization`, projeto configurado e persistência local de chats. O mesmo relatório está disponível em:

```text
GET /doctor
GET /health
```

## Exemplo com OpenAI SDK

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: process.env.API_KEY || 'local',
  baseURL: 'http://localhost:3000/v1',
})

const response = await client.chat.completions.create({
  model: 'adapta-chat',
  messages: [
    { role: 'user', content: 'Explique o que e o Adaptaproxy.' },
  ],
})

console.log(response.choices[0]?.message?.content)
```

## VSCode / GitHub Copilot

Configure o endpoint customizado apontando para:

```text
http://localhost:3000/v1
```

Use:

```text
model: adapta-chat
apiKey: <API_KEY do .env>
```

Para clientes OpenAI-compatible como Continue, Cline/Roo Code e OpenAI SDK, a configuração geral é a mesma:

```ts
baseURL: 'http://localhost:3000/v1'
model: 'adapta-chat'
```

## Exemplo com cURL

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key" \
  -d '{
    "model": "adapta-chat",
    "messages": [
      { "role": "user", "content": "Ola" }
    ]
  }'
```

## Controle de chats

Por padrão, chamadas sem `metadata.adapta_chat_id` reutilizam o chat fixo definido por `ADAPTA_DEFAULT_CHAT_ID`. Isso evita criar um chat novo na interface da Adapta a cada chamada da API. A sessão local é persistida em `CHAT_SESSIONS_FILE`, então sobrevive a restart do servidor:

```json
{
  "model": "adapta-chat",
  "messages": [
    { "role": "user", "content": "Ola" }
  ]
}
```

A resposta inclui:

```json
{
  "metadata": {
    "adapta_chat_id": "..."
  }
}
```

Para usar outro chat específico, envie o ID em `metadata`:

```json
{
  "model": "adapta-chat",
  "metadata": {
    "adapta_chat_id": "..."
  },
  "messages": [
    { "role": "user", "content": "Continue a conversa anterior." }
  ]
}
```

Para direcionar uma chamada para outro projeto/pasta sem reiniciar o servidor, use:

```json
{
  "model": "adapta-chat",
  "metadata": {
    "adapta_project_name": "PROJECT"
  },
  "messages": [
    { "role": "user", "content": "Criar este chat no projeto PROJECT." }
  ]
}
```

Também é possível usar diretamente o ID da pasta:

```json
{
  "metadata": {
    "adapta_folder_id": "12345678-1234-1234-1234-123456789012"
  }
}
```

Se a Adapta pedir refinamento, o texto fica em `choices[0].message.content` e as perguntas também são expostas em:

```json
{
  "metadata": {
    "adapta_refinement_questions": [
      {
        "question": "Qual nivel de detalhe voce quer?",
        "options": ["Resumo", "Detalhado"]
      }
    ]
  }
}
```

Tambem existem APIs auxiliares para scripts e debug:

```bash
curl -X POST http://localhost:3000/v1/adapta/chats \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key" \
  -d '{ "title": "Meu chat" }'

curl http://localhost:3000/v1/adapta/chats \
  -H "Authorization: Bearer your_proxy_api_key"
```

Para listar chats reais da Adapta, use `source=remote`:

```bash
curl "http://localhost:3000/v1/adapta/chats?source=remote&projectName=CONSEN" \
  -H "Authorization: Bearer your_proxy_api_key"
```

Para tentar excluir um chat real da Adapta:

```bash
curl -X DELETE "http://localhost:3000/v1/adapta/chats/<chat_id>?source=remote" \
  -H "Authorization: Bearer your_proxy_api_key"
```

A exclusão remota depende do endpoint interno atual da Adapta. Se a UI mudar, o proxy retorna erro claro.

## Configuração

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `0.0.0.0` | Host HTTP |
| `API_KEY` | vazio | Chave opcional do proxy |
| `HEADLESS` | `true` | Inicia Playwright sem janela ao rodar o servidor |
| `USER_DATA_DIR` | `./adapta_profiles` | Perfil persistente do navegador |
| `CHAT_SESSIONS_FILE` | `./adapta_profiles/chat-sessions.json` | Arquivo de sessões locais de chat |
| `ADAPTA_DEFAULT_CHAT_ID` | `adaptaproxy-default-chat` | Chat reutilizado quando a request não envia `metadata.adapta_chat_id` |
| `ADAPTA_BASE_URL` | `https://agent.adapta.one` | Origem da Adapta |
| `ADAPTA_CHAT_URL` | `https://agent.adapta.one/agentic-chat` | Tela de chat usada para login e descoberta |
| `ADAPTA_MODEL_ID` | `adapta-chat` | Modelo exposto em `/v1/models` |
| `ADAPTA_PROJECT_NAME` | vazio | Nome do projeto/pasta onde novos chats devem ser criados. Se vazio, usa o menu `CHATS` padrão |

Para criar novos chats sempre dentro do projeto `nome_da_pasta`:

```env
ADAPTA_PROJECT_NAME=nome_da_pasta
```

Se o projeto configurado não existir na Adapta, o proxy retorna erro claro em vez de criar o chat fora da pasta.

## Segurança

- Não versione `.env`.
- Não versione `adapta_profiles/`; ele contém sessão do navegador.
- Não versione `CHAT_SESSIONS_FILE` se ele estiver fora de `adapta_profiles/`.
- Logs e erros passam por redaction básica de `Authorization`, cookies, JWTs e API keys.
- Use `API_KEY` quando expuser o proxy para qualquer cliente fora da máquina local.

## Docker

```bash
docker compose up --build
```

Para login manual em Docker, prefira primeiro criar a sessão localmente com `npm run login` e montar `./adapta_profiles:/app/adapta_profiles`.

## Testes

```bash
npm run typecheck
npm test
```

## Observações

A Adapta não expõe aqui uma API pública documentada para esse chat. O Adaptaproxy depende de capturar e reaproveitar o endpoint interno usado pela UI. Mudanças na UI ou no contrato interno podem exigir ajuste no detector/payload.
