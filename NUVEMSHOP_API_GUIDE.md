# Integração com API Nuvemshop

## 📋 Overview

Este projeto agora integra-se com a **API real da Nuvemshop** para gerenciar produtos e estoque, mantendo:
- ✅ Testes locais com `nock` (sem chamar API externa)
- ✅ Rate limiting com Token Bucket
- ✅ Idempotência de requisições
- ✅ Resumo de logs estruturados

## 🔐 Autenticação

### Credenciais da Loja

A API Nuvemshop usa autenticação Bearer Token:

```
Store ID (user_id): <SEU_STORE_ID>
Access Token: <SEU_ACCESS_TOKEN>
Scope: write_products
```

### Variáveis de Ambiente

```bash
# .env
NUVEMSHOP_STORE_ID=<SEU_STORE_ID>
NUVEMSHOP_ACCESS_TOKEN=<SEU_ACCESS_TOKEN>
NUVEMSHOP_API_BASE_URL=https://api.nuvemshop.com.br/v1
NUVEMSHOP_API_VERSION=2025-03

# ... resto das variáveis
```

## 🚀 Endpoints Disponíveis

### 1. Criar Produto

**Endpoint:** `POST /products`

```bash
curl -X POST "https://api.nuvemshop.com.br/v1/<SEU_STORE_ID>/products" \
  -H "Authentication: bearer <SEU_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": { "pt": "Camiseta XL" },
    "description": { "pt": "<p>Camiseta tamanho XL</p>" },
    "variants": [{
      "sku": "TSHIRT-XL",
      "price": "99.90",
      "stock": 100,
      "stock_management": true
    }]
  }'
```

**Resposta (201 Created):**
```json
{
  "id": 1234567,
  "name": { "pt": "Camiseta XL" },
  "variants": [{
    "id": 7654321,
    "sku": "TSHIRT-XL",
    "price": "99.90",
    "stock": 100
  }]
}
```

### 2. Atualizar Produto

**Endpoint:** `PUT /products/{product_id}`

```bash
curl -X PUT "https://api.nuvemshop.com.br/v1/<SEU_STORE_ID>/products/1234567" \
  -H "Authentication: bearer <SEU_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": { "pt": "Camiseta XL - Promoção" },
    "published": true
  }'
```

### 3. Atualizar Estoque (Batch)

**Endpoint:** `PATCH /products/stock-price`

Atualiza até 50 variantes de uma vez (recomendado para performance):

```bash
curl -X PATCH "https://api.nuvemshop.com.br/v1/<SEU_STORE_ID>/products/stock-price" \
  -H "Authentication: bearer <SEU_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "id": 1234567,
      "variants": [{
        "id": 7654321,
        "stock": 150,
        "price": "89.90"
      }]
    }
  ]'
```

### 4. Obter Produto por SKU

**Endpoint:** `GET /products/sku/{sku}`

```bash
curl -X GET "https://api.nuvemshop.com.br/v1/<SEU_STORE_ID>/products/sku/TSHIRT-XL" \
  -H "Authentication: bearer <SEU_ACCESS_TOKEN>"
```

**Resposta (200 OK):**
```json
{
  "id": 1234567,
  "variants": [{
    "id": 7654321,
    "sku": "TSHIRT-XL",
    "stock": 100,
    "price": "99.90"
  }]
}
```

## 📊 Headers Importantes

| Header | Valor | Notas |
|--------|-------|-------|
| `Authentication` | `bearer {token}` | ⚠️ NÃO é "Authorization" |
| `Content-Type` | `application/json` | Obrigatório para POST/PUT/PATCH |
| `Accept-Language` | `pt-BR` | Opcional (padrão pt) |

## ⚠️ Limitações & Quotas

- **Rate Limit:** ~100 requisições/minuto
- **Header de resposta:** `x-rate-limit-remaining` 
- **Batch máximo:** 50 variantes por PATCH
- **Máximo de produtos:** 100.000 por loja
- **Máximo de variantes:** 1.000 por produto

## 🧪 Testes Locais

### Executar Testes com Mocks (sem chamar API real)

```bash
npm test
# Resultado: 48/48 testes passando, nenhuma chamada externa
```

### Testes de Integração Reais (opcional)

```bash
# Define variáveis para chamar API real (usar com cuidado!)
export NUVEMSHOP_TESTING_REAL=true
npm run test:integration
```

## 📁 Estrutura de Arquivos

