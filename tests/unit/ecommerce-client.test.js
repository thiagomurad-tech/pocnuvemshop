'use strict';

const nock = require('nock');
const EcommerceClient = require('../../src/ecommerce-client');

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('EcommerceClient', () => {
  const STORE_ID = 'test-store-id';
  const TOKEN    = 'test-access-token';
  const API_URL  = 'https://api.ecommerce.example.com/v1';

  let client;

  beforeEach(() => {
    client = new EcommerceClient({
      storeId: STORE_ID,
      accessToken: TOKEN,
      apiBaseUrl: API_URL,
    });
    nock.cleanAll();
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.enableNetConnect();
  });

  test('construtor valida credenciais obrigatórias', () => {
    expect(() => new EcommerceClient({ storeId: '123' })).toThrow('storeId e accessToken são obrigatórios');
    expect(() => new EcommerceClient({ accessToken: 'token' })).toThrow('storeId e accessToken são obrigatórios');
  });

  test('GET /products retorna lista de produtos', async () => {
    nock(`${API_URL}`)
      .get(`/${STORE_ID}/products?limit=10`)
      .reply(200, [
        { id: 1, name: { pt: 'Produto 1' }, variants: [] },
        { id: 2, name: { pt: 'Produto 2' }, variants: [] },
      ], { 'x-rate-limit-remaining': '98' });

    const result = await client.listProducts({ limit: 10 });

    expect(result.products).toHaveLength(2);
    expect(result.products[0].id).toBe(1);
    expect(result.headers.rateLimitRemaining).toBe(98);
  });

  test('GET /products/{id} retorna produto específico', async () => {
    const productId = 1234567;
    nock(`${API_URL}`)
      .get(`/${STORE_ID}/products/${productId}`)
      .reply(200, {
        id: productId,
        name: { pt: 'Camiseta XL' },
        variants: [
          { id: 101, sku: 'TSHIRT-XL', stock: 100, price: '99.90' },
        ],
      }, { 'x-rate-limit-remaining': '97' });

    const result = await client.getProduct(productId);

    expect(result.product.id).toBe(productId);
    expect(result.product.variants[0].sku).toBe('TSHIRT-XL');
  });

  test('GET /products/sku/{sku} busca por SKU', async () => {
    const sku = 'TSHIRT-XL';
    nock(`${API_URL}`)
      .get(`/${STORE_ID}/products/sku/${sku}`)
      .reply(200, {
        id: 1234567,
        name: { pt: 'Camiseta XL' },
        variants: [
          { id: 7654321, sku, stock: 100, price: '99.90' },
        ],
      }, { 'x-rate-limit-remaining': '96' });

    const result = await client.getProductBySku(sku);

    expect(result.product.variants[0].sku).toBe(sku);
  });

  test('POST /products cria novo produto', async () => {
    const productPayload = {
      name: { pt: 'Camiseta Nova' },
      variants: [{ sku: 'NEW-001', price: '99.90', stock: 100 }],
    };

    nock(`${API_URL}`)
      .post(`/${STORE_ID}/products`, productPayload)
      .reply(201, {
        id: 9999999,
        name: { pt: 'Camiseta Nova' },
        variants: [{ id: 8888888, sku: 'NEW-001', stock: 100 }],
      }, { 'x-rate-limit-remaining': '95' });

    const result = await client.createProduct(productPayload);

    expect(result.product.id).toBe(9999999);
    expect(result.product.variants[0].id).toBe(8888888);
  });

  test('PUT /products/{id} atualiza produto', async () => {
    const productId = 1234567;
    const updatePayload = { published: true };

    nock(`${API_URL}`)
      .put(`/${STORE_ID}/products/${productId}`, updatePayload)
      .reply(200, {
        id: productId,
        name: { pt: 'Camiseta XL' },
        published: true,
      }, { 'x-rate-limit-remaining': '94' });

    const result = await client.updateProduct(productId, updatePayload);

    expect(result.product.published).toBe(true);
  });

  test('DELETE /products/{id} remove produto', async () => {
    const productId = 1234567;

    nock(`${API_URL}`)
      .delete(`/${STORE_ID}/products/${productId}`)
      .reply(200, {}, { 'x-rate-limit-remaining': '93' });

    const result = await client.deleteProduct(productId);

    expect(result.success).toBe(true);
  });

  test('PATCH /products/stock-price atualiza estoque em batch', async () => {
    const updates = [
      {
        id: 1234567,
        variants: [
          { id: 7654321, stock: 150, price: '89.90' },
        ],
      },
    ];

    nock(`${API_URL}`)
      .patch(`/${STORE_ID}/products/stock-price`, updates)
      .reply(200, [
        {
          id: 1234567,
          variants: [
            { id: 7654321, success: true },
          ],
        },
      ], { 'x-rate-limit-remaining': '92' });

    const result = await client.updateStockPrice(updates);

    expect(result.updates[0].variants[0].success).toBe(true);
  });

  test('updateVariantStock é wrapper para updateStockPrice', async () => {
    const productId = 1234567;
    const variantId = 7654321;

    nock(`${API_URL}`)
      .patch(`/${STORE_ID}/products/stock-price`)
      .reply(200, [
        {
          id: productId,
          variants: [{ id: variantId, success: true }],
        },
      ], { 'x-rate-limit-remaining': '91' });

    const result = await client.updateVariantStock(productId, variantId, 200, '79.90');

    expect(result.updates[0].variants[0].success).toBe(true);
  });

  test('429 rate limit é reportado no erro', async () => {
    const productId = 1234567;

    nock(`${API_URL}`)
      .get(`/${STORE_ID}/products/${productId}`)
      .reply(429, {}, { 'x-rate-limit-remaining': '0' });

    // Com maxRetries=0, deve falhar imediatamente em 429
    client.maxRetries = 0;

    try {
      await client.getProduct(productId);
      fail('Deveria lançar erro em 429');
    } catch (err) {
      expect(err.message).toContain('limite de requisições');
    }
  });

  test('5xx server error é reportado no erro', async () => {
    const productId = 1234567;

    nock(`${API_URL}`)
      .get(`/${STORE_ID}/products/${productId}`)
      .reply(503, 'Service Unavailable');

    client.maxRetries = 0;

    try {
      await client.getProduct(productId);
      fail('Deveria lançar erro em 5xx');
    } catch (err) {
      expect(err.message).toContain('erro servidor');
    }
  });

  test('4xx client error (exceto 429) não retenta', async () => {
    const productId = 1234567;

    nock(`${API_URL}`)
      .get(`/${STORE_ID}/products/${productId}`)
      .reply(404, { error: 'Product not found' });

    try {
      await client.getProduct(productId);
      fail('Deveria lançar erro');
    } catch (err) {
      expect(err.message).toContain('404');
    }
  });

  test('401 Unauthorized (token inválido) lança imediatamente', async () => {
    nock(`${API_URL}`)
      .get(`/${STORE_ID}/products`)
      .reply(401, { error: 'Invalid token' });

    try {
      await client.listProducts();
      fail('Deveria lançar erro');
    } catch (err) {
      expect(err.message).toContain('401');
    }
  });

  test('updateStockPrice valida máximo de 50 variantes', async () => {
    const updates = [
      {
        id: 1,
        variants: Array.from({ length: 51 }, (_, i) => ({ id: i + 1, stock: 100 })),
      },
    ];

    await expect(client.updateStockPrice(updates)).rejects.toThrow(/máximo 50 variantes/i);
  });

  test('updateStockPrice com múltiplos produtos é permitido', async () => {
    const updates = [
      { id: 1, variants: [{ id: 101, stock: 100 }] },
      { id: 2, variants: [{ id: 201, stock: 200 }] },
    ];

    nock(`${API_URL}`)
      .patch(`/${STORE_ID}/products/stock-price`, updates)
      .reply(200, [], { 'x-rate-limit-remaining': '50' });

    const result = await client.updateStockPrice(updates);

    expect(result.updates).toBeDefined();
  });

  test('construtor lê variáveis de ambiente', () => {
    nock.enableNetConnect(); // Permitir sem nock para este teste

    const prevStore = process.env.STORE_ID;
    const prevToken = process.env.ACCESS_TOKEN;
    const prevUrl = process.env.API_BASE_URL;

    process.env.STORE_ID = 'env-store';
    process.env.ACCESS_TOKEN = 'env-token';
    process.env.API_BASE_URL = 'https://api.env.test/v1';

    const envClient = new EcommerceClient({});

    expect(envClient.storeId).toBe('env-store');
    expect(envClient.accessToken).toBe('env-token');
    expect(envClient.apiBaseUrl).toBe('https://api.env.test/v1');

    // Restaurar valores anteriores
    if (prevStore) process.env.STORE_ID = prevStore;
    else delete process.env.STORE_ID;
    if (prevToken) process.env.ACCESS_TOKEN = prevToken;
    else delete process.env.ACCESS_TOKEN;
    if (prevUrl) process.env.API_BASE_URL = prevUrl;
    else delete process.env.API_BASE_URL;

    nock.disableNetConnect();
  });

  test('_getHeaders inclui authentication e content-type', () => {
    const headers = client._getHeaders();

    expect(headers['Authentication']).toMatch(/^bearer /);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
  });

  test('listProducts filtra por categoria_id', async () => {
    nock(`${API_URL}`)
      .get(`/${STORE_ID}/products?category_id=123&published=true`)
      .reply(200, [], { 'x-rate-limit-remaining': '96' });

    await client.listProducts({ category_id: 123, published: true });
  });

  test('searchBySku é alias para listProducts com q', async () => {
    const sku = 'TSHIRT-XL';

    nock(`${API_URL}`)
      .get(`/${STORE_ID}/products?q=${sku}`)
      .reply(200, [
        { id: 1, variants: [{ sku }] },
      ], { 'x-rate-limit-remaining': '95' });

    const result = await client.searchBySku(sku);

    expect(result.products[0].variants[0].sku).toBe(sku);
  });
});
