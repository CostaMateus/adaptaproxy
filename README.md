# Adaptaproxy

Proxy local compatível com OpenAI para usar o chat da Adapta (`https://agent.adapta.one/agentic-chat`) via API.

O v1 usa perfis persistentes do Playwright por usuário. Cada usuário cria uma conta local em `/adaptaproxy/login`, conecta a própria conta ADAPTA em `/adaptaproxy/account`, gera uma API key própria e usa as rotas OpenAI-compatíveis em `/adaptaproxy/api/v1/*`.

## Status do v1

- `POST /adaptaproxy/api/v1/chat/completions`
- `GET /adaptaproxy/api/v1/models`
- `POST /adaptaproxy/api/v1/adapta/chats`
- `GET /adaptaproxy/api/v1/adapta/chats`
- `GET /adaptaproxy/api/v1/adapta/chats/:id`
- `DELETE /adaptaproxy/api/v1/adapta/chats/:id`
- modelos de texto listados em `/adaptaproxy/api/v1/models`, com `GPT_55` como padrão
- cadastro/login web em `/adaptaproxy/login`
- edição de conta, login automático ADAPTA e geração de API key em `/adaptaproxy/account`
- login manual via `npm run login`
- modo multiusuário corporativo com perfis Playwright isolados
- streaming SSE real quando `stream: true`
- sessões Playwright isoladas por usuário
- sessões locais persistidas em arquivo
- diagnóstico via `/adaptaproxy/doctor` e `npm run doctor`
- projeto padrão global ou por request via `metadata`
- perguntas de refinamento em texto e em `metadata.adapta_refinement_questions`
- listagem de chats reais da Adapta com `source=remote`

Ainda não há suporte para tools OpenAI-compatible, anexos ou cancelamento upstream.
Eventos upstream `reasoning-delta` são expostos como `reasoning_content` nas respostas OpenAI-compatible.

## Instalação

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Defina `ADAPTA_CREDENTIALS_SECRET` no `.env`. Ele é usado para criptografar as senhas ADAPTA salvas no SQLite. Cada usuário deve gerar a própria API key em `/adaptaproxy/account`.

## Fluxo multiusuário

1. Acesse `http://localhost:3000/adaptaproxy/login`.
2. Cadastre uma conta local com nome, email e senha local.
3. Acesse `/adaptaproxy/account`.
4. Informe email e senha da conta ADAPTA para o login automático.
5. Gere uma API key.
6. Use a API key nas rotas `/adaptaproxy/api/v1/*`.

Exemplo:

```bash
curl http://localhost:3000/adaptaproxy/api/v1/models \
  -H "Authorization: Bearer apx_sua_chave"
```

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

## Modo legado de conta

O `.env` aceita:

```env
ADAPTA_ACCOUNT_MODE=PERSONAL
ADAPTA_PROJECT_NAME=PROXY
```

Em `PERSONAL`, o proxy usa a conta configurada em `ADAPTA_EMAIL`/`ADAPTA_PASSWORD` ou a sessão manual salva no perfil pessoal.

O modo recomendado agora é usar cadastro web + API key por usuário. O modo `CORPORATE` antigo por `x-adapta-user-key` foi mantido apenas como legado interno e fica sob o prefixo `/adaptaproxy/api`.

```bash
curl -X POST http://localhost:3000/adaptaproxy/api/v1/adapta/users/login \
  -H "Authorization: Bearer your_proxy_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "userKey": "mateus",
    "email": "usuario@empresa.com",
    "password": "senha"
  }'
```

Para `CORPORATE`, defina também `ADAPTA_CREDENTIALS_SECRET` no `.env`.

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
GET /adaptaproxy/doctor
GET /adaptaproxy/health
```

## Exemplo com OpenAI SDK

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: process.env.ADAPTA_PROXY_USER_API_KEY || 'apx_sua_chave',
  baseURL: 'http://localhost:3000/adaptaproxy/api/v1',
})

const response = await client.chat.completions.create({
  model: 'GPT_55',
  messages: [
    { role: 'user', content: 'Explique o que e o Adaptaproxy.' },
  ],
})

console.log(response.choices[0]?.message?.content)
```

## VSCode / GitHub Copilot

Configure o endpoint customizado apontando para:

```text
http://localhost:3000/adaptaproxy/api/v1
```

Use:

```text
model: GPT_55
apiKey: <API key gerada em /adaptaproxy/account>
```

Para clientes OpenAI-compatible como Continue, Cline/Roo Code e OpenAI SDK, a configuração geral é a mesma:

