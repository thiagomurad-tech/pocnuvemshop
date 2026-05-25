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
  maxTokens: parseInt(process.env.RATE_LIMIT_MAX_TOKENS  || '40',  10),
  refillRate: parseInt(process.env.RATE_LIMIT_REFILL_RATE || '120', 10) / 60, // 120/min = 2 req/s
});

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { skuCode, productId, variantId, stock } = job.data;
    const ctx = { jobId: job.id, skuCode, productId, variantId, stock };

    logger.info({ msg: 'Processando job', ...ctx });

    const duplicate = await isDuplicate(redis, skuCode, stock);
    if (duplicate) {
      logger.info({ msg: 'Job ignorado — estoque idêntico', ...ctx });
      return { skipped: true };
    }

    // Aguarda até ter token disponível (respeita rate limit)
    await rateLimiter.acquire();
    logger.debug({
      msg: 'Token disponível, chamando Nuvemshop',
      rateLimiterStatus: rateLimiter.getStatus(),
      ...ctx,
    });

    const result = await updateVariantStock({
      storeId:     process.env.NUVEMSHOP_STORE_ID,
      accessToken: process.env.NUVEMSHOP_ACCESS_TOKEN,
      productId, variantId, stock, skuCode,
    });

    // Ajusta rate limiter baseado na resposta da API
    if (result.headers?.rateLimitRemaining !== undefined) {
      rateLimiter.adjustCapacityFromHeader(result.headers.rateLimitRemaining);
      logger.debug({
        msg: 'Rate limit ajustado pela resposta da API',
        rateLimitRemaining: result.headers.rateLimitRemaining,
        rateLimiterStatus: rateLimiter.getStatus(),
        ...ctx,
      });
    }

    logger.info({ msg: 'Job concluído', newStock: result.data.stock, ...ctx });
    return { success: true, stock: result.data.stock };
  },
  { connection: redis, concurrency: 10 }
);

worker.on('completed', (job, result) =>
  logger.info({ msg: 'Job completado', jobId: job.id, result })
);

worker.on('failed', (job, err) =>
  logger.error({ msg: 'Job na DLQ após todas as tentativas', jobId: job?.id, data: job?.data, attempts: job?.attemptsMade, err: err.message })
);

// Graceful shutdown
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

logger.info({
  msg: 'Worker iniciado',
  concurrency: 10,
  rateLimiter: rateLimiter.getStatus(),
});

module.exports = { worker, rateLimiter };
);

worker.on('error', (err) =>
  logger.error({ msg: 'Erro crítico no worker', err: err.message })
);

logger.info({ msg: 'Worker iniciado', queue: QUEUE_NAME, concurrency: 10 });

module.exports = worker;
