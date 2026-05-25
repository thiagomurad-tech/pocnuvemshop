'use strict';

const request = require('supertest');
const RedisMock = require('ioredis-mock');
const app = require('../../src/app');

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('Webhook Stock Update', () => {
  test('POST /webhook/stock com payload válido retorna 202 Accepted', async () => {
    const payload = {
      sku_code: 'TSHIRT-XL',
      product_id: 'prod-123',
      variant_id: 'var-456',
      stock: 100,
    };

    const res = await request(app)
      .post('/webhook/stock')
      .send(payload)
      .expect(202);

    expect(res.body).toHaveProperty('jobId');
    expect(res.body).toHaveProperty('status', 'queued');
  });

  test('POST /webhook/stock com JSON inválido retorna 400', async () => {
    const res = await request(app)
      .post('/webhook/stock')
      .set('Content-Type', 'application/json')
      .send('{"sku_code": "TEST"}}}') // JSON malformado
      .expect(400);

    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/JSON inválido/i);
  });

  test('POST /webhook/stock sem campos obrigatórios retorna 400', async () => {
    const payload = {
      sku_code: 'TSHIRT-XL',
      // faltam os outros campos
    };

    const res = await request(app)
      .post('/webhook/stock')
      .send(payload)
      .expect(400);

    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/obrigatórios/i);
  });

  test('GET /health retorna status ok', async () => {
    const res = await request(app)
      .get('/health')
      .expect(200);

    expect(res.body).toEqual({ status: 'ok' });
  });

  test('POST /webhook/stock com stock=0 funciona (edge case)', async () => {
    const payload = {
      sku_code: 'TSHIRT-OUT',
      product_id: 'prod-999',
      variant_id: 'var-999',
      stock: 0,
    };

    const res = await request(app)
      .post('/webhook/stock')
      .send(payload)
      .expect(202);

    expect(res.body.status).toBe('queued');
  });

  test('POST /webhook/stock com payload grande funciona', async () => {
    const payload = {
      sku_code: 'TSHIRT-XL',
      product_id: 'prod-123',
      variant_id: 'var-456',
      stock: 100,
      extra_field: 'x'.repeat(1000), // Campo extra com 1000 chars
    };

    const res = await request(app)
      .post('/webhook/stock')
      .send(payload)
      .expect(202);

    expect(res.body.status).toBe('queued');
  });
});
