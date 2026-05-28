'use strict';

const logger = require('./logger');

const BASE_URL      = process.env.API_BASE_URL    || 'https://api.ecommerce.example.com';
const API_VERSION   = process.env.API_VERSION     || 'v1';
const USER_AGENT    = 'ERPClient-Middleware';
const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS  = 64_000;

class EcommerceApiError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name       = 'EcommerceApiError';
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
  const url = `${BASE_URL}/${API_VERSION}/${storeId}/products/${productId}/variants/stock`;
  const ctx = { skuCode, productId, variantId, stock, endpoint: url };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    logger.info({ msg: 'Enviando atualização de estoque', attempt, max_retries: MAX_RETRIES, ...ctx });

    let res;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers: {
          authentication: `bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent':   USER_AGENT,
        },
        body: JSON.stringify({ action: 'replace', value: stock, id: variantId }),
      });
    } catch (networkErr) {
      logger.error({
        msg:       'Falha de rede ao chamar EcommerceAPI',
        err:       networkErr.message,
        err_stack: networkErr.stack,
        attempt,
        max_retries: MAX_RETRIES,
        ...ctx,
      });
      if (attempt >= MAX_RETRIES) throw networkErr;
      const wait_ms = computeDelay(attempt, 0);
      await sleep(wait_ms);
      continue;
    }

    const rateLimitRemaining = parseInt(res.headers.get('x-rate-limit-remaining') ?? '-1', 10);
    const rateLimitResetMs   = parseInt(res.headers.get('x-rate-limit-reset')     ?? '0',  10);

    logger.debug({
      msg: 'Resposta EcommerceAPI recebida',
      status:               res.status,
      rate_limit_remaining: rateLimitRemaining,
      rate_limit_reset_ms:  rateLimitResetMs,
      attempt,
      ...ctx,
    });

    if (res.ok) {
      const data = await res.json();
      logger.info({
        msg:                  'Estoque atualizado com sucesso',
        new_stock:            data.stock,
        rate_limit_remaining: rateLimitRemaining,
        ...ctx,
      });
      return {
        data,
        headers: { rateLimitRemaining, rateLimitResetMs },
      };
    }

    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) break;
      const wait_ms = computeDelay(attempt, rateLimitResetMs);
      logger.warn({
        msg:                 'EcommerceAPI rate limit atingido (429) — aguardando antes de retentar',
        wait_ms,
        attempt,
        rate_limit_reset_ms: rateLimitResetMs,
        next_attempt:        attempt + 1,
        max_retries:         MAX_RETRIES,
        ...ctx,
      });
      await sleep(wait_ms);
      continue;
    }

    if (res.status >= 500) {
      if (attempt >= MAX_RETRIES) break;
      const wait_ms = computeDelay(attempt, 0);
      logger.warn({
        msg:          'Erro no servidor EcommerceAPI (5xx) — retentando',
        status:       res.status,
        wait_ms,
        attempt,
        next_attempt: attempt + 1,
        max_retries:  MAX_RETRIES,
        ...ctx,
      });
      await sleep(wait_ms);
      continue;
    }

    const body = await res.text();
    logger.error({
      msg:    'Erro não-retentável na EcommerceAPI',
      status: res.status,
      body,
      ...ctx,
    });
    throw new EcommerceApiError(`Erro ${res.status}`, res.status, body);
  }

  logger.error({
    msg:         'Máximo de tentativas atingido — job será enviado para DLQ',
    max_retries: MAX_RETRIES,
    ...ctx,
  });
  throw new MaxRetriesExceededError(MAX_RETRIES + 1);
}

module.exports = { updateVariantStock, EcommerceApiError, MaxRetriesExceededError, computeDelay, sleep };
