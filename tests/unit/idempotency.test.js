'use strict';

const RedisMock = require('ioredis-mock');
const { isDuplicate, computeHash } = require('../../src/idempotency');

jest.mock('../../src/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let redis;
beforeEach(() => { redis = new RedisMock(); });
afterEach(async () => { await redis.flushall(); });

describe('computeHash', () => {
  test('determinístico para mesma entrada', () => {
    expect(computeHash('SKU-001', 42)).toBe(computeHash('SKU-001', 42));
  });
  test('diferente para estoque diferente', () => {
    expect(computeHash('SKU-001', 42)).not.toBe(computeHash('SKU-001', 43));
  });
  test('diferente para SKUs diferentes', () => {
    expect(computeHash('SKU-001', 42)).not.toBe(computeHash('SKU-002', 42));
  });
});

describe('isDuplicate', () => {
  test('retorna false para evento novo', async () => {
    expect(await isDuplicate(redis, 'SKU-001', 42)).toBe(false);
  });
  test('retorna true para evento idêntico', async () => {
    await isDuplicate(redis, 'SKU-001', 42);
    expect(await isDuplicate(redis, 'SKU-001', 42)).toBe(true);
  });
  test('retorna false quando estoque muda (delta real)', async () => {
    await isDuplicate(redis, 'SKU-001', 42);
    expect(await isDuplicate(redis, 'SKU-001', 99)).toBe(false);
  });
  test('SKUs diferentes são independentes', async () => {
    await isDuplicate(redis, 'SKU-001', 42);
    expect(await isDuplicate(redis, 'SKU-002', 42)).toBe(false);
  });
  test('grava TTL correto no Redis', async () => {
    await isDuplicate(redis, 'SKU-001', 42, 120);
    const ttl = await redis.ttl('idem:SKU-001');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });
});
