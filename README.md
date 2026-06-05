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
- streaming SSE simulado quando `stream: true`
- sessão única

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

Na primeira chamada de chat, se o endpoint interno da Adapta ainda não tiver sido descoberto, o Playwright tenta enviar uma mensagem curta pela UI e capturar a requisição real. Se isso falhar, envie uma mensagem manualmente na janela aberta e tente novamente.

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

Por padrão, cada chamada sem `metadata.adapta_chat_id` cria uma sessão local nova e retorna o ID usado:

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

Para continuar no mesmo chat, envie o ID em `metadata`:

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

Tambem existem APIs auxiliares para scripts e debug:

```bash
curl -X POST http://localhost:3000/v1/adapta/chats \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key" \
  -d '{ "title": "Meu chat" }'

curl http://localhost:3000/v1/adapta/chats \
  -H "Authorization: Bearer your_proxy_api_key"
```

## Configuração

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `0.0.0.0` | Host HTTP |
| `API_KEY` | vazio | Chave opcional do proxy |
| `HEADLESS` | `true` | Inicia Playwright sem janela ao rodar o servidor |
| `USER_DATA_DIR` | `./adapta_profiles` | Perfil persistente do navegador |
| `ADAPTA_BASE_URL` | `https://agent.adapta.one` | Origem da Adapta |
| `ADAPTA_CHAT_URL` | `https://agent.adapta.one/agentic-chat` | Tela de chat usada para login e descoberta |
| `ADAPTA_MODEL_ID` | `adapta-chat` | Modelo exposto em `/v1/models` |
| `ADAPTA_PROJECT_NAME` | vazio | Nome do projeto/pasta onde novos chats devem ser criados. Se vazio, usa o menu `CHATS` padrão |

Para criar novos chats sempre dentro do projeto `nome_da_pasta`:

```env
ADAPTA_PROJECT_NAME=nome_da_pasta
```

Se o projeto configurado não existir na Adapta, o proxy retorna erro claro em vez de criar o chat fora da pasta.

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
