'use strict';

const logger = require('./logger');

/**
 * Cliente estruturado para API Nuvemshop
 *
 * Gerencia autenticação, rate limiting e requisições da API
 * com tratamento de erros robusto.
 */
class NuvemshopClient {
  /**
   * @param {Object} config - Configuração do cliente
   * @param {string} config.storeId - ID da loja (ex: 123456)
   * @param {string} config.accessToken - Token de acesso Bearer
   * @param {string} config.apiBaseUrl - URL base da API (ex: https://api.nuvemshop.com.br/2025-03)
   * @param {number} config.maxRetries - Máx tentativas (padrão: 5)
   * @param {number} config.retryDelayMs - Atraso inicial em ms (padrão: 1000)
   */
  constructor(config) {
    this.storeId = config.storeId || process.env.NUVEMSHOP_STORE_ID;
    this.accessToken = config.accessToken || process.env.NUVEMSHOP_ACCESS_TOKEN;
    this.apiBaseUrl = config.apiBaseUrl || process.env.NUVEMSHOP_API_BASE_URL || 'https://api.nuvemshop.com.br/2025-03';
    this.maxRetries = config.maxRetries || 5;
    this.retryDelayMs = config.retryDelayMs || 1000;

    if (!this.storeId || !this.accessToken) {
      throw new Error('NuvemshopClient: storeId e accessToken são obrigatórios');
    }

    this.baseUrl = `${this.apiBaseUrl}/${this.storeId}`;
    this.ctx = { storeId: this.storeId };
  }

