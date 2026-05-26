# Alertas Grafana — pco-nuvemshop

Configuração manual dos alertas no Grafana.  
Caminho: **Alerting → Alert rules → New alert rule**

> **Atenção:** Cole as queries exatamente como estão abaixo — sem barras invertidas (`\`).  
> Os `\|` que aparecem em tabelas Markdown são apenas escapes de formatação e não fazem parte da query.

---

## Alerta 1 — DLQ (crítico)

> Dispara imediatamente quando qualquer job vai para a Dead Letter Queue.

| Campo | Valor |
|-------|-------|
| **Name** | `[pco-nuvemshop] DLQ — job sem solução` |
| **Datasource** | Loki |
| **Evaluate every** | `1m` |
| **For** | `0m` (dispara imediatamente) |
| **Severity** | `critical` |
| **Summary** | `Jobs indo para DLQ no pco-nuvemshop` |
| **Description** | `Jobs falharam nos últimos 5 minutos. Verificar painel DLQ no Grafana.` |

**Query (A) — colar no editor Loki:**
```
count_over_time({service="pco-nuvemshop", level="error"} | json | alert="DLQ" [5m])
```

**Condition:**
```
WHEN last() OF A IS ABOVE 0
```

---

## Alerta 2 — Rate limit recorrente (warning)

> Dispara quando a Nuvemshop retorna 429 mais de 10 vezes em 10 minutos.

| Campo | Valor |
|-------|-------|
| **Name** | `[pco-nuvemshop] Rate limit 429 recorrente` |
| **Datasource** | Loki |
| **Evaluate every** | `2m` |
| **For** | `2m` |
| **Severity** | `warning` |
| **Summary** | `Rate limit 429 recorrente no pco-nuvemshop` |
| **Description** | `Muitas respostas 429 nos últimos 10 minutos. Considerar reduzir RATE_LIMIT_REFILL_RATE.` |

**Query (A) — colar no editor Loki:**
```
count_over_time({service="pco-nuvemshop", level="warn"} | json | msg="Rate limit atingido (429)" [10m])
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
| **Name** | `[pco-nuvemshop] Back-pressure ativo` |
| **Datasource** | Loki |
| **Evaluate every** | `1m` |
| **For** | `2m` |
| **Severity** | `warning` |
| **Summary** | `Back-pressure ativo no rate limiter do pco-nuvemshop` |
| **Description** | `Fila interna do rate limiter com eventos nos últimos 5 min. Workers processando mais rápido do que o bucket permite.` |

**Query (A) — colar no editor Loki:**
```
count_over_time({service="pco-nuvemshop"} | json | msg="Rate limiter com fila de espera — back-pressure ativo" [5m])
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
| **Name** | `[pco-nuvemshop] Jobs descartados por erro 4xx` |
| **Datasource** | Loki |
| **Evaluate every** | `5m` |
| **For** | `0m` |
| **Severity** | `warning` |
| **Summary** | `Jobs descartados por produto/variante inválido` |
| **Description** | `Jobs descartados por erro 4xx da Nuvemshop (produto ou variante inexistente). Verificar sincronização de cadastro SAP ↔ Nuvemshop.` |

**Query (A) — colar no editor Loki:**
```
count_over_time({service="pco-nuvemshop"} | json | msg="Job descartado — erro não-retriável da API Nuvemshop" [15m])
```

**Condition:**
```
WHEN last() OF A IS ABOVE 3
```

---

## Queries de referência (para explorar no Grafana → Explore)

```logql
# Todos os logs
{service="pco-nuvemshop"} | json

# Apenas DLQ
{service="pco-nuvemshop", level="error"} | json | alert="DLQ"

# Apenas 429
{service="pco-nuvemshop", level="warn"} | json | msg="Rate limit atingido (429)"

# Apenas back-pressure
{service="pco-nuvemshop"} | json | msg="Rate limiter com fila de espera — back-pressure ativo"

# Jobs descartados (4xx)
{service="pco-nuvemshop"} | json | msg="Job descartado — erro não-retriável da API Nuvemshop"

# Por SKU específico
{service="pco-nuvemshop"} | json | skuCode="SKU-POSTMAN-001"
```

---

## Contact point recomendado

Configure em **Alerting → Contact points** um destino (e-mail, Slack, PagerDuty) e vincule aos alertas acima via **Notification policies**.

Sugestão de política:
- `severity=critical` → notificar imediatamente (e-mail + Slack)
- `severity=warning`  → notificar em horário comercial (e-mail)
