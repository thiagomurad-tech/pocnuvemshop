# Testando o Webhook Localmente

## Iniciar o Webhook Receiver

```bash
npm start
# ou para desenvolvimento com hot reload:
npm run dev
```

O serviço estará disponível em: `http://localhost:3001`

## 1️⃣ Teste com `curl`

### Requisição válida (202 Accepted)

```bash
curl -X POST http://localhost:3001/webhook/stock \
  -H "Content-Type: application/json" \
  -d '{
    "sku_code": "TSHIRT-XL",
    "product_id": "prod-123",
    "variant_id": "var-456",
    "stock": 100
  }'
```

**Resposta esperada:**
```json
{
  "jobId": "123e4567-e89b-12d3-a456-426614174000",
  "status": "queued"
}
```

### Requisição com campos faltando (400 Bad Request)

```bash
curl -X POST http://localhost:3001/webhook/stock \
  -H "Content-Type: application/json" \
  -d '{
    "sku_code": "TSHIRT-XL"
  }'
```

**Resposta esperada:**
```json
{
  "error": "Campos obrigatórios: sku_code, product_id, variant_id, stock"
}
```

## 2️⃣ Teste com `fetch` (Node.js/Browser)

```javascript
const payload = {
  sku_code: 'TSHIRT-XL',
  product_id: 'prod-123',
  variant_id: 'var-456',
  stock: 100
};

const response = await fetch('http://localhost:3001/webhook/stock', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload)
});

if (response.status === 202) {
  const data = await response.json();
  console.log('Job enfileirado:', data.jobId);
} else {
  const error = await response.json();
  console.error('Erro:', error);
}
```

## 3️⃣ Health Check

```bash
# Liveness básico
curl http://localhost:3001/health

# Estado da fila (waiting / active / delayed / failed)
curl http://localhost:3001/health/queue
```

**Resposta `/health`:**
```json
{ "status": "ok" }
```

**Resposta `/health/queue`:**
```json
{
  "status": "healthy",
  "queue": {
    "name": "stock-updates",
    "waiting": 0,
    "active": 1,
    "delayed": 0,
    "failed": 0,
    "completed": 42
  },
  "alerts": [],
  "timestamp": "2026-05-25T22:00:00.000Z"
}
```

## ⚠️ Tratamento de Erros

### Erro: JSON inválido

Se você enviar um JSON malformado (ex: falta de aspas ou chaves):

```bash
curl -X POST http://localhost:3001/webhook/stock \
  -H "Content-Type: application/json" \
  -d '{"sku_code": "TEST"}}}' # ❌ Malformado
```

**Resposta:**
```json
{
  "error": "JSON inválido no body da requisição"
}
```

### Erro: stock é null

```bash
curl -X POST http://localhost:3001/webhook/stock \
  -H "Content-Type: application/json" \
  -d '{
    "sku_code": "TSHIRT-XL",
    "product_id": "prod-123",
    "variant_id": "var-456",
    "stock": null
  }'
```

Retorna 400 (campo obrigatório).

## 📋 Campos Obrigatórios

| Campo | Tipo | Descrição | Exemplo |
|-------|------|-----------|---------|
| `sku_code` | string | SKU do produto | `"TSHIRT-XL"` |
| `product_id` | string | ID do produto na EcommerceAPI | `"prod-123"` |
| `variant_id` | string | ID da variante | `"var-456"` |
| `stock` | number | Quantidade em estoque | `100` |

## 🧪 Testes Automatizados

Executar testes do webhook:

```bash
npm test -- --testPathPattern="webhook"
```

Todos os cenários estão cobertos em `tests/integration/webhook.test.js`:
- ✅ Payload válido → 202 Accepted
- ✅ JSON inválido → 400 Bad Request  
- ✅ Campos faltando → 400 Bad Request
- ✅ Stock = 0 (edge case) → 202 Accepted
- ✅ Payloads grandes → 202 Accepted
- ✅ Health check → 200 OK
- ✅ Health da fila → 200 OK com contagens BullMQ
