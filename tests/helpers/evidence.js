'use strict';

/**
 * Coletor de evidências para testes E2E.
 *
 * Uso em cada test case:
 *   await evidence.run('C1 - Nome do cenário', async (ctx) => {
 *     ctx.setRequest({ method, url, body });
 *     // ... chama API ...
 *     ctx.setResponse({ status, headers, body });
 *     ctx.pass('assertion que passou');
 *     // erros lançados → ctx.fail() é registrado automaticamente
 *   });
 *
 * No afterAll:
 *   const { jsonPath, htmlPath } = evidence.save({ store_id, api_base_url });
 */

const fs   = require('fs');
const path = require('path');

const scenarios = [];

/**
 * Executa um cenário E2E capturando request, response e assertions para a evidência.
 * Re-lança erros para que o Jest marque o teste como FAIL corretamente.
 */
async function run(name, fn) {
  const startedAt  = Date.now();
  const assertions = [];
  let status       = 'PASS';
  let request      = null;
  let response     = null;
  let thrownError  = null;

  const ctx = {
    setRequest:  (r) => { request  = r; },
    setResponse: (r) => { response = r; },
    pass: (label)    => assertions.push({ label, result: 'PASS' }),
    fail: (label)    => assertions.push({ label, result: 'FAIL' }),
  };

  try {
    await fn(ctx);
  } catch (err) {
    status      = 'FAIL';
    thrownError = err;
    if (!assertions.some(a => a.result === 'FAIL')) {
      assertions.push({ label: err.message, result: 'FAIL' });
    }
  } finally {
    scenarios.push({
      name,
      status,
      duration_ms: Date.now() - startedAt,
      request,
      response,
      assertions,
    });
  }

  if (thrownError) throw thrownError;
}

/**
 * Persiste a evidência em JSON + HTML dentro de reports/.
 * @param {Object} meta  - campos extras: store_id, api_base_url
 * @returns {{ jsonPath, htmlPath }}
 */
function save(meta = {}) {
  const dir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(dir, { recursive: true });

  const passed = scenarios.filter(s => s.status === 'PASS').length;
  const failed = scenarios.filter(s => s.status === 'FAIL').length;

  const output = {
    run_at:      new Date().toISOString(),
    environment: 'nuvemshop_real',
    ...meta,
    summary: { total: scenarios.length, passed, failed },
    scenarios,
  };

  const ts       = output.run_at.replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `evidence-${ts}.json`);
  const htmlPath = path.join(dir, `evidence-${ts}.html`);

  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  fs.writeFileSync(htmlPath, buildHtml(output));

  return { jsonPath, htmlPath };
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function badge(s) {
  const bg = s === 'PASS' ? '#28a745' : '#dc3545';
  return `<span style="background:${bg};color:#fff;padding:2px 10px;border-radius:4px;font-weight:700;font-size:12px">${s}</span>`;
}

function pre(obj) {
  return `<pre style="background:#f8f9fa;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px;margin:6px 0">${
    JSON.stringify(obj, null, 2)
  }</pre>`;
}

function buildHtml(output) {
  const summaryOk = output.summary.failed === 0;

  const rows = output.scenarios.map(s => `
    <tr style="background:${s.status === 'PASS' ? '#d4edda' : '#f8d7da'}">
      <td>${s.name}</td>
      <td>${badge(s.status)}</td>
      <td>${s.duration_ms} ms</td>
      <td><code>${s.request ? `${s.request.method} ${s.request.url}` : '—'}</code></td>
      <td>${s.response?.status ?? '—'}</td>
      <td>${s.assertions.filter(a => a.result === 'PASS').length} / ${s.assertions.length}</td>
    </tr>`).join('');

  const details = output.scenarios.map(s => `
    <div style="margin-bottom:24px;padding:16px;border:1px solid #dee2e6;border-radius:6px">
      <h3 style="margin-top:0">${s.name} ${badge(s.status)}</h3>
      <p style="color:#6c757d;margin:4px 0 12px">Duração: <strong>${s.duration_ms} ms</strong></p>

      <details>
        <summary style="cursor:pointer;font-weight:600">📤 Request</summary>
        ${pre(s.request)}
      </details>

      <details>
        <summary style="cursor:pointer;font-weight:600">📥 Response</summary>
        ${pre(s.response)}
      </details>

      <details open>
        <summary style="cursor:pointer;font-weight:600">✔ Assertions (${s.assertions.length})</summary>
        <ul style="margin:8px 0;padding-left:20px;line-height:2">
          ${s.assertions.map(a =>
            `<li>${a.result === 'PASS' ? '✅' : '❌'} ${a.label}</li>`
          ).join('')}
        </ul>
      </details>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Evidência E2E — Nuvemshop</title>
  <style>
    body  { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1100px;margin:0 auto;padding:24px;color:#212529 }
    h1    { border-bottom:2px solid #dee2e6;padding-bottom:10px }
    table { border-collapse:collapse;width:100%;margin-bottom:28px }
    th,td { border:1px solid #dee2e6;padding:10px 14px;text-align:left;vertical-align:middle }
    th    { background:#f8f9fa;font-weight:600 }
    code  { background:#f1f3f5;padding:1px 5px;border-radius:3px;font-size:13px }
    .meta { display:flex;flex-wrap:wrap;gap:20px;background:#f8f9fa;border:1px solid #dee2e6;border-radius:6px;padding:14px 18px;margin-bottom:24px }
    footer{ margin-top:40px;color:#6c757d;font-size:12px;border-top:1px solid #dee2e6;padding-top:12px }
  </style>
</head>
<body>
  <h1>📋 Evidência de Integração — Nuvemshop API</h1>

  <div class="meta">
    <span>📅 <strong>Data:</strong> ${output.run_at}</span>
    <span>🏪 <strong>Store ID:</strong> ${output.store_id ?? '—'}</span>
    <span>🌐 <strong>API:</strong> ${output.api_base_url ?? '—'}</span>
    <span style="color:${summaryOk ? '#28a745' : '#dc3545'};font-weight:700">
      ${summaryOk ? '✅ TODOS OS CENÁRIOS PASSARAM' : '❌ EXISTEM FALHAS'}
    </span>
    <span>Total: <strong>${output.summary.total}</strong></span>
    <span>Passou: <strong style="color:#28a745">${output.summary.passed}</strong></span>
    <span>Falhou: <strong style="color:#dc3545">${output.summary.failed}</strong></span>
  </div>

  <h2>Resumo</h2>
  <table>
    <thead>
      <tr>
        <th>Cenário</th><th>Status</th><th>Duração</th>
        <th>Endpoint</th><th>HTTP</th><th>Assertions</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <h2>Detalhes por Cenário</h2>
  ${details}

  <footer>Gerado automaticamente · pco-nuvemshop middleware · ${output.run_at}</footer>
</body>
</html>`;
}

module.exports = { run, save };
