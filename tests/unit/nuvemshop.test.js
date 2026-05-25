'use strict';

const nock = require('nock');

jest.mock('../../src/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const nuvemshop = require('../../src/nuvemshop');
const { updateVariantStock, NuvemshopApiError, MaxRetriesExceededError, computeDelay } = nuvemshop;

const BASE = { storeId: '123456', productId: '456', variantId: '789', stock: 42, accessToken: 'test-token', skuCode: 'SKU-001' };

beforeEach(() => { 
  nock.cleanAll(); 
  nock.disableNetConnect();
});
afterEach(() => { 
  nock.enableNetConnect();
  jest.restoreAllMocks();
});

describe('computeDelay', () => {
  test('usa x-rate-limit-reset quando disponível', () => {
    const d = computeDelay(0, 3000);
    expect(d).toBeGreaterThanOrEqual(3000);
    expect(d).toBeLessThanOrEqual(3500);
  });
  test('backoff exponencial sem header', () => {
    expect(computeDelay(0, 0)).toBeGreaterThanOrEqual(1000);
    expect(computeDelay(1, 0)).toBeGreaterThanOrEqual(2000);
    expect(computeDelay(2, 0)).toBeGreaterThanOrEqual(4000);
  });
  test('respeita teto de 64s', () => {
    expect(computeDelay(10, 0)).toBeLessThanOrEqual(64_500);
  });
});

describe('updateVariantStock — sucesso', () => {
  test('chama o endpoint correto e retorna dados da variante', async () => {
    nock('https://api.nuvemshop.com.br')
      .put('/2025-03/123456/products/456/variants/789', { stock: 42, stock_management: true })
      .reply(200, { id: 789, stock: 42, sku: 'SKU-001' }, { 'x-rate-limit-remaining': '100' });
    const result = await updateVariantStock(BASE);
    expect(result.data).toEqual({ id: 789, stock: 42, sku: 'SKU-001' });
    expect(result.headers.rateLimitRemaining).toBe(100);
  });
  test('envia headers obrigatórios', async () => {
    nock('https://api.nuvemshop.com.br')
      .put('/2025-03/123456/products/456/variants/789')
      .matchHeader('authentication', 'bearer test-token')
      .matchHeader('user-agent', /FashionCorp/)
      .matchHeader('content-type', /application\/json/)
      .reply(200, { id: 789, stock: 42 });
    const p = updateVariantStock(BASE);
    await p;
  });
});

describe('updateVariantStock — 429', () => {
  test('retenta após 429 e tem sucesso na segunda chamada', async () => {
    // Mock sleep para testes rodar rápido
    const originalSleep = nuvemshop.sleep;
    nuvemshop.sleep = jest.fn().mockResolvedValue(undefined);

    nock('https://api.nuvemshop.com.br')
      .put('/2025-03/123456/products/456/variants/789').reply(429, '', { 'x-rate-limit-reset': '500' })
      .put('/2025-03/123456/products/456/variants/789').reply(200, { id: 789, stock: 42 }, { 'x-rate-limit-remaining': '99' });
    const p = updateVariantStock(BASE);
    const result = await p;
    expect(result.data.stock).toBe(42);
    expect(result.headers.rateLimitRemaining).toBe(99);
    expect(nock.isDone()).toBe(true);

    nuvemshop.sleep = originalSleep;
  });
  test('lança MaxRetriesExceededError após esgotar tentativas', async () => {
    // Mock sleep para testes rodar rápido
    const originalSleep = nuvemshop.sleep;
    nuvemshop.sleep = jest.fn().mockResolvedValue(undefined);

    nock('https://api.nuvemshop.com.br')
      .put('/2025-03/123456/products/456/variants/789').times(6).reply(429, '', { 'x-rate-limit-reset': '100' });
    const p = updateVariantStock(BASE);
    await expect(p).rejects.toThrow(MaxRetriesExceededError);

    nuvemshop.sleep = originalSleep;
  });
});

describe('updateVariantStock — erros não-retentáveis', () => {
  test('404 lança NuvemshopApiError imediatamente', async () => {
    nock('https://api.nuvemshop.com.br')
      .put('/2025-03/123456/products/456/variants/789').reply(404, '{"error":"not found"}');
    const p = updateVariantStock(BASE);
    await expect(p).rejects.toMatchObject({ statusCode: 404, retryable: false });
  });
});

describe('updateVariantStock — 5xx', () => {
  test('retenta em 503 e tem sucesso na segunda chamada', async () => {
    // Mock sleep para testes rodar rápido
    const originalSleep = nuvemshop.sleep;
    nuvemshop.sleep = jest.fn().mockResolvedValue(undefined);

    nock('https://api.nuvemshop.com.br')
      .put('/2025-03/123456/products/456/variants/789').reply(503)
      .put('/2025-03/123456/products/456/variants/789').reply(200, { id: 789, stock: 42 }, { 'x-rate-limit-remaining': '98' });
    const p = updateVariantStock(BASE);
    const result = await p;
    expect(result.data.stock).toBe(42);
    expect(result.headers.rateLimitRemaining).toBe(98);

    nuvemshop.sleep = originalSleep;
  });
});
