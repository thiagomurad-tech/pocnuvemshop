# Alertas Grafana — pco-nuvemshop

Configuração manual dos alertas no Grafana.  
Caminho: **Alerting → Alert rules → New alert rule**

---

## Alerta 1 — DLQ (crítico)

> Dispara imediatamente quando qualquer job vai para a Dead Letter Queue.

| Campo | Valor |
|-------|-------|
| **Name** | `[pco-nuvemshop] DLQ — job sem solução` |
| **Datasource** | Loki |
| **Query (A)** | `count_over_time({service="pco-nuvemshop", level="error"} \| json \| alert="DLQ" [5m])` |
| **Condition** | `WHEN last() OF A IS ABOVE 0` |
| **Evaluate every** | `1m` |
| **For** | `0m` (dispara imediatamente) |
| **Severity** | `critical` |
| **Summary** | `Jobs indo para DLQ no pco-nuvemshop` |
| **Description** | `{{ $values.A.Value }} jobs falharam nos últimos 5 minutos. Verificar logs: {service="pco-nuvemshop", level="error"} \| json \| alert="DLQ"` |

---

## Alerta 2 — Rate limit recorrente (warning)

> Dispara quando a Nuvemshop retorna 429 mais de 10 vezes em 10 minutos.

| Campo | Valor |
|-------|-------|
| **Name** | `[pco-nuvemshop] Rate limit 429 recorrente` |
| **Datasource** | Loki |
| **Query (A)** | `count_over_time({service="pco-nuvemshop", level="warn"} \| json \| msg="Rate limit atingido (429)" [10m])` |
| **Condition** | `WHEN last() OF A IS ABOVE 10` |
| **Evaluate every** | `2m` |
| **For** | `2m` |
| **Severity** | `warning` |
| **Summary** | `Rate limit 429 recorrente no pco-nuvemshop` |
| **Description** | `{{ $values.A.Value }} respostas 429 nos últimos 10 minutos. Considerar reduzir RATE_LIMIT_REFILL_RATE.` |

---

## Alerta 3 — Back-pressure na fila (warning)

> Dispara quando o rate limiter interno está com fila de espera — indica que os workers estão chegando ao limite de vazão.

| Campo | Valor |
|-------|-------|
| **Name** | `[pco-nuvemshop] Back-pressure ativo` |
| **Datasource** | Loki |
| **Query (A)** | `count_over_time({service="pco-nuvemshop"} \| json \| msg="Rate limiter com fila de espera — back-pressure ativo" [5m])` |
| **Condition** | `WHEN last() OF A IS ABOVE 5` |
| **Evaluate every** | `1m` |
| **For** | `2m` |
| **Severity** | `warning` |
| **Summary** | `Back-pressure ativo no rate limiter do pco-nuvemshop` |
| **Description** | `Fila interna do rate limiter com {{ $values.A.Value }} eventos nos últimos 5 min. Workers processando mais rápido do que o bucket permite.` |

---

## Alerta 4 — Jobs descartados por 4xx (warning)

> Dispara quando produtos/variantes inexistentes chegam via webhook — indica dados desatualizados no SAP.

| Campo | Valor |
|-------|-------|
| **Name** | `[pco-nuvemshop] Jobs descartados por erro 4xx` |
| **Datasource** | Loki |
| **Query (A)** | `count_over_time({service="pco-nuvemshop"} \| json \| msg="Job descartado — erro não-retriável da API Nuvemshop" [15m])` |
| **Condition** | `WHEN last() OF A IS ABOVE 3` |
| **Evaluate every** | `5m` |
| **For** | `0m` |
| **Severity** | `warning` |
| **Summary** | `Jobs descartados por produto/variante inválido` |
| **Description** | `{{ $values.A.Value }} jobs descartados nos últimos 15 min por erro 4xx da Nuvemshop (produto ou variante inexistente). Verificar sincronização de cadastro SAP ↔ Nuvemshop.` |

---

## Contact point recomendado

Configure em **Alerting → Contact points** um destino (e-mail, Slack, PagerDuty) e vincule aos alertas acima via **Notification policies**.

Sugestão de política:
- `severity=critical` → notificar imediatamente (e-mail + Slack)
- `severity=warning`  → notificar em horário comercial (e-mail)
