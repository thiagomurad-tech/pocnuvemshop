'use strict';

const TokenBucketRateLimiter = require('../../src/rateLimiter');

describe('TokenBucketRateLimiter', () => {
  let limiter;

  beforeEach(() => {
    limiter = new TokenBucketRateLimiter({
      maxTokens: 10,
      refillRate: 10, // 10 tokens/sec
      refillInterval: 50,
    });
  });

  afterEach(() => {
    limiter.destroy();
  });

  describe('initialization', () => {
    test('inicia com maxTokens cheio', () => {
      expect(limiter.getStatus().tokens).toBe(10);
    });

    test('usa valores padrão calibrados para Nuvemshop (bucket=40, drain=2 req/s)', () => {
      const defaultLimiter = new TokenBucketRateLimiter();
      expect(defaultLimiter.maxTokens).toBe(40);   // bucket Nuvemshop
      expect(defaultLimiter.refillRate).toBe(2);    // 2 req/s drain
      defaultLimiter.destroy();
    });
  });

  describe('acquire()', () => {
    test('acquire() imediato quando há tokens', async () => {
      const start = Date.now();
      await limiter.acquire();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
      expect(limiter.getStatus().tokens).toBe(9);
    });

    test('múltiplos acquire() simultâneos consomem tokens', async () => {
      const promises = [
        limiter.acquire(),
        limiter.acquire(),
        limiter.acquire(),
      ];
      await Promise.all(promises);
      expect(limiter.getStatus().tokens).toBe(7);
    });

    test('acquire() aguarda quando sem tokens', async () => {
      // Consome todos os tokens
      for (let i = 0; i < 10; i++) {
        await limiter.acquire();
      }
      expect(limiter.getStatus().tokens).toBe(0);
      expect(limiter.getStatus().waitingRequests).toBe(0);

      // Próximo acquire() entra na fila
      const acquirePromise = limiter.acquire();
      expect(limiter.getStatus().waitingRequests).toBe(1);

      // Aguarda refill e resolve
      const start = Date.now();
      await acquirePromise;
      const elapsed = Date.now() - start;

      // Deve ter esperado pelo menos o tempo de refill (50ms)
      expect(elapsed).toBeGreaterThan(40);
      expect(limiter.getStatus().waitingRequests).toBe(0);
    });

    test('múltiplos acquire() em fila são processados na ordem', async () => {
      // Consome todos tokens
      for (let i = 0; i < 10; i++) {
        await limiter.acquire();
      }

      const results = [];
      const p1 = limiter.acquire().then(() => results.push(1));
      const p2 = limiter.acquire().then(() => results.push(2));
      const p3 = limiter.acquire().then(() => results.push(3));

      // p1, p2, p3 estão na fila
      expect(limiter.getStatus().waitingRequests).toBe(3);

      await Promise.all([p1, p2, p3]);
      expect(results).toEqual([1, 2, 3]);
    });
  });

  describe('refill()', () => {
    test('refill adiciona tokens no intervalo configurado', async () => {
      // Consome todos
      for (let i = 0; i < 10; i++) {
        await limiter.acquire();
      }
      expect(limiter.getStatus().tokens).toBeCloseTo(0, 0.5);

      // Aguarda refill mais longo para garantir múltiplos ciclos
      await new Promise(resolve => setTimeout(resolve, 250));

      // Deve ter refill suficiente (10 tokens/s * 0.25s = 2.5 tokens)
      expect(limiter.getStatus().tokens).toBeGreaterThanOrEqual(2);
      expect(limiter.getStatus().tokens).toBeLessThanOrEqual(10);
    });

    test('refill não ultrapassa maxTokens', async () => {
      expect(limiter.getStatus().tokens).toBe(10);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(limiter.getStatus().tokens).toBe(10); // Capped
    });
  });

  describe('adjustCapacityFromHeader()', () => {
    test('ajusta tokens baseado em x-rate-limit-remaining', () => {
      limiter.adjustCapacityFromHeader(5);
      expect(limiter.getStatus().tokens).toBe(5);
    });

    test('não ultrapassa maxTokens ao ajustar', () => {
      limiter.adjustCapacityFromHeader(1000);
      expect(limiter.getStatus().tokens).toBe(10); // maxTokens
    });

    test('ignora valores negativos', () => {
      limiter.adjustCapacityFromHeader(5);
      limiter.adjustCapacityFromHeader(-1);
      expect(limiter.getStatus().tokens).toBe(5); // Mantém anterior
    });

    test('ignora valores não-numéricos', () => {
      limiter.adjustCapacityFromHeader(5);
      limiter.adjustCapacityFromHeader('invalid');
      expect(limiter.getStatus().tokens).toBe(5); // Mantém anterior
    });
  });

  describe('getStatus()', () => {
    test('retorna estado completo', () => {
      const status = limiter.getStatus();
      expect(status).toEqual({
        tokens: expect.any(Number),
        maxTokens: 10,
        refillRate: 10,
        waitingRequests: 0,
      });
    });

    test('tokens é arredondado para 2 casas decimais', async () => {
      await limiter.acquire();
      const status = limiter.getStatus();
      expect(String(status.tokens).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
    });
  });

  describe('reset()', () => {
    test('reseta para estado inicial', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }
      expect(limiter.getStatus().tokens).toBe(5);

      limiter.reset();
      expect(limiter.getStatus().tokens).toBe(10);
      expect(limiter.getStatus().waitingRequests).toBe(0);
    });
  });

  describe('destroy()', () => {
    test('para o timer de refill', () => {
      const spyStop = jest.spyOn(limiter, 'stopRefillTimer');
      limiter.destroy();
      expect(spyStop).toHaveBeenCalled();
      expect(limiter.refillTimer).toBeNull();
    });

    test('limpa fila de espera', async () => {
      // Consome tokens para encher a fila
      for (let i = 0; i < 10; i++) {
        await limiter.acquire();
      }
      limiter.acquire(); // Entra na fila

      limiter.destroy();
      expect(limiter.waitQueue).toEqual([]);
    });
  });

  describe('cenário real: Nuvemshop rate limit (bucket=40, drain=2 req/s)', () => {
    test('esgota burst de 40 requisições e enfileira a 41ª', async () => {
      const nuvemshopLimiter = new TokenBucketRateLimiter({
        maxTokens: 40,
        refillRate: 2,        // 2 req/s — drain real da Nuvemshop
        refillInterval: 100,
      });

      // Consome burst capacity completo (40 tokens)
      for (let i = 0; i < 40; i++) {
        await nuvemshopLimiter.acquire();
      }
      expect(nuvemshopLimiter.getStatus().tokens).toBeCloseTo(0, 0.5);
      expect(nuvemshopLimiter.getStatus().waitingRequests).toBe(0);

      // 41ª requisição entra em fila (sem tokens disponíveis)
      const nextReq = nuvemshopLimiter.acquire();
      expect(nuvemshopLimiter.getStatus().waitingRequests).toBe(1);

      // Header x-rate-limit-remaining sincroniza o bucket — resolve imediatamente
      nuvemshopLimiter.adjustCapacityFromHeader(20);
      await nextReq;
      expect(nuvemshopLimiter.getStatus().waitingRequests).toBe(0);

      nuvemshopLimiter.destroy();
    });

    test('reposição a 2 req/s após burst esgotado', async () => {
      const nuvemshopLimiter = new TokenBucketRateLimiter({
        maxTokens: 40,
        refillRate: 2,
        refillInterval: 50,
      });

      // Esgota todos os tokens
      for (let i = 0; i < 40; i++) {
        await nuvemshopLimiter.acquire();
      }
      expect(nuvemshopLimiter.getStatus().tokens).toBeCloseTo(0, 0.5);

      // Após 200ms, deve ter reposto ~0.4 tokens (2 req/s × 0.2s)
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(nuvemshopLimiter.getStatus().tokens).toBeGreaterThanOrEqual(0.3);
      expect(nuvemshopLimiter.getStatus().tokens).toBeLessThanOrEqual(40);

      nuvemshopLimiter.destroy();
    });

    test('plano Next/Evolution (10× multiplicador): bucket=400, drain=20 req/s', async () => {
      const nextPlanLimiter = new TokenBucketRateLimiter({
        maxTokens: 400,
        refillRate: 20,       // 20 req/s = 2 req/s × 10×
        refillInterval: 100,
      });

      expect(nextPlanLimiter.maxTokens).toBe(400);
      expect(nextPlanLimiter.refillRate).toBe(20);

      // Consome 100 tokens — bem abaixo do burst de 400
      for (let i = 0; i < 100; i++) {
        await nextPlanLimiter.acquire();
      }
      expect(nextPlanLimiter.getStatus().tokens).toBeGreaterThanOrEqual(0);
      expect(nextPlanLimiter.getStatus().waitingRequests).toBe(0);

      nextPlanLimiter.destroy();
    });
  });
});
