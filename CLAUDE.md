# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

Stock-sync middleware: SAP ERP sends up to 500 webhook req/s → this service absorbs peaks, deduplicates, and forwards to the EcommerceAPI respecting its rate limit (~500 req/s).

## Commands

```bash
# Start webhook receiver (port 3001)
npm run dev          # with hot reload (nodemon)
npm start            # production

# Start queue worker (separate process)
npm run worker

# Tests
npm test                    # all tests (unit + integration), runs in serial
npm run test:unit           # unit tests only (no Redis, no network)
npm run test:integration    # integration tests (nock mocks EcommerceAPI)

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
              └─► src/worker.js    Consumes queue — checks idempotency → rate limiter → EcommerceAPI
                    └─► DLQ        Failed jobs after 5 attempts (BullMQ native, removeOnFail: false)
```

### Key modules

| File | Responsibility |
|------|----------------|
| `src/app.js` | Express server, `POST /webhook/stock` endpoint, enqueues jobs |
| `src/worker.js` | BullMQ Worker (concurrency=10), orchestrates idempotency + rate limiting + API call |
| `src/queue.js` | BullMQ Queue factory; jobs retry up to 5× with exponential backoff (2s base) |
| `src/ecommerce-api.js` | Low-level HTTP client — `POST /products/:id/variants/stock` per variant; used by the worker |
| `src/ecommerce-client.js` | Higher-level structured client — supports `PATCH /products/stock-price` (batch up to 50 variants), list/create/update/delete products |
| `src/rateLimiter.js` | Token Bucket — 500 tokens max (= 1 s burst), refills at 500/s (30000/min); dynamically adjusts from `x-rate-limit-remaining` response header |
| `src/idempotency.js` | Redis SETEX — stores SHA-256(`sku_code:stock`) under key `idem:{sku_code}`, TTL from `IDEMPOTENCY_TTL_SECONDS` |
| `src/logger.js` | Winston — JSON output, writes to `logs/combined.log` and `logs/error.log` |

### Two API clients (important distinction)

- **`ecommerce-api.js`** (`updateVariantStock`): used by the live worker. Makes individual `POST` calls per variant, handles 429/5xx with exponential backoff + jitter. Auth header is `authentication: bearer <token>` (lowercase, not `Authorization`).
- **`ecommerce-client.js`** (`EcommerceClient` class): newer, more complete client with CRUD for products and batch stock/price updates via `PATCH /products/stock-price`. Not yet wired into the worker — currently used in tests and future integrations.

### Rate limiting flow

The `TokenBucketRateLimiter` runs inside the worker process:
1. `worker.js` calls `rateLimiter.acquire()` before each API call — if no tokens, the promise queues and waits.
2. After each successful API response, `rateLimiter.adjustCapacityFromHeader(x-rate-limit-remaining)` syncs the in-memory bucket with the server's actual state.
3. Destroy the rate limiter on `SIGTERM`/`SIGINT` to drain the wait queue cleanly.

## Environment variables

```dotenv
STORE_ID=123456
ACCESS_TOKEN=your_access_token_here
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3001
LOG_LEVEL=info                  # debug | info | warn | error
IDEMPOTENCY_TTL_SECONDS=300     # dedup window (5 min default)
RATE_LIMIT_MAX_TOKENS=500       # token bucket capacity (burst = 1 s @ 500 req/s)
RATE_LIMIT_REFILL_RATE=30000    # tokens refilled per minute (30000/60 = 500 req/s)
API_BASE_URL=https://api.ecommerce.example.com   # used by EcommerceClient
API_VERSION=v1
```

## Testing approach

- **Unit tests** (`tests/unit/`): mock Redis with `ioredis-mock`, mock HTTP with `nock`. No live services needed.
- **Integration tests** (`tests/integration/`): use `supertest` for the Express app and `nock` to intercept EcommerceAPI calls. By default no real API calls are made.
- To run against the real EcommerceAPI: set `E2E_TESTING_REAL=true` and configure `TEST_PRODUCT_ID`/`TEST_VARIANT_ID` in `.env`.
- All tests run `--runInBand` (serial) — required because BullMQ workers and Redis connections don't parallelize cleanly in Jest.

## EcommerceAPI quirks

- Auth header is `Authentication: bearer <token>` — **not** `Authorization`.
- Rate limit headers: `x-rate-limit-remaining` and `x-rate-limit-reset` (ms until bucket refills).
- Batch endpoint: `PATCH /products/stock-price` — max 50 variants per request.
- Stock update endpoint: `POST /{api_version}/{store_id}/products/{product_id}/variants/stock`.