  /**
   * Construir headers padrão para requisições
   */
  _getHeaders(additional = {}) {
    return {
      'Authentication': `bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...additional,
    };
  }

  /**
   * Calcular delay exponencial com jitter
   */
  _computeDelay(attempt) {
    const baseDelay = this.retryDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 1000; // ±500ms
    return baseDelay + jitter - 500;
  }

  /**
   * Fazer requisição com retry automático
   */
  async _request(method, endpoint, body = null) {
    const fullUrl = `${this.baseUrl}${endpoint}`;
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const options = {
          method,
          headers: this._getHeaders(),
        };

        if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
          options.body = JSON.stringify(body);
        } else if (body && method === 'GET') {
          // Parâmetros query como objeto no body GET (edge case)
          // Normalmente não usamos
        }

        logger.debug({
          msg: 'Nuvemshop API request',
          method,
          endpoint,
          attempt,
          ...this.ctx,
        });

        const response = await fetch(fullUrl, options);

        // Extrair headers de rate limit
        const rateLimitRemaining = parseInt(response.headers.get('x-rate-limit-remaining') ?? '-1', 10);
        const rateLimitResetMs = parseInt(response.headers.get('x-rate-limit-reset') ?? '-1', 10);

        // 429: Rate limit
        if (response.status === 429) {
          if (attempt >= this.maxRetries) {
            logger.error({
              msg: 'Nuvemshop rate limit máximo atingido',
              endpoint,
              status: response.status,
              ...this.ctx,
            });
            throw new Error('Nuvemshop: limite de requisições atingido após múltiplas tentativas');
          }

          const delay = this._computeDelay(attempt);
          logger.warn({
            msg: 'Nuvemshop rate limit (429), retentando',
            endpoint,
            delay,
            attempt,
            rateLimitRemaining,
            ...this.ctx,
          });

          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // 5xx: Erro servidor
        if (response.status >= 500) {
          if (attempt >= this.maxRetries) {
            logger.error({
              msg: 'Nuvemshop servidor erro máximo atingido',
              endpoint,
              status: response.status,
              ...this.ctx,
            });
            throw new Error(`Nuvemshop: erro servidor ${response.status} após múltiplas tentativas`);
          }

          const delay = this._computeDelay(attempt);
          logger.warn({
            msg: 'Nuvemshop servidor erro (5xx), retentando',
            endpoint,
            status: response.status,
            delay,
            attempt,
            ...this.ctx,
          });

          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // 4xx (exceto 429): Erro cliente - não retenta
        if (response.status >= 400 && response.status < 500) {
          const errorBody = await response.text();
          logger.error({
            msg: 'Nuvemshop erro cliente (4xx)',
            endpoint,
            status: response.status,
            error: errorBody,
            ...this.ctx,
          });

          const clientErr = new Error(`Nuvemshop: ${response.status} - ${errorBody.substring(0, 200)}`);
          clientErr.statusCode = response.status;
          clientErr.isClientError = true;
          throw clientErr;
        }

        // 2xx e 3xx: Sucesso
        const responseBody = response.status === 204 ? null : await response.json();

        logger.debug({
          msg: 'Nuvemshop API sucesso',
          endpoint,
          status: response.status,
          rateLimitRemaining,
          ...this.ctx,
        });

        return {
          status: response.status,
          data: responseBody,
          headers: {
            rateLimitRemaining,
            rateLimitResetMs,
          },
        };
      } catch (err) {
        // Erros de cliente (4xx) não devem ser retentados
        if (err.isClientError) throw err;

        lastError = err;

        // Erros de rede ou parse — tenta retry
        if (attempt < this.maxRetries) {
          const delay = this._computeDelay(attempt);
          logger.warn({
            msg: 'Nuvemshop erro rede, retentando',
            error: err.message,
            delay,
            attempt,
            ...this.ctx,
          });

          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
    }

    // Esgotou tentativas
    logger.error({
      msg: 'Nuvemshop máximo de tentativas atingido',
      endpoint,
      error: lastError.message,
      ...this.ctx,
    });

    throw lastError || new Error('Nuvemshop: erro desconhecido');
  }

  /**
   * GET /products
   * Listar produtos com filtros opcionais
   */
  async listProducts(filters = {}) {
    const params = new URLSearchParams();
    if (filters.limit) params.append('limit', filters.limit);
    if (filters.page) params.append('page', filters.page);
    if (filters.q) params.append('q', filters.q);
    if (filters.category_id) params.append('category_id', filters.category_id);
    if (filters.published !== undefined) params.append('published', filters.published);

    const queryString = params.toString() ? `?${params.toString()}` : '';
    const result = await this._request('GET', `/products${queryString}`);

    return {
      products: result.data || [],
      headers: result.headers,
    };
  }

  /**
   * GET /products/{id}
   * Obter produto por ID
   */
  async getProduct(productId) {
    const result = await this._request('GET', `/products/${productId}`);
    return {
      product: result.data,
      headers: result.headers,
    };
  }

  /**
   * GET /products/sku/{sku}
   * Obter produto por SKU (procura em variantes)
   */
  async getProductBySku(sku) {
    const result = await this._request('GET', `/products/sku/${sku}`);
    return {
      product: result.data,
      headers: result.headers,
    };
  }

  /**
   * POST /products
   * Criar novo produto
   */
  async createProduct(productData) {
    const result = await this._request('POST', '/products', productData);
    return {
      product: result.data,
      headers: result.headers,
    };
  }

  /**
   * PUT /products/{id}
   * Atualizar produto
   */
  async updateProduct(productId, productData) {
    const result = await this._request('PUT', `/products/${productId}`, productData);
    return {
      product: result.data,
      headers: result.headers,
    };
  }

  /**
   * DELETE /products/{id}
   * Deletar produto
   */
  async deleteProduct(productId) {
    const result = await this._request('DELETE', `/products/${productId}`);
    return {
      success: result.status === 200,
      headers: result.headers,
    };
  }

  /**
   * PATCH /products/stock-price
   * Atualizar estoque e preço em batch (até 50 variantes)
   *
   * @param {Array} updates - Array de produtos com variantes:
   *   [
   *     {
   *       id: 1234567,
   *       variants: [
   *         { id: 7654321, stock: 100, price: "99.90" }
   *       ]
   *     }
   *   ]
   */
  async updateStockPrice(updates) {
    if (!Array.isArray(updates)) {
      throw new TypeError('updates deve ser um array');
    }

    // Contar total de variantes a atualizar
    const totalVariants = updates.reduce((sum, prod) => sum + (prod.variants?.length || 0), 0);
    if (totalVariants > 50) {
      throw new Error('Nuvemshop: máximo 50 variantes por requisição PATCH');
    }

    const result = await this._request('PATCH', '/products/stock-price', updates);

    return {
      updates: result.data || [],
      headers: result.headers,
    };
  }

  /**
   * Atualizar estoque de uma variante (wrapper convenient)
   */
  async updateVariantStock(productId, variantId, stock, price = null) {
    const update = {
      id: productId,
      variants: [{
        id: variantId,
        stock,
      }],
    };

    if (price !== null) {
      update.variants[0].price = price;
    }

    return this.updateStockPrice([update]);
  }

  /**
   * GET /products?sku={sku} (alternativa a endpoints/sku)
   * Buscar produto usando query de SKU
   */
  async searchBySku(sku) {
    return this.listProducts({ q: sku });
  }
}

module.exports = NuvemshopClient;