```ts
baseURL: 'http://localhost:3000/adaptaproxy/api/v1'
model: 'GPT_55'
```

## Exemplo com cURL

```bash
curl -N http://localhost:3000/adaptaproxy/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key" \
  -d '{
    "model": "GPT_55",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Ola" }
    ]
}'
```

Para receber streaming SSE (`text/event-stream`), envie `"stream": true`. Sem esse campo, ou com `"stream": false`, `/chat/completions` retorna JSON completo ao final, seguindo o padrão de clientes OpenAI-compatible.

```json
{
  "model": "GPT_55",
  "stream": true,
  "messages": [
    { "role": "user", "content": "Ola" }
  ]
}
```

## Controle de chats

O endpoint `/chat/completions` continua compatível com clientes OpenAI, mas o Adaptaproxy aceita metadados próprios para controlar quando reutilizar ou criar chats na Adapta.

| Campo | Uso |
| --- | --- |
| `metadata.adapta_chat_mode` | Modo de conversa: `reuse`, `new` ou `specific` |
| `metadata.adapta_session_key` | Nome lógico da conversa. Chamadas com a mesma key reutilizam o chat remoto salvo |
| `metadata.adapta_chat_id` | ID de um chat remoto específico da Adapta |
| `metadata.adapta_new_chat` | Boolean legado; equivalente a `metadata.adapta_chat_mode: "new"` |

Modos:

| Modo | Comportamento |
| --- | --- |
| `reuse` | Reutiliza o chat remoto associado à `adapta_session_key`. É o padrão |
| `new` | Cria um novo chat remoto e passa a associá-lo à `adapta_session_key` |
| `specific` | Usa exatamente o chat de `adapta_chat_id`; exige `metadata.adapta_chat_id` |

Sem `metadata.adapta_chat_id` e sem `metadata.adapta_session_key`, a chamada usa a session key padrão (`ADAPTA_DEFAULT_CHAT_ID`). Na primeira chamada dessa session key, o Adaptaproxy cria um chat remoto real na Adapta e salva o mapeamento em `CHAT_SESSIONS_FILE`. Nas próximas chamadas, ele reutiliza o `remoteChatId` salvo.

```json
{
  "model": "GPT_55",
  "messages": [
    { "role": "user", "content": "Ola" }
  ]
}
```

A resposta inclui:

```json
{
  "metadata": {
    "adapta_chat_id": "...",
    "adapta_session_key": "default"
  }
}
```

Para separar clientes, envie uma session key:

```json
{
  "model": "GPT_55",
  "metadata": {
    "adapta_session_key": "hermes"
  },
  "messages": [
    { "role": "user", "content": "Ola" }
  ]
}
```

Também é possível usar o header `x-adapta-session-key: hermes`.

Para criar um novo chat remoto explicitamente para a session key e passar a reutilizá-lo:

```json
{
  "model": "GPT_55",
  "metadata": {
    "adapta_session_key": "hermes",
    "adapta_chat_mode": "new"
  },
  "messages": [
    { "role": "user", "content": "Comece uma nova conversa." }
  ]
}
```

Também é possível usar o header `x-adapta-chat-mode: new`. O campo legado `metadata.adapta_new_chat: true` e o header `x-adapta-new-chat: true` continuam funcionando.

Para usar um chat remoto específico, envie o ID em `metadata`:

```json
{
  "model": "GPT_55",
  "metadata": {
    "adapta_chat_mode": "specific",
    "adapta_chat_id": "..."
  },
  "messages": [
    { "role": "user", "content": "Continue a conversa anterior." }
  ]
}
```

Quando `adapta_chat_id` é enviado, ele tem prioridade sobre a session key.

Para direcionar uma chamada para outro projeto/pasta sem reiniciar o servidor, use:

```json
{
  "model": "GPT_55",
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
curl -X POST http://localhost:3000/adaptaproxy/api/v1/adapta/chats \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_proxy_api_key" \
  -d '{ "title": "Meu chat" }'

curl http://localhost:3000/adaptaproxy/api/v1/adapta/chats \
  -H "Authorization: Bearer your_proxy_api_key"
```

Para listar chats reais da Adapta, use `source=remote`:

```bash
curl "http://localhost:3000/adaptaproxy/api/v1/adapta/chats?source=remote&projectName=CONSEN" \
  -H "Authorization: Bearer your_proxy_api_key"
```

Para tentar excluir um chat real da Adapta:

```bash
curl -X DELETE "http://localhost:3000/adaptaproxy/api/v1/adapta/chats/<chat_id>?source=remote" \
  -H "Authorization: Bearer your_proxy_api_key"
```

