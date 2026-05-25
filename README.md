# Fashion Corp Middleware — pco-nuvemshop

Middleware de sincronização de estoque entre o SAP ERP da Fashion Corp
e a plataforma Nuvemshop Next.

## Contexto

O SAP envia webhooks de estoque sem controle de vazão (até 500 req/s).
Este middleware absorve os picos, elimina duplicatas e entrega as
atualizações à Nuvemshop respeitando o rate limit da plataforma
(bucket de 40 req, 2 req/s).

## Arquitetura (5 componentes)

```
SAP ERP (500 req/s)
  └─► Webhook Gateway       ← recebe tudo, responde 202
        └─► Redis unificado  ← fila (Streams) + cache de idempotência (SETEX)
              └─► Consumer Workers (concorrência = rate control embutido)
                    └─► Nuvemshop API   (PUT /products/:id/variants/:id)
                    └─► Dead Letter Queue (jobs falhos = DLQ nativa do BullMQ)
```

## Pré-requisitos

| Dependência | Versão mínima |
|-------------|---------------|
| Node.js     | 18.0.0        |
| Redis       | 6.0           |
| npm         | 8.x           |

### Instalar Redis localmente (macOS)
```bash
brew install redis
brew services start redis
```

### Instalar Redis localmente (Ubuntu/Debian)
```bash
sudo apt update && sudo apt install redis-server
sudo systemctl start redis
```

## Instalação

```bash
# 1. Clonar / entrar na pasta
cd ~/Documentos/projetos/pco-nuvemshop

# 2. Instalar dependências
npm install

# 3. Configurar variáveis de ambiente
cp .env.example .env
# Editar .env com suas credenciais Nuvemshop
```

## Configuração (.env)

```dotenv
NUVEMSHOP_STORE_ID=123456          # ID da loja na Nuvemshop
NUVEMSHOP_ACCESS_TOKEN=seu_token   # Token OAuth2 da loja
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3000
LOG_LEVEL=info
IDEMPOTENCY_TTL_SECONDS=300
```

## Como rodar

### Modo desenvolvimento (dois terminais)

**Terminal 1 — Webhook receiver:**
```bash
npm run dev
# Saída esperada:
# {"msg":"Webhook receiver iniciado","port":3000}
```

**Terminal 2 — Worker:**
```bash
npm run worker
# Saída esperada:
# {"msg":"Worker iniciado","queue":"stock-updates","concurrency":10}
```

### Simular webhook do SAP
```bash
curl -X POST http://localhost:3000/webhook/stock \
  -H "Content-Type: application/json" \
  -d '{
    "sku_code":   "SKU-001",
    "product_id": "456",
    "variant_id": "789",
    "stock":      42
  }'

# Resposta esperada:
# {"jobId":"1","status":"queued"}
```

### Health check
```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

## Testes

```bash
# Todos os testes (unitários + integração)
npm test

# Apenas unitários (sem Redis, sem Nuvemshop real)
npm run test:unit

# Apenas integração (nock simula a API Nuvemshop)
npm run test:integration
```

### Quando tiver conta Nuvemshop real

1. Crie um produto de teste e anote `product_id` e `variant_id`.
2. Configure `.env` com as credenciais reais.
3. Em `tests/integration/stock-update.test.js`, remova os blocos `nock.*`
   e atualize as constantes `PRODUCT_ID` / `VARIANT_ID`.
4. Execute `npm run test:integration`.

## Observabilidade

Logs estruturados em JSON são gravados em:
- `logs/combined.log` — todos os níveis
- `logs/error.log`    — apenas erros

Métricas de alerta recomendadas (Grafana / Datadog):

| Métrica                    | Threshold | Ação                     |
|----------------------------|-----------|--------------------------|
| Tamanho da fila (BullMQ)   | > 10.000  | Escalar workers          |
| Lag de processamento       | > 5 min   | Investigar imediatamente |
| Jobs na fila de falhas     | > 100     | Falha sistêmica          |

## Endpoint da API Nuvemshop

```
PUT https://api.nuvemshop.com.br/2025-03/{store_id}/products/{product_id}/variants/{variant_id}
```

Body:
```json
{ "stock": 42, "stock_management": true }
```

Rate limit padrão: bucket de 40 req, vazão de 2 req/s.
Planos Next/Evolution: multiplicador de 10x.
Header de controle: `x-rate-limit-reset` (ms para esvaziar o bucket).
