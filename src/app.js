'use strict';

require('dotenv').config();

const express = require('express');
const Redis   = require('ioredis');

const logger                          = require('./logger');
const { createQueue, enqueueStockUpdate } = require('./queue');

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
    logger.info({ msg: 'Webhook enfileirado', jobId: job.id, skuCode: sku_code, stock });
    return res.status(202).json({ jobId: job.id, status: 'queued' });
  } catch (err) {
    logger.error({ msg: 'Erro ao enfileirar', err: err.message, body: req.body });
    return res.status(500).json({ error: 'Erro interno ao enfileirar atualização' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Inicia o servidor apenas se for o entry point (não quando importado para testes)
if (require.main === module) {
  const PORT = parseInt(process.env.PORT || '3000', 10);
  app.listen(PORT, () => logger.info({ msg: 'Webhook receiver iniciado', port: PORT }));
}

module.exports = app;
