'use strict';

/**
 * Token Bucket Rate Limiter
 *
 * Controla o throughput de requisições usando o padrão Token Bucket,
 * calibrado para o Leaky Bucket da Nuvemshop:
 *   - Capacidade padrão: 500 requisições (burst = 1 s de throughput)
 *   - Taxa de reposição: 500 req/s (drain rate da API)
 *   - Adapta-se dinamicamente ao header x-rate-limit-remaining
 *
 * Referência: https://tiendanube.github.io/api-documentation/intro#rate-limiting
 */
class TokenBucketRateLimiter {
  /**
   * @param {Object} config
   * @param {number} config.maxTokens     - Capacidade máxima do balde (padrão: 500 — bucket Nuvemshop (= 1 s de throughput))
   * @param {number} config.refillRate    - Tokens adicionados por segundo (padrão: 500 — drain Nuvemshop)
   * @param {number} config.refillInterval - Milissegundos entre refills (padrão: 100ms)
   */
  constructor(config = {}) {
    this.maxTokens = config.maxTokens ?? 500;     // Nuvemshop: bucket = 500 req (1 s de throughput @ 500 req/s)
    this.refillRate = config.refillRate ?? 500;     // Nuvemshop: 500 req/s de drain
    this.refillInterval = config.refillInterval ?? 100; // refill a cada 100ms
    
    this.tokens = this.maxTokens;
    this.lastRefillTime = Date.now();
    this.waitQueue = [];

    // Inicia o timer de refill
    this.startRefillTimer();
  }

  /**
   * Inicia timer que periodicamente refaz os tokens
   */
  startRefillTimer() {
    this.refillTimer = setInterval(() => {
      this.refill();
    }, this.refillInterval);
    this.refillTimer.unref?.(); // Não impede processo de terminar
  }

  /**
   * Para o timer (para cleanup)
   */
  stopRefillTimer() {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
  }

  /**
   * Refaz tokens baseado no tempo decorrido
   */
  refill() {
    const now = Date.now();
    const ellapsedSeconds = (now - this.lastRefillTime) / 1000;
    const tokensToAdd = ellapsedSeconds * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefillTime = now;

    // Processa fila de espera
    this.processWaitQueue();
  }

  /**
   * Processa requisições que estavam aguardando tokens
   */
  processWaitQueue() {
    while (this.waitQueue.length > 0 && this.tokens >= 1) {
      const { resolve } = this.waitQueue.shift();
      this.tokens -= 1;
      resolve();
    }
  }

  /**
   * Adquire um token. Se não houver, aguarda.
   * @returns {Promise<void>}
   */
  acquire() {
    return new Promise((resolve) => {
      if (this.tokens >= 1) {
        this.tokens -= 1;
        resolve();
      } else {
        this.waitQueue.push({ resolve });
      }
    });
  }

  /**
   * Ajusta a capacidade máxima baseado no header x-rate-limit-remaining
   * da resposta da API Nuvemshop
   * @param {number} remainingRequests - Valor do header x-rate-limit-remaining
   */
  adjustCapacityFromHeader(remainingRequests) {
    if (typeof remainingRequests === 'number' && remainingRequests >= 0) {
      this.tokens = Math.min(this.maxTokens, remainingRequests);
    }
  }

  /**
   * Retorna estado atual do rate limiter (para debug/telemetria)
   * @returns {Object}
   */
  getStatus() {
    return {
      tokens: Math.floor(this.tokens * 100) / 100,
      maxTokens: this.maxTokens,
      refillRate: this.refillRate,
      waitingRequests: this.waitQueue.length,
    };
  }

  /**
   * Reset completo (para testes)
   */
  reset() {
    this.tokens = this.maxTokens;
    this.lastRefillTime = Date.now();
    this.waitQueue = [];
  }

  /**
   * Cleanup (deve ser chamado no app.close())
   */
  destroy() {
    this.stopRefillTimer();
    this.waitQueue = [];
  }
}

module.exports = TokenBucketRateLimiter;
