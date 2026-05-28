'use strict';

/**
 * Testes E2E — Integração real com a EcommerceAPI
 *
 * Pré-requisitos:
 *   - E2E_TESTING_REAL=true
 *   - STORE_ID e ACCESS_TOKEN definidos no .env
 *   - Redis disponível (REDIS_HOST / REDIS_PORT)
 *
 * Execução:
 *   npm run test:e2e
 *
 * Artefatos gerados em reports/:
 *   evidence-<timestamp>.json   (payload + resposta + assertions)
 *   evidence-<timestamp>.html   (relatório visual)
 */

require('dotenv').config();

const EcommerceClient          = require('../../src/ecommerce-client');
const { updateVariantStock }   = require('../../src/ecommerce-api');
const evidence                 = require('../helpers/evidence');

// ── Guarda de segurança ───────────────────────────────────────────────────────
const REAL = process.env.E2E_TESTING_REAL === 'true';

if (!REAL) {
  test.skip('E2E ignorado — defina E2E_TESTING_REAL=true para executar', () => {});
}

// ── Constantes de ambiente ────────────────────────────────────────────────────
const STORE_ID      = process.env.STORE_ID;
const ACCESS_TOKEN  = process.env.ACCESS_TOKEN;
const API_BASE_URL  = process.env.API_BASE_URL || 'https://api.ecommerce.example.com/v1';

// ── Produto fixo (definido em .env — nunca commitado) ─────────────────────────
// Quando TEST_PRODUCT_ID estiver definido, o teste usa o produto existente
// sem criar nem deletar nada. O estoque é restaurado ao valor inicial ao final.
const FIXED_PRODUCT_ID = process.env.TEST_PRODUCT_ID;
const FIXED_VARIANT_ID = process.env.TEST_VARIANT_ID;
const FIXED_SKU        = process.env.TEST_SKU;
const INITIAL_STOCK    = parseInt(process.env.TEST_INITIAL_STOCK || '10', 10);

const USE_FIXED_PRODUCT = Boolean(FIXED_PRODUCT_ID && FIXED_VARIANT_ID && FIXED_SKU);

// ── Estado compartilhado entre os cenários ────────────────────────────────────
let client;
let testProduct;   // { id, variants: [{ id, sku }] }

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  if (!REAL) return;

  client = new EcommerceClient({ storeId: STORE_ID, accessToken: ACCESS_TOKEN });

  if (USE_FIXED_PRODUCT) {
    // Produto fixo configurado em .env — reutiliza sem criar nada
    testProduct = {
      id:       parseInt(FIXED_PRODUCT_ID, 10),
      variants: [{ id: parseInt(FIXED_VARIANT_ID, 10), sku: FIXED_SKU }],
    };
    console.log(`\n📦  Produto fixo: id=${FIXED_PRODUCT_ID} sku=${FIXED_SKU} (estoque inicial esperado: ${INITIAL_STOCK})`);
  } else {
    // Nenhum produto fixo configurado — cria produto temporário para o teste
    const sku = `TEST-E2E-${Date.now()}`;
    const { product } = await client.createProduct({
      name:     { pt: `[TESTE] E2E Middleware ${Date.now()}` },
      variants: [{ sku, price: '1.00', stock: INITIAL_STOCK }],
    });
    testProduct = product;
    console.log(`\n🏗  Produto temporário criado: id=${product.id} sku=${sku}`);
  }
}, 30_000);

