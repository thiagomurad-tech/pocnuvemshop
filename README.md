# ecommerce-webhook-middleware

Middleware de sincronização de estoque entre um SAP ERP e uma plataforma de e-commerce.

## Contexto

O SAP envia webhooks de estoque sem controle de vazão (até 500 req/s).  
Este middleware absorve os picos, elimina duplicatas e entrega as atualizações à EcommerceAPI respeitando o rate limit da plataforma (bucket de 500 req (1 s burst), 500 req/s).

## Arquitetura

```
SAP ERP (500 req/s)
  └─► src/app.js          Express — recebe webhook, valida payload, responde 202
        └─► Redis (BullMQ) ← fila de jobs + cache de idempotência (SETEX)
              └─► src/worker.js   Consome fila (concorrência=10)
                    ├─► Idempotência   SHA-256(sku:stock) — descarta duplicatas
                    ├─► Rate Limiter   Token Bucket — sincroniza com x-rate-limit-remaining
                    └─► src/ecommerce-api.js → POST /products/:id/variants/stock
                          └─► DLQ   Jobs falhos após 5 tentativas (BullMQ nativo)
```

## Pré-requisitos

| Dependência | Versão mínima |
|-------------|---------------|
| Node.js     | 18.0.0        |
| Redis       | 6.0           |
| npm         | 8.x           |

```bash
# macOS
brew install redis && brew services start redis

# Ubuntu/Debian
sudo apt update && sudo apt install redis-server && sudo systemctl start redis
```

## Instalação

```bash
git clone <repo-url>
cd ecommerce-webhook-middleware
npm install
cp .env.example .env
# Editar .env com suas credenciais
```

## Configuração (.env)

```dotenv
# EcommerceAPI
STORE_ID=<seu_store_id>
ACCESS_TOKEN=<seu_access_token>
API_BASE_URL=https://api.ecommerce.example.com
API_VERSION=v1

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# App
PORT=3001
LOG_LEVEL=info                   # debug | info | warn | error

# Idempotência
IDEMPOTENCY_TTL_SECONDS=300      # janela de dedup (5 min)

# Rate limiter
RATE_LIMIT_MAX_TOKENS=500        # capacidade do bucket (burst = 1 s de throughput)
RATE_LIMIT_REFILL_RATE=30000     # req/min (÷60 = 500 req/s)

# Grafana Loki (opcional — omitir desativa o envio)
LOKI_HOST=http://localhost:3100
```

## Como rodar

Dois processos separados devem ser iniciados:

**Terminal 1 — Webhook receiver (porta 3001):**
```bash
npm run dev       # desenvolvimento com hot reload
# npm start       # produção
```

**Terminal 2 — Worker:**
```bash
npm run worker
```

## Endpoints

### `POST /webhook/stock`

Recebe evento de atualização de estoque do SAP.

**Body:**
```json
{
  "sku_code":   "SKU-POSTMAN-001",
  "product_id": "346452988",
  "variant_id": "1531149939",
  "stock":      50
}
```

**Resposta 202:**
```json
{ "jobId": "1", "status": "queued" }
```

**Resposta 400** (campos faltando):
```json
{ "error": "Campos obrigatórios: sku_code, product_id, variant_id, stock" }
```

### `GET /health`

Liveness check básico do processo.

```json
{ "status": "ok" }
```

### `GET /health/queue`

Estado detalhado da fila BullMQ. Retorna **HTTP 503** quando o status for `critical`.

**Resposta 200 — healthy:**
```json
{
  "status": "healthy",
  "queue": {
    "name":      "stock-updates",
    "waiting":   0,
    "active":    2,
    "delayed":   0,
    "failed":    0,
    "completed": 148
  },
  "thresholds": {
    "waiting": { "warn": 1000, "critical": 10000 },
    "failed":  { "warn": 10,   "critical": 100   }
  },
  "alerts": [],
  "timestamp": "2026-05-25T22:00:45.462Z"
}
```

**Resposta 503 — critical** (fila travada ou DLQ cheia):
```json
{
  "status": "critical",
  "queue": { "waiting": 15200, "failed": 130 },
  "alerts": [
    "fila crítica: 15200 jobs aguardando (limite: 10000)",
    "DLQ crítica: 130 jobs com falha (limite: 100)"
  ]
}
```

