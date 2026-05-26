# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

Stock-sync middleware for Fashion Corp: SAP ERP sends up to 500 webhook req/s → this service absorbs peaks, deduplicates, and forwards to the Nuvemshop API respecting its rate limit (~500 req/s).

## Commands

```bash
# Start webhook receiver (port 3001)
npm run dev          # with hot reload (nodemon)
npm start            # production

# Start queue worker (separate process)
npm run workergit 

# Tests
npm test                    # all tests (unit + integration), runs in serial
npm run test:unit           # unit tests only (no Redis, no network)
npm run test:integration    # integration tests (nock mocks Nuvemshop API)

# Run a single test file
npx jest tests/unit/rateLimiter.test.js --runInBand

# Run tests matching a pattern
npm test -- --testPathPattern="webhook"
```

**Prerequisites:** Redis must be running locally (`brew services start redis` on macOS).

## Architecture

The system runs as **two separate processes** that must both be started:

```
SAP ERP (500 req/s)
  └─► src/app.js          Express webhook receiver — validates payload, enqueues job, responds 202
        └─► Redis (BullMQ Streams)
              └─► src/worker.js    Consumes queue — checks idempotency → rate limiter → Nuvemshop API
                    └─► DLQ        Failed jobs after 5 attempts (BullMQ native, removeOnFail: false)
```

### Key modules

| File | Responsibility |
|------|----------------|
| `src/app.js` | Express server, `POST /webhook/stock` endpoint, enqueues jobs |
| `src/worker.js` | BullMQ Worker (concurrency=10), orchestrates idempotency + rate limiting + API call |
| `src/queue.js` | BullMQ Queue factory; jobs retry up to 5× with exponential backoff (2s base) |
| `src/nuvemshop.js` | Low-level HTTP client — `PUT /products/:id/variants/:id` per variant; used by the worker |
| `src/nuvemshop-client.js` | Higher-level structured client — supports `PATCH /products/stock-price` (batch up to 50 variants), list/create/update/delete products |
| `src/rateLimiter.js` | Token Bucket — 100 tokens max, refills at 100/min; dynamically adjusts from `x-rate-limit-remaining` response header |
| `src/idempotency.js` | Redis SETEX — stores SHA-256(`sku_code:stock`) under key `idem:{sku_code}`, TTL from `IDEMPOTENCY_TTL_SECONDS` |
| `src/logger.js` | Winston — JSON output, writes to `logs/combined.log` and `logs/error.log` |

### Two Nuvemshop clients (important distinction)

- **`nuvemshop.js`** (`updateVariantStock`): used by the live worker. Makes individual `PUT` calls per variant, handles 429/5xx with exponential backoff + jitter. Auth header is `authentication: bearer <token>` (lowercase, not `Authorization`).
- **`nuvemshop-client.js`** (`NuvemshopClient` class): newer, more complete client with CRUD for products and batch stock/price updates via `PATCH /products/stock-price`. Not yet wired into the worker — currently used in tests and future integrations.

### Rate limiting flow

The `TokenBucketRateLimiter` runs inside the worker process:
1. `worker.js` calls `rateLimiter.acquire()` before each API call — if no tokens, the promise queues and waits.
2. After each successful API response, `rateLimiter.adjustCapacityFromHeader(x-rate-limit-remaining)` syncs the in-memory bucket with the server's actual state.
3. Destroy the rate limiter on `SIGTERM`/`SIGINT` to drain the wait queue cleanly.

## Environment variables

```dotenv
NUVEMSHOP_STORE_ID=123456
NUVEMSHOP_ACCESS_TOKEN=seu_access_token_aqui
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3001
LOG_LEVEL=info                  # debug | info | warn | error
IDEMPOTENCY_TTL_SECONDS=300     # dedup window (5 min default)
RATE_LIMIT_MAX_TOKENS=100       # token bucket capacity
RATE_LIMIT_REFILL_RATE=100      # tokens refilled per minute
NUVEMSHOP_API_BASE_URL=https://api.nuvemshop.com.br/v1   # used by NuvemshopClient
```

## Testing approach

- **Unit tests** (`tests/unit/`): mock Redis with `ioredis-mock`, mock HTTP with `nock`. No live services needed.
- **Integration tests** (`tests/integration/`): use `supertest` for the Express app and `nock` to intercept Nuvemshop API calls. By default no real API calls are made.
- To run against the real Nuvemshop API: set `NUVEMSHOP_TESTING_REAL=true` and update `PRODUCT_ID`/`VARIANT_ID` constants in `tests/integration/stock-update.test.js`.
- All tests run `--runInBand` (serial) — required because BullMQ workers and Redis connections don't parallelize cleanly in Jest.

## Nuvemshop API quirks

- Auth header is `Authentication: bearer <token>` — **not** `Authorization`.
- Rate limit headers: `x-rate-limit-remaining` and `x-rate-limit-reset` (ms until bucket refills).
- Batch endpoint: `PATCH /products/stock-price` — max 50 variants per request.
- API version in URL path: `https://api.nuvemshop.com.br/2025-03/{store_id}/...` (versioned) vs `https://api.nuvemshop.com.br/v1/{store_id}/...` (used by `NuvemshopClient`).
