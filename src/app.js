'use strict';

require('dotenv').config();

const express = require('express');
const Redis   = require('ioredis');

const logger                                        = require('./logger');
const { createQueue, enqueueStockUpdate, QUEUE_NAME } = require('./queue');

const app   = express();
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
});
const queue = createQueue(redis);

// Parse JSON com tratamento de erro customizado
app.use(express.json({ limit: '10mb' }));

// Middleware para capturar erros de parsing JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.warn({ msg: 'JSON inválido recebido', error: err.message, body: req.body });
    return res.status(400).json({ error: 'JSON inválido no body da requisição' });
  }
  next(err);
});

app.post('/webhook/stock', async (req, res) => {
  const { sku_code, product_id, variant_id, stock } = req.body;

  if (!sku_code || !product_id || !variant_id || stock == null) {
    logger.warn({ msg: 'Payload inválido', body: req.body });
    return res.status(400).json({ error: 'Campos obrigatórios: sku_code, product_id, variant_id, stock' });
  }

  try {
    const job = await enqueueStockUpdate(queue, {
      skuCode:   sku_code,
      productId: product_id,
      variantId: variant_id,
      stock:     Number(stock),
    });
    logger.info({
      msg:       'Webhook enfileirado',
      jobId:     job.id,
      skuCode:   sku_code,
      productId: product_id,
      variantId: variant_id,
      stock,
      queue:     'stock-updates',
    });
    return res.status(202).json({ jobId: job.id, status: 'queued' });
  } catch (err) {
    logger.error({
      msg:       'Erro ao enfileirar webhook',
      err:       err.message,
      skuCode:   sku_code,
      productId: product_id,
      variantId: variant_id,
      stock,
    });
    return res.status(500).json({ error: 'Erro interno ao enfileirar atualização' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Thresholds de alerta da fila ──────────────────────────────────────────────
const QUEUE_WARN_WAITING  = 1_000;   // fila crescendo — investigar
const QUEUE_CRIT_WAITING  = 10_000;  // crítico — escalar workers
const QUEUE_WARN_FAILED   = 10;      // jobs na DLQ — revisar erros
const QUEUE_CRIT_FAILED   = 100;     // falha sistêmica

app.get('/health/queue', async (_req, res) => {
  try {
    const counts = await queue.getJobCounts(
      'waiting', 'active', 'delayed', 'failed', 'completed', 'paused'
    );

    // Determina status geral
    let status = 'healthy';
    const alerts = [];

    if (counts.waiting >= QUEUE_CRIT_WAITING) {
      status = 'critical';
      alerts.push(`fila crítica: ${counts.waiting} jobs aguardando (limite: ${QUEUE_CRIT_WAITING})`);
    } else if (counts.waiting >= QUEUE_WARN_WAITING) {
      status = 'degraded';
      alerts.push(`fila elevada: ${counts.waiting} jobs aguardando (limite: ${QUEUE_WARN_WAITING})`);
    }

    if (counts.failed >= QUEUE_CRIT_FAILED) {
      status = 'critical';
      alerts.push(`DLQ crítica: ${counts.failed} jobs com falha (limite: ${QUEUE_CRIT_FAILED})`);
    } else if (counts.failed >= QUEUE_WARN_FAILED) {
      if (status === 'healthy') status = 'degraded';
      alerts.push(`DLQ com falhas: ${counts.failed} jobs (limite: ${QUEUE_WARN_FAILED})`);
    }

    logger.debug({ msg: 'Health da fila consultado', status, counts });

    const httpStatus = status === 'critical' ? 503 : 200;
    return res.status(httpStatus).json({
      status,
      queue: {
        name:      QUEUE_NAME,
        waiting:   counts.waiting,    // enfileirados, aguardando worker
        active:    counts.active,     // sendo processados agora
        delayed:   counts.delayed,    // aguardando retry com backoff
        failed:    counts.failed,     // DLQ — tentativas esgotadas
        completed: counts.completed,  // concluídos recentemente (janela 1h)
        paused:    counts.paused,
      },
      thresholds: {
        waiting:  { warn: QUEUE_WARN_WAITING, critical: QUEUE_CRIT_WAITING },
        failed:   { warn: QUEUE_WARN_FAILED,  critical: QUEUE_CRIT_FAILED  },
      },
      alerts,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ msg: 'Erro ao consultar health da fila', err: err.message });
    return res.status(503).json({ status: 'error', error: err.message });
  }
});

// Inicia o servidor apenas se for o entry point (não quando importado para testes)
if (require.main === module) {
  const PORT = parseInt(process.env.PORT || '3001', 10);
  app.listen(PORT, () => logger.info({ msg: 'Webhook receiver iniciado', port: PORT }));
}

module.exports = app;
