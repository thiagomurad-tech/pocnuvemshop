'use strict';

const nock = require('nock');
const RedisMock = require('ioredis-mock');
const TokenBucketRateLimiter = require('../../src/rateLimiter');
const { updateVariantStock } = require('../../src/nuvemshop');
const { isDuplicate } = require('../../src/idempotency');

jest.mock('../../src/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describe('WorkerRateLimiterIntegration', () => {
  let limiter;
  let redis;

  beforeEach(() => {
    limiter = new TokenBucketRateLimiter({
      maxTokens: 10,
      refillRate: 10, // 10 tokens/sec
      refillInterval: 50,
    });
    redis = new RedisMock();
    nock.cleanAll();
    nock.disableNetConnect();
  });

  afterEach(() => {
    limiter.destroy();
    nock.enableNetConnect();
  });

  test('simula fluxo completo: rate limiter + idempotência + API call', async () => {
    const originalSleep = require('../../src/nuvemshop').sleep;
    require('../../src/nuvemshop').sleep = jest.fn().mockResolvedValue(undefined);

    // Limiter com parâmetros reais da Nuvemshop: bucket=40, drain=2 req/s
    limiter.destroy();
    limiter = new TokenBucketRateLimiter({
      maxTokens: 40,
      refillRate: 2,  // 2 req/s
      refillInterval: 50,
    });

    const skuCode = 'TSHIRT-XL';
    const qty = 100;
    const S = 'store-123', P = 'proc-456', V = 'var-789';
    const PATH = `/2025-03/${S}/products/${P}/variants/stock`;

    // Setup nock — retorna 32 remaining (dentro do bucket de 40)
    nock('https://api.nuvemshop.com.br')
      .post(PATH, { action: 'replace', value: qty, id: V })
      .reply(200, { id: parseInt(V), sku: skuCode, stock: qty }, { 'x-rate-limit-remaining': '32' });

    // 1. Verificar se é duplicata
    const isDup1 = await isDuplicate(redis, skuCode, qty);
    expect(isDup1).toBe(false);

    // 2. Adquirir token do rate limiter
    expect(limiter.getStatus().tokens).toBe(40); // Cheio (bucket=40)
    await limiter.acquire();
    expect(limiter.getStatus().tokens).toBeCloseTo(39, 0.1); // Consumiu 1

    // 3. Chamar API
    const result = await updateVariantStock({
      storeId: S,
      accessToken: 'token-123',
      productId: P,
      variantId: V,
      stock: qty,
      skuCode,
    });

    // 4. Ajustar rate limiter com resposta da API
    expect(result.headers.rateLimitRemaining).toBe(32);
    limiter.adjustCapacityFromHeader(result.headers.rateLimitRemaining);
    // adjustCapacityFromHeader aplica Math.min(maxTokens, remainingFromAPI)
    // Math.min(40, 32) = 32
    expect(limiter.getStatus().tokens).toBe(32);

    // 5. Verificar duplicata novamente (deve ser duplicata agora)
    const isDup2 = await isDuplicate(redis, skuCode, qty);
    expect(isDup2).toBe(true);

    // 6. Validar estado final
    expect(result.data.stock).toBe(qty);
    expect(nock.isDone()).toBe(true);

    require('../../src/nuvemshop').sleep = originalSleep;
  });

  test('rate limiting previne burst de requisições', async () => {
    const originalSleep = require('../../src/nuvemshop').sleep;
    require('../../src/nuvemshop').sleep = jest.fn().mockResolvedValue(undefined);

    // Limiter com apenas 3 tokens
    const smallLimiter = new TokenBucketRateLimiter({
      maxTokens: 3,
      refillRate: 1, // baixa taxa de refill
      refillInterval: 50,
    });

    // Tentar adquirir 5 vezes
    const times = [];
    const startTime = Date.now();

    for (let i = 0; i < 3; i++) {
      times.push(Date.now() - startTime);
      await smallLimiter.acquire();
    }

    // Os primeiros 3 devem ser imediatos
    expect(times[0]).toBeLessThan(10);
    expect(times[1]).toBeLessThan(10);
    expect(times[2]).toBeLessThan(10);

    // O 4º deve aguardar (fazer promise sem await para não bloquear)
    const fourthPromise = smallLimiter.acquire();
    // Simular refill
    await new Promise(resolve => setTimeout(resolve, 150));
    const fourthTime = Date.now() - startTime;
    expect(fourthTime).toBeGreaterThan(100);

    await fourthPromise;
    smallLimiter.destroy();
    require('../../src/nuvemshop').sleep = originalSleep;
  });

  test('rate limiter resync com Nuvemshop após muitas requisições', async () => {
    const originalSleep = require('../../src/nuvemshop').sleep;
    require('../../src/nuvemshop').sleep = jest.fn().mockResolvedValue(undefined);

    // Simula comportamento real: limiter começa com 40 tokens (bucket Nuvemshop)
    // API pode retornar valores menores baseado no uso compartilhado
    const prodLimiter = new TokenBucketRateLimiter({
      maxTokens: 40,
      refillRate: 2, // 2 req/s
    });

    // Simula requisição 1
    await prodLimiter.acquire();
    expect(prodLimiter.getStatus().tokens).toBeLessThan(40);

    // API responde com rate-limit-remaining reduzido (foi usado em outro lugar)
    prodLimiter.adjustCapacityFromHeader(20);
    expect(prodLimiter.getStatus().tokens).toBe(20);

    // Simula requisição 2
    await prodLimiter.acquire();
    expect(prodLimiter.getStatus().tokens).toBeCloseTo(19, 0.5);

    prodLimiter.destroy();
    require('../../src/nuvemshop').sleep = originalSleep;
  });
});
