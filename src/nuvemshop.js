'use strict';

const logger = require('./logger');

const BASE_URL      = 'https://api.nuvemshop.com.br';
const API_VERSION   = '2025-03';
const USER_AGENT    = 'FashionCorp-Middleware (ti@fashioncorp.com.br)';
const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS  = 64_000;

class NuvemshopApiError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name       = 'NuvemshopApiError';
    this.statusCode = statusCode;
    this.body       = responseBody;
    this.retryable  = statusCode === 429 || statusCode >= 500;
  }
}

class MaxRetriesExceededError extends Error {
  constructor(attempts) {
    super(`Máximo de tentativas atingido (${attempts})`);
    this.name = 'MaxRetriesExceededError';
  }
}

const sleep   = (ms) => new Promise((res) => setTimeout(res, ms));
const jitter  = ()   => Math.floor(Math.random() * 500);

function computeDelay(attempt, rateLimitResetMs) {
  if (rateLimitResetMs > 0) return Math.min(rateLimitResetMs + jitter(), MAX_DELAY_MS);
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt) + jitter(), MAX_DELAY_MS);
}

async function updateVariantStock({ storeId, productId, variantId, stock, accessToken, skuCode }) {
  const url = `${BASE_URL}/${API_VERSION}/${storeId}/products/${productId}/variants/${variantId}`;
  const ctx = { skuCode, productId, variantId, stock };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    logger.info({ msg: 'Enviando atualização de estoque', attempt, ...ctx });

    let res;
    try {
      res = await fetch(url, {
        method:  'PUT',
        headers: {
          authentication: `bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent':   USER_AGENT,
        },
        body: JSON.stringify({ stock, stock_management: true }),
      });
    } catch (networkErr) {
      logger.error({ msg: 'Falha de rede', err: networkErr.message, attempt, ...ctx });
      if (attempt >= MAX_RETRIES) throw networkErr;
      await sleep(computeDelay(attempt, 0));
      continue;
    }

    const rateLimitRemaining = parseInt(res.headers.get('x-rate-limit-remaining') ?? '-1', 10);
    const rateLimitResetMs   = parseInt(res.headers.get('x-rate-limit-reset')     ?? '0',  10);

    logger.debug({ msg: 'Resposta Nuvemshop', status: res.status, rateLimitRemaining, rateLimitResetMs, attempt, ...ctx });

    if (res.ok) {
      const data = await res.json();
      logger.info({ msg: 'Estoque atualizado com sucesso', newStock: data.stock, ...ctx });
      return {
        data,
        headers: {
          rateLimitRemaining,
          rateLimitResetMs,
        },
      };
    }

    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) break;
      const delay = computeDelay(attempt, rateLimitResetMs);
      logger.warn({ msg: 'Rate limit (429), aguardando', delay, attempt, ...ctx });
      await sleep(delay);
      continue;
    }

    if (res.status >= 500) {
      if (attempt >= MAX_RETRIES) break;
      const delay = computeDelay(attempt, 0);
      logger.warn({ msg: 'Erro servidor, retentando', status: res.status, delay, attempt, ...ctx });
      await sleep(delay);
      continue;
    }

    const body = await res.text();
    logger.error({ msg: 'Erro não-retentável', status: res.status, body, ...ctx });
    throw new NuvemshopApiError(`Erro ${res.status}`, res.status, body);
  }

  throw new MaxRetriesExceededError(MAX_RETRIES + 1);
}

module.exports = { updateVariantStock, NuvemshopApiError, MaxRetriesExceededError, computeDelay, sleep };
