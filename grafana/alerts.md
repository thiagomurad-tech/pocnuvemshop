# Alertas Grafana — ecommerce-webhook-middleware

Configuração manual dos alertas no Grafana.  
Caminho: **Alerting → Alert rules → New alert rule**

> **Atenção:** Cole as queries exatamente como estão abaixo — sem barras invertidas (`\`).  
> Os `\|` que aparecem em tabelas Markdown são apenas escapes de formatação e não fazem parte da query.

---

## Alerta 1 — DLQ (crítico)

> Dispara imediatamente quando qualquer job vai para a Dead Letter Queue.

| Campo | Valor |
|-------|-------|
| **Name** | `[ecommerce-middleware] DLQ — job sem solução` |
| **Datasource** | Loki |
| **Evaluate every** | `1m` |
| **For** | `0m` (dispara imediatamente) |
| **Severity** | `critical` |
| **Summary** | `Jobs indo para DLQ no ecommerce-webhook-middleware` |
| **Description** | `Jobs falharam nos últimos 5 minutos. Verificar painel DLQ no Grafana.` |

**Query (A) — colar no editor Loki:**
```
count_over_time({service="ecommerce-webhook-middleware", level="error"} | json | alert="DLQ" [5m])
```

**Condition:**
```
WHEN last() OF A IS ABOVE 0
```

---

## Alerta 2 — Rate limit recorrente (warning)

> Dispara quando a EcommerceAPI retorna 429 mais de 10 vezes em 10 minutos.

| Campo | Valor |
|-------|-------|
| **Name** | `[ecommerce-middleware] Rate limit 429 recorrente` |
| **Datasource** | Loki |
| **Evaluate every** | `2m` |
| **For** | `2m` |
| **Severity** | `warning` |
| **Summary** | `Rate limit 429 recorrente no ecommerce-webhook-middleware` |
| **Description** | `Muitas respostas 429 nos últimos 10 minutos. Considerar reduzir RATE_LIMIT_REFILL_RATE.` |

**Query (A) — colar no editor Loki:**
```
count_over_time({service="ecommerce-webhook-middleware", level="warn"} | json | msg="EcommerceAPI rate limit atingido (429)" [10m])
```

**Condition:**
```
WHEN last() OF A IS ABOVE 10
```

---

## Alerta 3 — Back-pressure na fila (warning)

> Dispara quando o rate limiter interno está com fila de espera — indica que os workers estão chegando ao limite de vazão.

| Campo | Valor |
|-------|-------|
| **Name** | `[ecommerce-middleware] Back-pressure ativo` |
| **Datasource** | Loki |
| **Evaluate every** | `1m` |
| **For** | `2m` |
| **Severity** | `warning` |
| **Summary** | `Back-pressure ativo no rate limiter do ecommerce-webhook-middleware` |
| **Description** | `Fila interna do rate limiter com eventos nos últimos 5 min. Workers processando mais rápido do que o bucket permite.` |

**Query (A) — colar no editor Loki:**
```
count_over_time({service="ecommerce-webhook-middleware"} | json | msg="Rate limiter com fila de espera — back-pressure ativo" [5m])
```

**Condition:**
```
WHEN last() OF A IS ABOVE 5
```

---

## Alerta 4 — Jobs descartados por 4xx (warning)

> Dispara quando produtos/variantes inexistentes chegam via webhook — indica dados desatualizados no SAP.

| Campo | Valor |
|-------|-------|
| **Name** | `[ecommerce-middleware] Jobs descartados por erro 4xx` |
| **Datasource** | Loki |
| **Evaluate every** | `5m` |
| **For** | `0m` |
| **Severity** | `warning` |
| **Summary** | `Jobs descartados por erro 4xx da EcommerceAPI (produto ou variante inexistente). Verificar sincronização de cadastro SAP ↔ EcommerceAPI.` |
| **Description** | `Jobs descartados por erro 4xx da EcommerceAPI (produto ou variante inexistente). Verificar sincronização de cadastro SAP ↔ EcommerceAPI.` |

**Query (A) — colar no editor Loki:**
```
count_over_time({service="ecommerce-webhook-middleware"} | json | msg="Job descartado — erro não-retriável da EcommerceAPI" [15m])
```

**Condition:**
```
WHEN last() OF A IS ABOVE 3
```

---

## Queries de referência (para explorar no Grafana → Explore)

```logql
# Todos os logs
{service="ecommerce-webhook-middleware"} | json

# Apenas DLQ
{service="ecommerce-webhook-middleware", level="error"} | json | alert="DLQ"

# Apenas 429
{service="ecommerce-webhook-middleware", level="warn"} | json | msg="EcommerceAPI rate limit atingido (429)"

# Apenas back-pressure
{service="ecommerce-webhook-middleware"} | json | msg="Rate limiter com fila de espera — back-pressure ativo"

# Jobs descartados (4xx)
{service="ecommerce-webhook-middleware"} | json | msg="Job descartado — erro não-retriável da EcommerceAPI"

# Por SKU específico
{service="ecommerce-webhook-middleware"} | json | skuCode="SKU-POSTMAN-001"
```

---

## Contact point recomendado

Configure em **Alerting → Contact points** um destino (e-mail, Slack, PagerDuty) e vincule aos alertas acima via **Notification policies**.

Sugestão de política:
- `severity=critical` → notificar imediatamente (e-mail + Slack)
- `severity=warning`  → notificar em horário comercial (e-mail)