// ── Teardown ──────────────────────────────────────────────────────────────────
afterAll(async () => {
  if (!REAL) return;

  if (USE_FIXED_PRODUCT && testProduct?.id) {
    // Produto fixo: restaura o estoque inicial em vez de deletar
    try {
      await updateVariantStock({
        storeId:     STORE_ID,
        accessToken: ACCESS_TOKEN,
        productId:   String(testProduct.id),
        variantId:   String(testProduct.variants[0].id),
        stock:       INITIAL_STOCK,
        skuCode:     testProduct.variants[0].sku,
      });
      console.log(`\n♻️  Estoque restaurado para ${INITIAL_STOCK} — produto fixo preservado: id=${testProduct.id}`);
    } catch (err) {
      console.error(`\n⚠️  Falha ao restaurar estoque: ${err.message}`);
    }
  } else if (testProduct?.id) {
    // Produto temporário: deleta ao final
    try {
      await client.deleteProduct(testProduct.id);
      console.log(`\n🗑  Produto temporário deletado: id=${testProduct.id}`);
    } catch (err) {
      console.error(`\n⚠️  Falha ao deletar produto id=${testProduct.id}: ${err.message}`);
    }
  }

  const { jsonPath, htmlPath } = evidence.save({
    store_id:     STORE_ID,
    api_base_url: API_BASE_URL,
  });

  console.log(`\n📋 Evidência JSON : ${jsonPath}`);
  console.log(`📊 Relatório HTML : ${htmlPath}\n`);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
//  C1 — Atualização de estoque: valor positivo
// ─────────────────────────────────────────────────────────────────────────────
(REAL ? test : test.skip)(
  'C1 — Atualizar estoque para 50 unidades via POST /variants/stock',
  async () => {
    await evidence.run('C1 — Atualizar estoque (50 unidades)', async (ctx) => {
      const stockTarget = 50;
      const productId   = String(testProduct.id);
      const variantId   = String(testProduct.variants[0].id);

      ctx.setRequest({
        method: 'POST',
        url:    `${API_BASE_URL}/${STORE_ID}/products/${productId}/variants/stock`,
        body:   { action: 'replace', value: stockTarget, id: variantId },
      });

      const result = await updateVariantStock({
        storeId: STORE_ID, accessToken: ACCESS_TOKEN,
        productId, variantId,
        stock: stockTarget, skuCode: testProduct.variants[0].sku,
      });

      ctx.setResponse({
        status:  200,
        headers: result.headers,
        body:    result.data,
      });

      // Assertions sobre a resposta da API
      expect(result.data).toBeDefined();
      ctx.pass('POST /variants/stock retornou resposta válida');

      // A resposta do endpoint /variants/stock não retorna o campo stock diretamente;
      // a verificação de persistência é feita via GET abaixo.
      expect(result.headers.rateLimitRemaining).toBeGreaterThanOrEqual(0);
      ctx.pass(`header x-rate-limit-remaining presente (valor: ${result.headers.rateLimitRemaining})`);

      // GET para confirmar persistência no servidor
      const { product: updated } = await client.getProduct(testProduct.id);
      const variant = updated.variants.find(v => String(v.id) === variantId);
      expect(variant.stock).toBe(stockTarget);
      ctx.pass(`GET /products/${productId} confirma stock=${stockTarget} no servidor`);
    });
  },
  30_000,
);

// ─────────────────────────────────────────────────────────────────────────────
//  C2 — Zeragem de estoque
// ─────────────────────────────────────────────────────────────────────────────
(REAL ? test : test.skip)(
  'C2 — Zerar estoque (stock=0)',
  async () => {
    await evidence.run('C2 — Zeragem de estoque (stock=0)', async (ctx) => {
      const productId = String(testProduct.id);
      const variantId = String(testProduct.variants[0].id);

      ctx.setRequest({
        method: 'POST',
        url:    `${API_BASE_URL}/${STORE_ID}/products/${productId}/variants/stock`,
        body:   { action: 'replace', value: 0, id: variantId },
      });

      const result = await updateVariantStock({
        storeId: STORE_ID, accessToken: ACCESS_TOKEN,
        productId, variantId,
        stock: 0, skuCode: testProduct.variants[0].sku,
      });

      ctx.setResponse({ status: 200, headers: result.headers, body: result.data });

      // A resposta do endpoint /variants/stock não retorna o campo stock diretamente;
      // a verificação é feita via GET abaixo.
      expect(result.data).toBeDefined();
      ctx.pass('POST /variants/stock retornou resposta válida');

      const { product: updated } = await client.getProduct(testProduct.id);
      const variant = updated.variants.find(v => String(v.id) === variantId);
      expect(variant.stock).toBe(0);
      ctx.pass(`GET /products/${productId} confirma stock=0 no servidor`);
    });
  },
  30_000,
);

// ─────────────────────────────────────────────────────────────────────────────
//  C3 — Múltiplas atualizações sequenciais (rate limiter não bloqueia)
// ─────────────────────────────────────────────────────────────────────────────
(REAL ? test : test.skip)(
  'C3 — Múltiplas atualizações em sequência sem atingir rate limit',
  async () => {
    await evidence.run('C3 — Múltiplas atualizações sequenciais (5 chamadas)', async (ctx) => {
      const productId = String(testProduct.id);
      const variantId = String(testProduct.variants[0].id);
      const stockValues = [10, 20, 30, 20, 10];
      const results = [];

      ctx.setRequest({
        method: 'POST',
        url:    `${API_BASE_URL}/${STORE_ID}/products/${productId}/variants/stock`,
        body:   { action: 'replace', value: '(variável)', id: variantId },
      });

      for (const stock of stockValues) {
        const result = await updateVariantStock({
          storeId: STORE_ID, accessToken: ACCESS_TOKEN,
          productId, variantId,
          stock, skuCode: testProduct.variants[0].sku,
        });
        results.push({ stock, rateLimitRemaining: result.headers.rateLimitRemaining });
      }

      ctx.setResponse({
        status:  200,
        headers: { note: 'última chamada' },
        body:    results,
      });

      expect(results).toHaveLength(stockValues.length);
      ctx.pass(`${stockValues.length} atualizações concluídas sem erro`);

      const semRateLimit = results.every(r => r.rateLimitRemaining >= 0);
      expect(semRateLimit).toBe(true);
      ctx.pass('header x-rate-limit-remaining presente em todas as respostas');

      const ultimoStock = results[results.length - 1].stock;
      const { product: updated } = await client.getProduct(testProduct.id);
      const variant = updated.variants.find(v => String(v.id) === variantId);
      expect(variant.stock).toBe(ultimoStock);
      ctx.pass(`GET confirma último stock=${ultimoStock} após sequência`);
    });
  },
  60_000, // timeout maior para 5 chamadas
);

// ─────────────────────────────────────────────────────────────────────────────
//  C4 — Lookup de produto por SKU
// ─────────────────────────────────────────────────────────────────────────────
(REAL ? test : test.skip)(
  'C4 — Produto acessível via GET /products/sku/:sku',
  async () => {
    await evidence.run('C4 — Lookup por SKU', async (ctx) => {
      const sku = testProduct.variants[0].sku;

      ctx.setRequest({
        method: 'GET',
        url:    `${API_BASE_URL}/${STORE_ID}/products/sku/${sku}`,
        body:   null,
      });

      const { product } = await client.getProductBySku(sku);

      ctx.setResponse({
        status: 200,
        body:   { id: product?.id, variants_count: product?.variants?.length },
      });

      expect(product).toBeDefined();
      ctx.pass('GET /products/sku/:sku retornou produto');

      expect(String(product.id)).toBe(String(testProduct.id));
      ctx.pass(`produto retornado tem id=${testProduct.id} (correto)`);

      const variant = product.variants.find(v => v.sku === sku);
      expect(variant).toBeDefined();
      ctx.pass(`variante com sku=${sku} encontrada no produto`);
    });
  },
  30_000,
);