```
src/
├── app.js                    # Express webhook receiver
├── nuvemshop.js             # Client HTTP para API Nuvemshop
├── nuvemshop-client.js      # NEW: Cliente estruturado da API
├── rateLimiter.js           # Token Bucket rate limiter
├── idempotency.js           # Deduplicação com Redis
├── queue.js                 # BullMQ fila de Jobs
├── worker.js                # Worker que consome fila
└── logger.js                # Winston logger

tests/
├── unit/
│   ├── nuvemshop.test.js    # Testes unitários HTTP
│   ├── rateLimiter.test.js  # Testes do rate limiter
│   └── ...
├── integration/
│   ├── webhook.test.js      # Testes do webhook (app.js)
│   ├── stock-update.test.js # Testes fluxo completo com mocks
│   ├── workerRateLimiter.test.js
│   └── nuvemshop-api.test.js   # NEW: Testes da API estruturada
```

## 🔄 Fluxo de Requisição

```
1. SAP/ERP → Webhook POST /webhook/stock
                    ↓
2. app.js → Valida JSON & enfileira job
                    ↓
3. BullMQ Queue → Armazena job com retry automático
                    ↓
4. worker.js → Processa job:
   a. Valida idempotência (Redis)
   b. Rate Limiter.acquire() → aguarda se necessário
   c. API Nuvemshop (PATCH /products/stock-price)
   d. Atualiza rate-limit do header
                    ↓
5. ✅ Job completado (ou falha → DLQ)
```

## 🛡️ Tratamento de Erros

| Erro | Causa | Ação |
|------|-------|------|
| 401 Unauthorized | Token inválido/expirado | Revalidar credenciais .env |
| 429 Too Many Requests | Rate limit atingido | Rate Limiter enfileira automaticamente |
| 422 Unprocessable Entity | Dados inválidos (ex: stock negativo) | Validar payload antes do envio |
| 5xx Server Errors | API Nuvemshop indisponível | Exponential backoff automático |
| Connection timeout | Rede lenta | Retry com backoff exponencial |

## 📝 Exemplos de Uso

### JavaScript/Node.js

```javascript
// Criar produto
const nuvemshopClient = new NuvemshopClient({
  storeId: process.env.NUVEMSHOP_STORE_ID,
  accessToken: process.env.NUVEMSHOP_ACCESS_TOKEN,
  apiUrl: process.env.NUVEMSHOP_API_BASE_URL
});

const product = await nuvemshopClient.createProduct({
  name: { pt: "Camiseta XL" },
  variants: [{
    sku: "TSHIRT-XL",
    stock: 100,
    price: "99.90"
  }]
});

console.log(`Produto criado: ${product.id}`);

// Atualizar estoque
await nuvemshopClient.updateStockBatch([{
  productId: product.id,
  variants: [{
    variantId: product.variants[0].id,
    stock: 150
  }]
}]);
```

### cURL

```bash
# Variáveis
STORE_ID="<SEU_STORE_ID>"
TOKEN="<SEU_ACCESS_TOKEN>"
BASE_URL="https://api.nuvemshop.com.br/v1"

# Listar produtos
curl -X GET "${BASE_URL}/${STORE_ID}/products?limit=10" \
  -H "Authentication: bearer ${TOKEN}"

# Buscar por SKU
curl -X GET "${BASE_URL}/${STORE_ID}/products/sku/TSHIRT-XL" \
  -H "Authentication: bearer ${TOKEN}"
```

## 🚨 Segurança

⚠️ **Nunca commitar credenciais no Git!**

```bash
# ❌ ERRADO - Nunca faz isso:
git add .env  # ❌ Não!

# ✅ CORRETO:
echo ".env" >> .gitignore
git add .gitignore
```

Use `.env.example` para documentar que variáveis são necessárias:

```env
# .env.example
NUVEMSHOP_STORE_ID=<seu_store_id>
NUVEMSHOP_ACCESS_TOKEN=<seu_access_token>
```

## 📚 Referências

- [API Autenticação](https://tiendanube.github.io/api-documentation/authentication)
- [API Produtos](https://tiendanube.github.io/api-documentation/resources/product)
- [API Variantes](https://tiendanube.github.io/api-documentation/resources/product-variant)
- [Rate Limiting](https://tiendanube.github.io/api-documentation/intro#rate-limiting)

## 🔗 Status da Integração

- ✅ Autenticação Bearer Token
- ✅ Client API estruturado
- ✅ Rate Limiting com Token Bucket
- ✅ Testes unitários com nock
- ✅ Tratamento de erros com retry
- ⏳ HMAC webhook validation (próximo)
- ⏳ Multi-warehouse support (futuro)
