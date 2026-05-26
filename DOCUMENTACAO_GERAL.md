# Documentação Geral — Middleware de Estoque SAP → Nuvemshop
**Fashion Corp · pco-nuvemshop · v1.0**

> Este documento serve como guia de apresentação e referência técnica acessível para qualquer pessoa com contexto de negócio, independentemente de formação técnica.

---

## Índice

1. [Visão Geral](#1-visão-geral)
2. [Regras de Negócio](#2-regras-de-negócio)
3. [Guia de Arquitetura — Visão Técnica de Alto Nível](#3-guia-de-arquitetura--visão-técnica-de-alto-nível)
4. [Mapa de Navegação com Links](#4-mapa-de-navegação-com-links)

---

## 1. Visão Geral

### O que é isso?

Imagine que a Fashion Corp tem dois sistemas que precisam conversar entre si:

- O **SAP** é o sistema interno da empresa que sabe exatamente quantas peças existem no estoque — cada vez que um produto entra ou sai do armazém, ele avisa.
- A **Nuvemshop** é a plataforma da loja virtual — é ela que exibe para o cliente quanto tem disponível de cada item.

O problema é que esses dois sistemas falam em velocidades muito diferentes. O SAP pode gritar avisos a uma velocidade de **até 500 por segundo**. A Nuvemshop, por sua vez, só consegue ouvir **2 mensagens por segundo** sem entrar em colapso.

Se tentássemos conectar os dois diretamente, seria como tentar encher um copo com uma mangueira de incêndio — o copo transbordaria e a maioria da água (das atualizações) seria desperdiçada ou causaria dano.

### O que este sistema faz?

Este middleware — que chamamos de **PCO-Nuvemshop** — age como um **intermediário inteligente** entre os dois sistemas:

```
SAP (fala rápido demais)
        ↓
   [PCO-Nuvemshop]   ← este sistema
        ↓
 Nuvemshop (ouve devagar)
```

Ele resolve três problemas ao mesmo tempo:

| Problema | Como o PCO-Nuvemshop resolve |
|---|---|
| O SAP envia mensagens rápido demais | Guarda tudo numa fila e processa no ritmo certo |
| O SAP pode enviar a mesma mensagem várias vezes | Detecta e descarta automaticamente as repetições |
| A Nuvemshop tem um limite de chamadas | Respeita esse limite e aguarda quando necessário |

### Valor que entrega

- ✅ **Estoque sempre atualizado na loja virtual** — sem atrasos perceptíveis ao cliente
- ✅ **Zero perda de atualizações** — mesmo em picos de tráfego, nenhuma mensagem é descartada sem ser processada
- ✅ **Zero risco de banimento** — o sistema nunca viola os limites da Nuvemshop
- ✅ **Visibilidade total** — toda operação gera log rastreável; qualquer falha fica registrada e pode ser investigada
- ✅ **Recuperação automática** — se algo der errado, o sistema tenta de novo sozinho até 5 vezes antes de pedir atenção humana

---

## 2. Regras de Negócio

As regras abaixo descrevem como o sistema se comporta na prática, em linguagem de negócio.

---

### 2.1 — Recebimento de atualizações de estoque

**Gatilho:** O SAP envia uma mensagem sempre que o estoque de um produto muda.

**Dados obrigatórios em cada mensagem:**

| Campo | O que representa |
|---|---|
| `sku_code` | Código único do produto no SAP (ex: `SKU-CAMISETA-P`) |
| `product_id` | Identificador do produto na Nuvemshop |
| `variant_id` | Identificador da variante (ex: tamanho P do produto) |
| `stock` | Nova quantidade em estoque |

**Regra:** Se qualquer um desses campos estiver faltando, a mensagem é rejeitada imediatamente com erro. O SAP deve reenviar a mensagem completa.

**Garantia:** O sistema confirma o recebimento em menos de 1 segundo, independentemente do volume — o processamento acontece em segundo plano.

---

### 2.2 — Deduplicação (proteção contra mensagens repetidas)

**Problema que resolve:** O SAP às vezes envia a mesma informação mais de uma vez (ex: "produto X tem 50 unidades" dito duas vezes em sequência). Sem proteção, isso causaria chamadas desnecessárias à Nuvemshop.

**Como funciona:**
- A cada mensagem processada, o sistema "memoriza" que aquele produto já foi atualizado com aquela quantidade.
- Essa memória dura **5 minutos** (configurável).
- Se a mesma mensagem chegar dentro desse período, ela é silenciosamente descartada.
- Se o estoque mudar (ex: de 50 para 48), a nova mensagem é processada normalmente — só ignora mensagens *idênticas*.

**Regra resumida:** Mesmo estoque + mesmo SKU dentro de 5 minutos = ignorado. Qualquer mudança real = processado.

---

### 2.3 — Controle de velocidade (respeito ao limite da Nuvemshop)

**Limite imposto pela Nuvemshop:** No máximo 500 chamadas acumuladas no "balde" (equivalente a 1 segundo de tráfego pleno), com reposição de 500 chamadas por segundo.

**Como o sistema se comporta:**
- Mantém um contador interno de "fichas disponíveis" (como senhas de banco).
- Cada atualização de estoque consome uma ficha antes de enviar à Nuvemshop.
- Se não houver fichas disponíveis, o sistema aguarda pacientemente até uma ficha ser reposta.
- Após cada resposta da Nuvemshop, o sistema sincroniza seu contador com o valor real informado pela própria Nuvemshop — garantindo precisão máxima.

**Regra:** Nunca é possível sobrecarregar a Nuvemshop. Em picos, as atualizações ficam em fila mas *nenhuma é perdida*.

---

### 2.4 — Retry automático (tentativas em caso de falha)

Se a Nuvemshop retornar um erro, o sistema tenta novamente automaticamente. O comportamento varia pelo tipo de erro:

| Tipo de erro | O que significa | O sistema faz |
|---|---|---|
| **Muitas requisições (429)** | Nuvemshop pediu para aguardar | Espera o tempo indicado e tenta de novo |
| **Erro do servidor (5xx)** | A Nuvemshop teve um problema interno | Aguarda e tenta de novo com espera crescente |
| **Produto não encontrado (404)** | O produto não existe na Nuvemshop | Descarta sem retry — é um dado inválido |
| **Dados inválidos (400/422)** | O payload está malformado | Descarta sem retry — requer correção na origem |
| **Não autorizado (401/403)** | Credenciais inválidas | Descarta e alerta — requer intervenção humana |

**Regra de tentativas:**
- Máximo de **5 tentativas** por atualização.
- O tempo de espera entre tentativas dobra a cada falha (começa em 2 segundos, pode chegar a 64 segundos).
- Após 5 falhas: o job vai para a **Fila de Mortos (DLQ)** — um arquivo separado de falhas que requer análise humana.

---

### 2.5 — Fila de Mortos (DLQ)

**O que é:** Uma "caixa de rejeitos" onde ficam atualizações que o sistema não conseguiu processar após todas as tentativas.

**Regras:**
- Jobs na DLQ **não são descartados automaticamente** — ficam preservados para análise.
- Um alerta é gerado nos logs e no Grafana quando um job entra na DLQ.
- A equipe técnica pode revisar e reprocessar manualmente esses jobs.

**Limiares de alerta:**
- 🟡 **Atenção:** mais de 10 jobs na DLQ
- 🔴 **Crítico:** mais de 100 jobs na DLQ (sistema para de responder com status saudável)

---

### 2.6 — Monitoramento de saúde

O sistema expõe dois endereços de verificação de saúde:

| Endereço | O que informa |
|---|---|
| `GET /health` | Se o servidor está vivo (sim/não) |
| `GET /health/queue` | Estado detalhado da fila de processamento |

**Estados possíveis da fila:**

| Status | O que significa | Ação recomendada |
|---|---|---|
| `healthy` | Tudo operando normalmente | Nenhuma |
| `degraded` | Fila grande ou algumas falhas — monitorar | Investigar se o problema persiste |
| `critical` | Fila travada ou muitas falhas — retorna erro 503 | Intervenção imediata |

---

### 2.7 — Observabilidade e rastreabilidade

- Cada operação gera um log em JSON com campos como `skuCode`, `productId`, `jobId` e `stock`.
- É possível rastrear o caminho completo de qualquer SKU específico.
- Logs são enviados em tempo real para o **Grafana/Loki** (quando configurado), permitindo dashboards e alertas visuais.

---

## 3. Guia de Arquitetura — Visão Técnica de Alto Nível

### 3.1 — Diagrama de Fluxo

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              PCO-Nuvemshop                                       │
│                                                                                  │
│   SAP ERP          Processo 1: Receiver          Processo 2: Worker              │
│  (500 req/s)                                                                     │
│      │                                                                           │
│      │  POST /webhook/stock                                                      │
│      ├──────────────────────► src/app.js                                         │
│      │                          │                                                │
│      │                          │  Valida payload (sku, product, variant, stock) │
│      │                          │  ↓ inválido → HTTP 400 (rejeita)               │
│      │                          │  ↓ válido                                      │
│      │                          │                                                │
│      │                          ├──── Enfileira job ──────────────────────────► Redis │
│      │                          │    (BullMQ, até 5 tentativas,                  │  (BullMQ │
│      │                          │     backoff exponencial)                       │   Streams)│
│      │◄─────────────────────────┤                                                │     │    │
│      │  HTTP 202 { jobId, status: "queued" }                                     │     │    │
│      │  (< 1 segundo)           │                                                │     │    │
│                                                                                  │     ▼    │
│                                                                       src/worker.js ◄────┘  │
│                                                                           │                 │
│                                                                           │  Pega job da fila│
│                                                                           │                 │
│                                                                           ▼                 │
│                                                                    ┌──────────────┐         │
│                                                                    │ Idempotência │         │
│                                                                    │ src/idempotency.js      │
│                                                                    │                │       │
│                                                                    │ SHA-256(sku:stock)      │
│                                                                    │ Redis SETEX (5 min)     │
│                                                                    │                │       │
│                                                                    │ ↓ duplicata → descarta  │
│                                                                    │ ↓ nova → continua       │
│                                                                    └──────┬───────┘         │
│                                                                           │                 │
│                                                                           ▼                 │
│                                                                    ┌──────────────┐         │
│                                                                    │ Rate Limiter │         │
│                                                                    │ src/rateLimiter.js      │
│                                                                    │                │       │
│                                                                    │ Token Bucket   │       │
│                                                                    │ 500 tokens max │       │
│                                                                    │ +500 tokens/s  │       │
│                                                                    │                │       │
│                                                                    │ ↓ sem token → aguarda   │
│                                                                    │ ↓ com token → consome   │
│                                                                    └──────┬───────┘         │
│                                                                           │                 │
│                                                                           ▼                 │
│                                                                    ┌──────────────┐         │
│                                                                    │ Nuvemshop API│         │
│                                                                    │ src/nuvemshop.js        │
│                                                                    │                │       │
│                                                                    │ POST /variants/stock    │
│                                                                    │ Retry 429/5xx  │       │
│                                                                    │ Descarta 4xx   │       │
│                                                                    └──────┬───────┘         │
│                                                                           │                 │
│                                      ┌────────────────────────────────────┤                │
│                                      │                                    │                │
│                                   Sucesso                              Falha (5x)          │
│                                      │                                    │                │
│                              Log + Conclusão                          DLQ (Redis)          │
│                                                                       Alerta no Grafana     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

### 3.2 — Os dois processos independentes

O sistema roda como **dois processos separados** que devem ser iniciados juntos:

```
Terminal 1: npm run dev     → src/app.js    (Receiver: porta 3001)
Terminal 2: npm run worker  → src/worker.js (Worker: processa a fila)
```

O **Redis** é o elo entre eles: o Receiver coloca jobs na fila, o Worker os consome.

---

### 3.3 — Como os módulos se conversam

```
src/app.js
  ├── usa → src/queue.js      (para enfileirar jobs no Redis)
  └── usa → src/logger.js     (para registrar logs)

src/worker.js
  ├── usa → src/idempotency.js   (para verificar duplicatas no Redis)
  ├── usa → src/rateLimiter.js   (para controlar a velocidade de envio)
  ├── usa → src/nuvemshop.js     (para chamar a API da Nuvemshop)
  └── usa → src/logger.js        (para registrar logs)

src/nuvemshop.js
  └── chama → API Nuvemshop (HTTPS externo)

src/idempotency.js
  └── acessa → Redis (cache de hashes)

src/rateLimiter.js
  └── roda em memória (timer interno a cada 100ms)
```

---

### 3.4 — Tecnologias utilizadas

| Tecnologia | Para que serve neste projeto |
|---|---|
| **Node.js 18+** | Plataforma de execução do sistema |
| **Express** | Servidor HTTP que recebe os webhooks do SAP |
| **Redis** | Banco em memória — armazena a fila de jobs e o cache de idempotência |
| **BullMQ** | Biblioteca de filas que roda sobre o Redis (retry, DLQ, concorrência) |
| **Winston** | Biblioteca de logs — gera JSON estruturado |
| **Grafana / Loki** | Plataforma de observabilidade — dashboards e alertas em tempo real |

---

### 3.5 — Ciclo de vida de uma atualização de estoque

```
1. SAP envia:  POST /webhook/stock { sku: "ABC", stock: 50 }
2. Receiver:   Valida campos → Enfileira job (Redis) → Responde 202
3. Worker:     Pega job da fila
4. Idempotência: SHA-256("ABC:50") → já existe? Descarta. Não? Continua.
5. Rate Limiter: Tem token disponível? Sim → Consome. Não → Aguarda.
6. API Call:   POST https://api.nuvemshop.com.br/2025-03/{store}/products/{id}/variants/stock
7. Sucesso:    Atualiza contador do Rate Limiter → Registra log → Job concluído ✅
8. Falha:      Retry com backoff exponencial (até 5x) → DLQ se esgotar 🔴
```

---

## 4. Mapa de Navegação com Links

### 4.1 — Estrutura de pastas

```
pco-nuvemshop/
├── src/                    ← Código-fonte principal
│   ├── app.js              ← Servidor HTTP (ponto de entrada do Receiver)
│   ├── worker.js           ← Processador de fila (ponto de entrada do Worker)
│   ├── queue.js            ← Configuração da fila BullMQ
│   ├── idempotency.js      ← Lógica de deduplicação
│   ├── rateLimiter.js      ← Controle de velocidade (Token Bucket)
│   ├── nuvemshop.js        ← Client HTTP para a API Nuvemshop (usado pelo Worker)
│   ├── nuvemshop-client.js ← Client estruturado alternativo (CRUD completo)
│   └── logger.js           ← Configuração de logs (Winston + Loki)
│
├── tests/                  ← Testes automatizados
│   ├── unit/               ← Testes isolados (sem Redis, sem rede)
│   ├── integration/        ← Testes de fluxo completo (com mocks de API)
│   └── e2e/                ← Testes contra a API real da Nuvemshop
│
├── grafana/                ← Configurações do dashboard Grafana
│   ├── dashboard.json      ← Dashboard importável no Grafana
│   └── alerts.md           ← Documentação dos alertas configurados
│
├── reports/                ← Evidências geradas pelos testes E2E (ignorado pelo git)
├── logs/                   ← Arquivos de log gerados em produção (ignorado pelo git)
│
├── README.md               ← Guia técnico de instalação e uso
├── CLAUDE.md               ← Instruções para o assistente de código (IA)
├── NUVEMSHOP_API_GUIDE.md  ← Referência da API Nuvemshop
├── WEBHOOK_TESTING.md      ← Guia para testar manualmente os webhooks
├── .env.example            ← Modelo de variáveis de ambiente
└── package.json            ← Dependências e scripts npm
```

---

### 4.2 — Arquivos mais importantes

| Arquivo | Papel no sistema | Link |
|---|---|---|
| [`src/app.js`](./src/app.js) | **Porta de entrada.** Servidor HTTP na porta 3001. Recebe `POST /webhook/stock` do SAP, valida o payload e enfileira o job. Também expõe `/health` e `/health/queue`. | [→ ver código](./src/app.js) |
| [`src/worker.js`](./src/worker.js) | **Motor do sistema.** Consome jobs da fila (10 simultâneos), executa a sequência: idempotência → rate limiter → chamada à API. Gerencia retry e DLQ. | [→ ver código](./src/worker.js) |
| [`src/queue.js`](./src/queue.js) | **Configuração da fila.** Define nome, opções de retry (5x, backoff exponencial com base em 2s) e política de limpeza de jobs concluídos (máx 1.000, por 1 hora). | [→ ver código](./src/queue.js) |
| [`src/idempotency.js`](./src/idempotency.js) | **Filtro de duplicatas.** Calcula SHA-256 de `sku_code:stock` e compara com o valor salvo no Redis. Se idêntico dentro da janela de 5 min, descarta. | [→ ver código](./src/idempotency.js) |
| [`src/rateLimiter.js`](./src/rateLimiter.js) | **Governador de velocidade.** Implementa Token Bucket: 500 tokens máx (= 1 s de burst), reposição de 500/segundo. Aceita ajuste dinâmico via header `x-rate-limit-remaining` da Nuvemshop. | [→ ver código](./src/rateLimiter.js) |
| [`src/nuvemshop.js`](./src/nuvemshop.js) | **Integração com Nuvemshop.** Realiza `POST /products/:id/variants/stock`. Trata 429 e 5xx com retry+jitter. Erros 4xx são classificados como não-retriáveis e descartados. | [→ ver código](./src/nuvemshop.js) |
| [`src/nuvemshop-client.js`](./src/nuvemshop-client.js) | **Client Nuvemshop estendido.** Versão mais completa com CRUD de produtos, busca por SKU e atualização em lote (até 50 variantes por chamada via `PATCH /products/stock-price`). | [→ ver código](./src/nuvemshop-client.js) |
| [`src/logger.js`](./src/logger.js) | **Sistema de logs.** Configuração do Winston: saída JSON, arquivos `combined.log` e `error.log`, e envio opcional ao Grafana Loki via HTTP. | [→ ver código](./src/logger.js) |
| [`.env.example`](./.env.example) | **Configuração do ambiente.** Modelo com todas as variáveis necessárias: credenciais Nuvemshop, Redis, rate limit, TTL de idempotência, endereço do Loki. | [→ ver arquivo](./.env.example) |
| [`grafana/dashboard.json`](./grafana/dashboard.json) | **Dashboard Grafana.** Arquivo importável que cria painéis visuais de volume de jobs, DLQ, latência e alertas em tempo real. | [→ ver arquivo](./grafana/dashboard.json) |
| [`grafana/alerts.md`](./grafana/alerts.md) | **Documentação de alertas.** Descreve os alertas configurados no Grafana (DLQ, back-pressure, rate limit 429). | [→ ver arquivo](./grafana/alerts.md) |
| [`tests/unit/`](./tests/unit/) | **Testes unitários.** Cobrem isoladamente: `rateLimiter`, `idempotency`, `nuvemshop`, `nuvemshop-client` e `worker`. Rodam sem Redis nem rede. | [→ ver pasta](./tests/unit/) |
| [`tests/integration/`](./tests/integration/) | **Testes de integração.** Testam o fluxo completo (webhook → fila → worker → API) usando mocks da Nuvemshop com `nock`. | [→ ver pasta](./tests/integration/) |
| [`tests/e2e/`](./tests/e2e/) | **Testes E2E.** Chamam a API real da Nuvemshop. Geram evidências em HTML/JSON em `reports/`. Requerem credenciais reais no `.env`. | [→ ver pasta](./tests/e2e/) |
| [`README.md`](./README.md) | **Guia técnico completo.** Instalação, configuração, endpoints da API, quirks da Nuvemshop, observabilidade e exemplos de queries LogQL. | [→ ver arquivo](./README.md) |
| [`NUVEMSHOP_API_GUIDE.md`](./NUVEMSHOP_API_GUIDE.md) | **Referência da API Nuvemshop.** Endpoints, autenticação, rate limit, exemplos de payload e comportamentos específicos da plataforma. | [→ ver arquivo](./NUVEMSHOP_API_GUIDE.md) |
| [`WEBHOOK_TESTING.md`](./WEBHOOK_TESTING.md) | **Guia de testes manuais.** Instruções para testar os endpoints com `curl` ou Postman, incluindo cenários de erro. | [→ ver arquivo](./WEBHOOK_TESTING.md) |

---

### 4.3 — Endpoints da API (resumo)

| Método | Endpoint | Quem usa | O que faz |
|---|---|---|---|
| `POST` | `/webhook/stock` | SAP ERP | Recebe atualização de estoque; responde 202 imediatamente |
| `GET` | `/health` | Monitoramento | Confirma que o servidor está vivo |
| `GET` | `/health/queue` | Grafana / Uptime monitors | Retorna estado detalhado da fila; HTTP 503 em estado crítico |

---

*Documento gerado em 26/05/2026 · Arquiteto: Claude Code (Anthropic) · Projeto: Fashion Corp / PCO-Nuvemshop*