**Tabela de status:**

| `status` | HTTP | Condição |
|----------|------|----------|
| `healthy` | 200 | Operação normal |
| `degraded` | 200 | `waiting > 1.000` ou `failed > 10` |
| `critical` | **503** | `waiting > 10.000` ou `failed > 100` |

## Testes

```bash
# Todos (unitários + integração) — sem Redis real, sem rede
npm test

# Apenas unitários
npm run test:unit

# Apenas integração
npm run test:integration

# Arquivo específico
npx jest tests/unit/rateLimiter.test.js --runInBand

# Padrão de nome
npm test -- --testPathPattern="webhook"
```

### Testes E2E — API real

Requer Redis local e credenciais reais no `.env`.

```bash
npm run test:e2e
```

Executa 4 cenários contra a API real:

| Cenário | Descrição |
|---------|-----------|
| C1 | Atualizar estoque → 50 via POST /variants/stock + GET de confirmação |
| C2 | Zerar estoque (stock=0) + GET de confirmação |
| C3 | 5 atualizações sequenciais sem atingir rate limit |
| C4 | Lookup de produto por SKU via GET /products/sku/:sku |

Ao final gera artefatos de evidência em `reports/` (gitignored):
- `evidence-<timestamp>.json` — payload, resposta e assertions por cenário
- `evidence-<timestamp>.html` — relatório visual com detalhes colapsáveis

## Quirks da EcommerceAPI

| Item | Detalhe |
|------|---------|
| Autenticação | Header `Authentication: bearer <token>` — **não** `Authorization` |
| Endpoint de estoque | `POST /{api_version}/{store_id}/products/{product_id}/variants/stock` |
| Body obrigatório | `{ "action": "replace", "value": <qty>, "id": "<variant_id>" }` |
| Rate limit | bucket=500 req (1 s burst), drain=500 req/s |
| Header de controle | `x-rate-limit-remaining` e `x-rate-limit-reset` (ms) |

## Observabilidade

### Logs locais

Logs em JSON gravados em:
- `logs/combined.log` — todos os níveis
- `logs/error.log` — apenas erros

Campos fixos para filtro:

| Campo | Quando aparece | Uso |
|-------|----------------|-----|
| `alert: "DLQ"` | Job esgotou tentativas | Alerta crítico |
| `msg: "duplicata"` | Evento idempotente descartado | Métricas de dedup |
| `msg: "back-pressure ativo"` | Fila do rate limiter > 0 | Alerta de saturação |
| `msg: "Job descartado"` | Erro 4xx não-retriável (ex: 404) | Produto inexistente na EcommerceAPI |

### Grafana Loki

O serviço envia logs diretamente ao Loki via HTTP quando `LOKI_HOST` está definido no `.env`.

**Queries LogQL prontas:**

```logql
# Todos os logs do serviço
{service="ecommerce-webhook-middleware"} | json

# Alertas DLQ (job sem solução após 5 tentativas)
{service="ecommerce-webhook-middleware", level="error"} | json | alert="DLQ"

# Rate limit atingido (429)
{service="ecommerce-webhook-middleware", level="warn"} | json | msg="EcommerceAPI rate limit atingido (429)"

# Jobs descartados por produto inexistente (404)
{service="ecommerce-webhook-middleware"} | json | status=404

# Back-pressure na fila do rate limiter
{service="ecommerce-webhook-middleware"} | json | queue_depth > 0

# Rastrear um SKU específico
{service="ecommerce-webhook-middleware"} | json | skuCode="SKU-POSTMAN-001"
```

### Monitoramento ativo da fila

Configure um monitor de uptime apontando para `GET /health/queue`. Quando a fila travar, o endpoint retorna HTTP 503 automaticamente.

| Métrica | Degraded | Critical (→ 503) | Ação recomendada |
|---------|----------|-------------------|------------------|
| `waiting` (fila crescendo) | > 1.000 | > 10.000 | Escalar workers |
| `failed` (DLQ) | > 10 | > 100 | Investigar erros, replay jobs |
