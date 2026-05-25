# pco-nuvemshop — Middleware de Estoque SAP → Nuvemshop

Middleware de sincronização de estoque entre o SAP ERP da Fashion Corp e a plataforma Nuvemshop Next.

## Contexto

O SAP envia webhooks de estoque sem controle de vazão (até 500 req/s).  
Este middleware absorve os picos, elimina duplicatas e entrega as atualizações à Nuvemshop respeitando o rate limit da plataforma (bucket de 40 req, 2 req/s).

## Arquitetura

```
SAP ERP (500 req/s)
  └─► src/app.js          Express — recebe webhook, valida payload, responde 202
        └─► Redis (BullMQ) ← fila de jobs + cache de idempotência (SETEX)
              └─► src/worker.js   Consome fila (concorrência=10)
                    ├─► Idempotência   SHA-256(sku:stock) — descarta duplicatas
                    ├─► Rate Limiter   Token Bucket — sincroniza com x-rate-limit-remaining
                    └─► src/nuvemshop.js → POST /products/:id/variants/stock
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
git clone https://github.com/thiagomurad-tech/pocnuvemshop.git
cd pocnuvemshop
npm install
cp .env.example .env
# Editar .env com suas credenciais Nuvemshop
```

## Configuração (.env)

```dotenv
# Nuvemshop
NUVEMSHOP_STORE_ID=<seu_store_id>
NUVEMSHOP_ACCESS_TOKEN=<seu_access_token>
NUVEMSHOP_API_BASE_URL=https://api.nuvemshop.com.br/2025-03

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# App
PORT=3000
LOG_LEVEL=info                   # debug | info | warn | error

# Idempotência
IDEMPOTENCY_TTL_SECONDS=300      # janela de dedup (5 min)

# Rate limiter — Leaky Bucket Nuvemshop
RATE_LIMIT_MAX_TOKENS=40         # capacidade do bucket
RATE_LIMIT_REFILL_RATE=120       # req/min (÷60 = 2 req/s)
```

## Como rodar

Dois processos separados devem ser iniciados:

**Terminal 1 — Webhook receiver (porta 3000):**
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

```json
{ "status": "ok" }
```

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

### Testes E2E — API real Nuvemshop

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

## Quirks da API Nuvemshop

| Item | Detalhe |
|------|---------|
| Autenticação | Header `Authentication: bearer <token>` — **não** `Authorization` |
| Endpoint de estoque | `POST /2025-03/{store_id}/products/{product_id}/variants/stock` |
| Body obrigatório | `{ "action": "replace", "value": <qty>, "id": "<variant_id>" }` |
| Rate limit | bucket=40 req, drain=2 req/s |
| Header de controle | `x-rate-limit-remaining` e `x-rate-limit-reset` (ms) |
| User-Agent | Obrigatório — formato: `NomeDaApp (email@parceiro.com)` |

## Observabilidade

Logs em JSON gravados em:
- `logs/combined.log` — todos os níveis
- `logs/error.log` — apenas erros

Campos fixos para filtro em dashboards:

| Campo | Quando aparece | Uso |
|-------|----------------|-----|
| `alert: "DLQ"` | Job esgotou tentativas | Alerta crítico |
| `msg: "duplicata"` | Evento idempotente descartado | Métricas de dedup |
| `msg: "back-pressure ativo"` | Fila do rate limiter > 0 | Alerta de saturação |

Thresholds recomendados:

| Métrica | Threshold | Ação |
|---------|-----------|------|
| Tamanho da fila BullMQ | > 10.000 | Escalar workers |
| Lag de processamento | > 5 min | Investigar |
| Jobs na DLQ | > 100 | Falha sistêmica |
