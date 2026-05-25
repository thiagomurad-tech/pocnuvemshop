'use strict';

/**
 * Token Bucket Rate Limiter
 * 
 * Controla o throughput de requisições usando o padrão Token Bucket.
 * - Tokens são adicionados a uma taxa configurável (refillRate)
 * - Cada requisição consome 1 token
 * - Se não há tokens, a requisição aguarda
 * - Adapta-se dinamicamente ao header x-rate-limit-remaining da API
 */
class TokenBucketRateLimiter {
  /**
   * @param {Object} config
   * @param {number} config.maxTokens - Capacidade máxima do balde (burst capacity)
   * @param {number} config.refillRate - Tokens adicionados por segundo
   * @param {number} config.refillInterval - Milissegundos entre refills (padrão: 100ms)
   */
  constructor(config = {}) {
    this.maxTokens = config.maxTokens ?? 100;
    this.refillRate = config.refillRate ?? 100 / 60; // 100 tokens per 60 seconds (Nuvemshop default)
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
