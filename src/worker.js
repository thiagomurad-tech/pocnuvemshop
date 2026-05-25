'use strict';

require('dotenv').config();

const { Worker } = require('bullmq');
const Redis      = require('ioredis');

const logger                        = require('./logger');
const { isDuplicate }               = require('./idempotency');
const { updateVariantStock }        = require('./nuvemshop');
const { QUEUE_NAME }                = require('./queue');
const TokenBucketRateLimiter        = require('./rateLimiter');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
});

// Rate limiter calibrado para o Leaky Bucket real da Nuvemshop:
//   bucket = 40 requisições, drain = 2 req/s
// RATE_LIMIT_REFILL_RATE é em req/min (dividido por 60 para obter req/s)
const rateLimiter = new TokenBucketRateLimiter({
  maxTokens:  parseInt(process.env.RATE_LIMIT_MAX_TOKENS  || '40',  10),
  refillRate: parseInt(process.env.RATE_LIMIT_REFILL_RATE || '120', 10) / 60, // 120/min = 2 req/s
});

const MAX_JOB_ATTEMPTS = 5;

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { skuCode, productId, variantId, stock } = job.data;
    const ctx = {
      jobId:        job.id,
      skuCode,
      productId,
      variantId,
      stock,
      attempt:      job.attemptsMade + 1,
      max_attempts: MAX_JOB_ATTEMPTS,
    };

    const startedAt = Date.now();
    logger.info({ msg: 'Processando job', ...ctx });

    // ── Idempotência ──────────────────────────────────────────────────────────
    const duplicate = await isDuplicate(redis, skuCode, stock);
    if (duplicate) {
      logger.info({ msg: 'Job ignorado — estoque idêntico (duplicata)', ...ctx });
      return { skipped: true };
    }

    // ── Rate limiter ──────────────────────────────────────────────────────────
    const queueDepthBefore = rateLimiter.getStatus().waitingRequests;
    if (queueDepthBefore > 0) {
      logger.warn({
        msg:         'Rate limiter com fila de espera — back-pressure ativo',
        queue_depth: queueDepthBefore,
        tokens:      rateLimiter.getStatus().tokens,
        ...ctx,
      });
    }

    await rateLimiter.acquire();
    logger.debug({
      msg:              'Token adquirido, chamando Nuvemshop',
      rate_limiter:     rateLimiter.getStatus(),
      ...ctx,
    });

    // ── Chamada à API ─────────────────────────────────────────────────────────
    const result = await updateVariantStock({
      storeId:     process.env.NUVEMSHOP_STORE_ID,
      accessToken: process.env.NUVEMSHOP_ACCESS_TOKEN,
      productId, variantId, stock, skuCode,
    });

    // ── Sincroniza rate limiter com header da resposta ────────────────────────
    if (result.headers?.rateLimitRemaining !== undefined) {
      rateLimiter.adjustCapacityFromHeader(result.headers.rateLimitRemaining);
      logger.debug({
        msg:                  'Rate limiter sincronizado com resposta da API',
        rate_limit_remaining: result.headers.rateLimitRemaining,
        rate_limiter:         rateLimiter.getStatus(),
        ...ctx,
      });
    }

    const duration_ms = Date.now() - startedAt;
    logger.info({
      msg:         'Job concluído com sucesso',
      new_stock:   result.data.stock,
      duration_ms,
      ...ctx,
    });

    return { success: true, stock: result.data.stock };
  },
  { connection: redis, concurrency: 10 }
);

// ── Eventos do worker ─────────────────────────────────────────────────────────

worker.on('completed', (job, result) =>
  logger.info({ msg: 'Job completado', jobId: job.id, result })
);

worker.on('failed', (job, err) =>
  logger.error({
    msg:         'Job enviado para DLQ — tentativas esgotadas',
    alert:       'DLQ',                   // campo fixo para filtro em dashboards
    jobId:       job?.id,
    skuCode:     job?.data?.skuCode,
    productId:   job?.data?.productId,
    variantId:   job?.data?.variantId,
    stock:       job?.data?.stock,
    attempts:    job?.attemptsMade,
    max_attempts: MAX_JOB_ATTEMPTS,
    err_message: err.message,
    err_stack:   err.stack,
  })
);

worker.on('error', (err) =>
  logger.error({ msg: 'Erro crítico no worker', err_message: err.message, err_stack: err.stack })
);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGTERM', async () => {
  logger.info({ msg: 'SIGTERM recebido, encerrando worker' });
  rateLimiter.destroy();
  await worker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info({ msg: 'SIGINT recebido, encerrando worker' });
  rateLimiter.destroy();
  await worker.close();
  process.exit(0);
});

// ── Startup ───────────────────────────────────────────────────────────────────

logger.info({
  msg:         'Worker iniciado',
  queue:       QUEUE_NAME,
  concurrency: 10,
  rate_limiter: {
    max_tokens:        rateLimiter.maxTokens,
    refill_rate_per_s: rateLimiter.refillRate,
  },
});

module.exports = { worker, rateLimiter };
