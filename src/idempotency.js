'use strict';

const { createHash } = require('crypto');
const logger = require('./logger');

const DEFAULT_TTL = parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '300', 10);

function computeHash(skuCode, stock) {
  return createHash('sha256').update(`${skuCode}:${stock}`).digest('hex');
}

async function isDuplicate(redis, skuCode, stock, ttl = DEFAULT_TTL) {
  const key      = `idem:${skuCode}`;
  const hash     = computeHash(skuCode, stock);
  const existing = await redis.get(key);

  if (existing === hash) {
    logger.info({ msg: 'Evento duplicado descartado', skuCode, stock });
    return true;
  }

  await redis.setex(key, ttl, hash);
  logger.debug({ msg: 'Hash de idempotência gravado', skuCode, stock, ttl });
  return false;
}

module.exports = { isDuplicate, computeHash };
