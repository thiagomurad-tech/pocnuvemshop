'use strict';

const nock      = require('nock');
const RedisMock = require('ioredis-mock');
const nuvemshop  = require('../../src/nuvemshop');
const { updateVariantStock }  = nuvemshop;
const { isDuplicate }         = require('../../src/idempotency');

jest.mock('../../src/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

beforeEach(() => { 
  nock.cleanAll();
  nock.disableNetConnect();
});
afterEach(() => { 
  nock.cleanAll();
  nock.enableNetConnect();
  jest.restoreAllMocks();
});

const S = 'test-store', T = 'test-token', P = '1001', V = '2001', SKU = 'TSHIRT-M-RED', QTY = 150;
const PATH  = `/2025-03/${S}/products/${P}/variants/stock`;
const BODY  = { action: 'replace', value: QTY, id: V };

describe('Fluxo de atualização de estoque', () => {
  let redis;
  beforeEach(() => { redis = new RedisMock(); });
  afterEach(async () => { await redis.flushall(); });

  test('evento novo: idempotência passa e API é chamada via POST /variants/stock', async () => {
    nock('https://api.nuvemshop.com.br').post(PATH, BODY)
      .reply(200, { id: parseInt(V), sku: SKU, stock: QTY }, { 'x-rate-limit-remaining': '100' });

    expect(await isDuplicate(redis, SKU, QTY)).toBe(false);
    const result = await updateVariantStock({ storeId: S, accessToken: T, productId: P, variantId: V, stock: QTY, skuCode: SKU });
    expect(result.data.stock).toBe(QTY);
    expect(result.headers.rateLimitRemaining).toBe(100);
    expect(nock.isDone()).toBe(true);
  });

  test('evento duplicado: idempotência barra e API NÃO é chamada', async () => {
    await isDuplicate(redis, SKU, QTY);
    expect(await isDuplicate(redis, SKU, QTY)).toBe(true);
    expect(nock.activeMocks()).toHaveLength(0);
  });

  test('429 → backoff → sucesso na segunda chamada', async () => {
    const originalSleep = nuvemshop.sleep;
    nuvemshop.sleep = jest.fn().mockResolvedValue(undefined);

    nock('https://api.nuvemshop.com.br')
      .post(PATH).reply(429, '', { 'x-rate-limit-reset': '500' })
      .post(PATH).reply(200, { id: parseInt(V), stock: QTY }, { 'x-rate-limit-remaining': '99' });

    expect(await isDuplicate(redis, SKU, QTY)).toBe(false);
    const result = await updateVariantStock({ storeId: S, accessToken: T, productId: P, variantId: V, stock: QTY, skuCode: SKU });
    expect(result.data.stock).toBe(QTY);
    expect(result.headers.rateLimitRemaining).toBe(99);
    expect(nock.isDone()).toBe(true);

    nuvemshop.sleep = originalSleep;
  });

  test('segundo evento com estoque diferente aciona nova chamada à API', async () => {
    nock('https://api.nuvemshop.com.br').post(PATH).reply(200, { id: parseInt(V), stock: 50 }, { 'x-rate-limit-remaining': '100' });
    await isDuplicate(redis, SKU, 50);
    await updateVariantStock({ storeId: S, accessToken: T, productId: P, variantId: V, stock: 50, skuCode: SKU });

    nock('https://api.nuvemshop.com.br').post(PATH).reply(200, { id: parseInt(V), stock: 75 }, { 'x-rate-limit-remaining': '99' });
    expect(await isDuplicate(redis, SKU, 75)).toBe(false);
    const result = await updateVariantStock({ storeId: S, accessToken: T, productId: P, variantId: V, stock: 75, skuCode: SKU });
    expect(result.data.stock).toBe(75);
    expect(result.headers.rateLimitRemaining).toBe(99);
    expect(nock.isDone()).toBe(true);
  });
});