A exclusão remota depende do endpoint interno atual da Adapta. Se a UI mudar, o proxy retorna erro claro.

## Configuração

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `0.0.0.0` | Host HTTP |
| `APP_LOG_DIR` | `./logs` | Diretório dos logs estruturados diários |
| `APP_LOG_LEVEL` | `info` | Nível mínimo: `debug`, `info`, `warn` ou `error` |
| `APP_LOG_FILE` | `true` | Grava `adaptaproxy-AAAA-MM-DD.log` em formato JSON Lines |
| `APP_LOG_CONSOLE` | `true` | Também envia os eventos estruturados para stdout/stderr |
| `API_KEY` | vazio | Segredo legado opcional; as rotas `/adaptaproxy/api/v1/*` usam API key por usuário |
| `HEADLESS` | `true` | Inicia Playwright sem janela ao rodar o servidor |
| `USER_DATA_DIR` | `./adapta_profiles` | Perfil persistente do navegador |
| `CHAT_SESSIONS_FILE` | `./adapta_profiles/chat-sessions.json` | Arquivo de sessões locais de chat |
| `ADAPTA_DEFAULT_CHAT_ID` | `adaptaproxy-default-chat` | Session key padrão usada quando a request não envia `metadata.adapta_session_key` |
| `ADAPTA_ACCOUNT_MODE` | `PERSONAL` | `PERSONAL` usa uma conta; `CORPORATE` exige usuário por request |
| `ADAPTA_CREDENTIALS_SECRET` | vazio | Segredo usado para criptografar senhas ADAPTA salvas no SQLite |
| `CORPORATE_USERS_FILE` | `./adapta_profiles/users.json` | Cadastro criptografado dos usuários corporativos |
| `CORPORATE_SESSIONS_DIR` | `./adapta_profiles/users` | Diretório dos perfis Playwright por usuário corporativo |
| `ADAPTA_BASE_URL` | `https://agent.adapta.one` | Origem da Adapta |
| `ADAPTA_CHAT_URL` | `https://agent.adapta.one/agentic-chat` | Tela de chat usada para login e descoberta |
| `ADAPTA_MODEL_ID` | `GPT_55` | Modelo padrão; `/adaptaproxy/api/v1/models` lista as opções suportadas pela Adapta |
| `ADAPTA_PROJECT_NAME` | `PROXY` | Nome do projeto/pasta validado ou criado no primeiro uso da conta |

Para criar novos chats sempre dentro do projeto `nome_da_pasta`:

```env
ADAPTA_PROJECT_NAME=nome_da_pasta
```

Se o projeto configurado não existir na Adapta, o proxy retorna erro claro em vez de criar o chat fora da pasta.

## Logs e diagnóstico

O aplicativo grava um arquivo JSON Lines por dia em `logs/adaptaproxy-AAAA-MM-DD.log`. Cada requisição recebe um `requestId`, devolvido também no header `X-Request-ID`, para correlacionar a entrada HTTP com as fases do navegador e da comunicação com a ADAPTA.

Os eventos incluem rota sem query string, status HTTP, duração e fases como `browser.account_activation`, `session.headers_capture`, `upstream.request`, `upstream.response`, `session.refresh` e `completion.parsed`. Não são registrados prompts, corpos de requisição/resposta, e-mails, API keys, cookies ou senhas. Campos sensíveis encontrados em erros são substituídos por `[REDACTED]`.

No Windows Server, acompanhe o arquivo atual em tempo real:

```powershell
Get-Content "C:\www\adaptaproxy\logs\adaptaproxy-$(Get-Date -Format yyyy-MM-dd).log" -Tail 100 -Wait
```

Para localizar toda a cadeia de uma requisição:

```powershell
Select-String -Path "C:\www\adaptaproxy\logs\adaptaproxy-*.log" -Pattern '"requestId":"ID_RECEBIDO_NO_HEADER"'
```

Falhas de TLS que aconteçam antes de a chamada chegar ao Node.js aparecem apenas no log do Apache; nesse caso não haverá `requestId` no log do aplicativo.

## Segurança

- Não versione `.env`.
- Não versione `data/`; ele contém o SQLite local.
- Não versione `adapta_profiles/`; ele contém sessão do navegador.
- Não versione `CHAT_SESSIONS_FILE` se ele estiver fora de `adapta_profiles/`.
- Logs e erros passam por redaction de `Authorization`, cookies, JWTs, API keys, tokens, segredos e senhas.
- Use uma API key individual gerada em `/adaptaproxy/account` para cada cliente/usuário.

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

