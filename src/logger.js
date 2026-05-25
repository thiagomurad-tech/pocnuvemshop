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
 *
 * Note: `message` é preservado como string pois o transport winston-loki
 * o utiliza como texto da linha de log. O campo `msg` carrega o mesmo valor.
 */
const flattenMessage = format((info) => {
  if (info.message !== null && typeof info.message === 'object') {
    const { message, ...rest } = info;
    const flat = { ...rest, ...message };
    // Preserva message como string para compatibilidade com winston-loki
    flat.message = flat.msg || '';
    return flat;
  }
  return info;
});

// Formato base: roda em TODOS os transports (flatten + timestamp)
// Não inclui format.json() aqui — cada transport serializa do seu jeito.
const sharedFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }),
  flattenMessage(),
);

// Formato JSON para Console e File
const jsonFormat = format.combine(sharedFormat, format.json());

const loggerTransports = [
  new transports.Console({ format: jsonFormat }),
  new transports.File({ filename: 'logs/error.log',    level: 'error', format: jsonFormat }),
  new transports.File({ filename: 'logs/combined.log',                 format: jsonFormat }),
];

// ── Loki transport (ativado quando LOKI_HOST estiver definido) ────────────────
if (process.env.LOKI_HOST) {
  try {
    const LokiTransport = require('winston-loki');
    // format.printf garante que o log line enviado ao Loki é JSON puro,
    // sem o prefixo "mensagem {json}" que o modo padrão produz.
    const lokiFormat = format.combine(
      sharedFormat,
      format.printf((info) => {
        // Remove símbolos internos do Winston antes de serializar
        const { [Symbol.for('level')]: _l, [Symbol.for('message')]: _m, ...fields } = info;
        return JSON.stringify(fields);
      }),
    );

    loggerTransports.push(
      new LokiTransport({
        host:     process.env.LOKI_HOST,        // ex: http://localhost:3100
        labels:   {
          service: 'pco-nuvemshop',
          env:     process.env.NODE_ENV || 'development',
        },
        format:           lokiFormat,
        replaceTimestamp: true,
        batching:         false,                // envio imediato (sem buffer)
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
  format:      sharedFormat,             // flatten roda antes de todos os transports
  defaultMeta: { service: 'pco-nuvemshop' },
  transports:  loggerTransports,
});

module.exports = logger;
