// jest.e2e.config.js — configuração exclusiva para testes E2E reais
// Exige NUVEMSHOP_TESTING_REAL=true (verificado dentro dos próprios testes)

'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch:       ['**/tests/e2e/**/*.e2e.test.js'],
  testTimeout:     60_000,   // chamadas reais à API podem ser lentas
  clearMocks:      false,    // não resetar spies — não usamos mocks aqui
  verbose:         true,
};
