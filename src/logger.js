'use strict';

const { createLogger, format, transports } = require('winston');

/**
 * Flatten message object for Grafana Loki compatibility.
 *
 * Winston wraps object arguments under `message: { ... }` by default:
 *   logger.info({ msg: 'test', jobId: '1' })
 *   → { level: 'info', message: { msg: 'test', jobId: '1' } }
 *
 * Loki LogQL cannot filter on nested fields. This transform flattens them
 * to the top level so queries like `| json | level="warn" | alert="DLQ"`
 * work correctly in Grafana.
 */
const flattenMessage = format((info) => {
  if (info.message !== null && typeof info.message === 'object') {
    const { message, ...rest } = info;
    return { ...rest, ...message };
  }
  return info;
});

const baseFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }),
  flattenMessage(),
  format.json(),
);

const loggerTransports = [
  new transports.Console({ format: baseFormat }),
  new transports.File({ filename: 'logs/error.log',    level: 'error', format: baseFormat }),
  new transports.File({ filename: 'logs/combined.log',               format: baseFormat }),
];

// ── Loki transport (ativado quando LOKI_HOST estiver definido) ────────────────
if (process.env.LOKI_HOST) {
  try {
    const LokiTransport = require('winston-loki');
    loggerTransports.push(
      new LokiTransport({
        host:   process.env.LOKI_HOST,          // ex: http://localhost:3100
        labels: {
          service: 'pco-nuvemshop',
          env:     process.env.NODE_ENV || 'development',
        },
        json:             true,
        replaceTimestamp: true,
        onConnectionError: (err) =>
          console.error(`[Loki] Falha na conexão com ${process.env.LOKI_HOST}: ${err.message}`),
      }),
    );
    console.info(`[Logger] Loki transport ativo → ${process.env.LOKI_HOST}`);
  } catch (err) {
    console.error(`[Logger] Falha ao inicializar Loki transport: ${err.message}`);
  }
}

const logger = createLogger({
  level:       process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'pco-nuvemshop' },
  transports:  loggerTransports,
});

module.exports = logger;
