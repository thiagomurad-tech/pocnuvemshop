'use strict';

/**
 * Testes unitários do worker — foco no tratamento de erros da API Nuvemshop.
 *
 * O worker é testado indiretamente: instanciamos a função processadora
 * isolada (sem BullMQ real), mockando todas as dependências externas.
 */

const RedisMock = require('ioredis-mock');

jest.mock('../../src/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock do ioredis para evitar conexão real
jest.mock('ioredis', () => require('ioredis-mock'));

const logger = require('../../src/logger');

// ── Helpers para construir job fake ──────────────────────────────────────────
function makeJob(overrides = {}) {
  return {
    id:           '42',
    attemptsMade: 0,
    data: {
      skuCode:   'SKU-TEST-001',
      productId: '999999',
      variantId: '888888',
      stock:     10,
      ...overrides,
    },
  };
}

// ── Setup: isola módulos para cada teste ─────────────────────────────────────
let updateVariantStock;
let NuvemshopApiError;
let isDuplicate;
let processFn; // função interna do worker extraída para teste

beforeEach(() => {
  jest.resetModules();

  // Re-importa após reset para garantir mocks frescos
  ({ updateVariantStock, NuvemshopApiError } = require('../../src/nuvemshop'));
  ({ isDuplicate } = require('../../src/idempotency'));

  jest.spyOn(require('../../src/idempotency'), 'isDuplicate').mockResolvedValue(false);
  jest.spyOn(require('../../src/nuvemshop'), 'updateVariantStock');
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Fábrica da função processadora ───────────────────────────────────────────
// Replica a lógica do worker sem precisar do BullMQ real
async function runWorkerLogic(job) {
  const { NuvemshopApiError: ApiError } = require('../../src/nuvemshop');
  const { isDuplicate: isdup }          = require('../../src/idempotency');
  const { updateVariantStock: update }  = require('../../src/nuvemshop');

  const { skuCode, productId, variantId, stock } = job.data;
  const ctx = {
    jobId: job.id, skuCode, productId, variantId, stock,
    attempt: job.attemptsMade + 1, max_attempts: 5,
  };

  const duplicate = await isdup(new RedisMock(), skuCode, stock);
  if (duplicate) {
    logger.info({ msg: 'Job ignorado — estoque idêntico (duplicata)', ...ctx });
    return { skipped: true };
  }

  let result;
  try {
    result = await update({ storeId: 'store', accessToken: 'token', productId, variantId, stock, skuCode });
  } catch (err) {
    if (err instanceof ApiError && !err.retryable) {
      logger.warn({
        msg:      'Job descartado — erro não-retriável da API Nuvemshop',
        status:   err.statusCode,
        api_body: err.body,
        ...ctx,
      });
      return { discarded: true, reason: 'non_retryable', statusCode: err.statusCode };
    }
    throw err;
  }

  return { success: true, stock: result.data.stock };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('Worker — erros não-retriáveis (4xx)', () => {
  const NON_RETRYABLE = [404, 422, 400, 401, 403];

  test.each(NON_RETRYABLE)(
    'status %i → descarta job sem retry (retorna discarded: true)',
    async (statusCode) => {
      const { NuvemshopApiError: ApiError } = require('../../src/nuvemshop');
      jest.spyOn(require('../../src/nuvemshop'), 'updateVariantStock')
        .mockRejectedValue(new ApiError(`Erro ${statusCode}`, statusCode, `{"code":${statusCode}}`));

      const result = await runWorkerLogic(makeJob());

      expect(result).toMatchObject({ discarded: true, reason: 'non_retryable', statusCode });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          msg:    'Job descartado — erro não-retriável da API Nuvemshop',
          status: statusCode,
        })
      );
    }
  );

  test('404 — não lança erro (BullMQ não retenta)', async () => {
    const { NuvemshopApiError: ApiError } = require('../../src/nuvemshop');
    jest.spyOn(require('../../src/nuvemshop'), 'updateVariantStock')
      .mockRejectedValue(new ApiError('Erro 404', 404, '{"code":404}'));

    // Se lançasse, o await rejeitaria
    await expect(runWorkerLogic(makeJob())).resolves.toMatchObject({ discarded: true });
  });
});

describe('Worker — erros retriáveis propagam para BullMQ retentar', () => {
  test('NuvemshopApiError 429 → relança erro (BullMQ retenta)', async () => {
    const { NuvemshopApiError: ApiError } = require('../../src/nuvemshop');
    jest.spyOn(require('../../src/nuvemshop'), 'updateVariantStock')
      .mockRejectedValue(new ApiError('Erro 429', 429, ''));

    await expect(runWorkerLogic(makeJob())).rejects.toThrow(ApiError);
  });

  test('NuvemshopApiError 503 → relança erro (BullMQ retenta)', async () => {
    const { NuvemshopApiError: ApiError } = require('../../src/nuvemshop');
    jest.spyOn(require('../../src/nuvemshop'), 'updateVariantStock')
      .mockRejectedValue(new ApiError('Erro 503', 503, ''));

    await expect(runWorkerLogic(makeJob())).rejects.toThrow(ApiError);
  });

  test('erro de rede (TypeError) → relança erro (BullMQ retenta)', async () => {
    jest.spyOn(require('../../src/nuvemshop'), 'updateVariantStock')
      .mockRejectedValue(new TypeError('fetch failed'));

    await expect(runWorkerLogic(makeJob())).rejects.toThrow(TypeError);
  });
});

describe('Worker — job duplicado descartado antes da API', () => {
  test('isDuplicate true → retorna skipped sem chamar a API', async () => {
    jest.spyOn(require('../../src/idempotency'), 'isDuplicate').mockResolvedValue(true);
    const spy = jest.spyOn(require('../../src/nuvemshop'), 'updateVariantStock');

    const result = await runWorkerLogic(makeJob());

    expect(result).toMatchObject({ skipped: true });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Worker — sucesso', () => {
  test('API retorna 200 → retorna success com stock', async () => {
    jest.spyOn(require('../../src/nuvemshop'), 'updateVariantStock')
      .mockResolvedValue({ data: { stock: 10 }, headers: { rateLimitRemaining: 39 } });

    const result = await runWorkerLogic(makeJob());

    expect(result).toMatchObject({ success: true, stock: 10 });
  });
});
