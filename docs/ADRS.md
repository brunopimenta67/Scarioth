# Registros de Decisões Arquiteturais (ADRs) e Contratos de API Verificados

> Consolidado e aprovado no **Gate 0** antes da implementação da Etapa 1.

---

## 1. ADRs e Decisões Técnicas Aprovadas

| ID | Tema | Decisão Aprovada | Justificativa e Trade-off |
| :-: | :--- | :--- | :--- |
| **ADR-01** | Servidor HTTP | **Fastify** | Suporte nativo a TypeScript e `async/await`, validação de schema embutida, integração nativa com Pino e alta performance. |
| **ADR-02** | Acesso ao MongoDB | **Driver oficial (`mongodb`)** | Apenas 1 coleção Time-Series (*append-only*). Evita atrito de ODM (Mongoose) na criação nativa Time-Series e reduz overhead no *Cold Path*. |
| **ADR-03** | WebSocket do Painel | **`ws` puro** | Reutiliza a mesma dependência da ingestão no backend e usa `WebSocket` nativo no navegador sem abstração extra. |
| **ADR-04** | API WebSocket da Kraken | **Kraken WebSocket API v2** | Versão oficial atual com JSON nomeado (`ask`/`bid`) e símbolos padronizados (`BTC/USDT`), substituindo v1 (`XBT/USD` e arrays posicionais). |
| **ADR-05** | Framework de Testes | **Vitest** | Execução rápida e suporte nativo a TypeScript/ESM, com API familiar para quem vem do `JUnit 5`. |
| **ADR-06** | Logs Estruturados | **Pino** (`pino-pretty` só em dev) | Overhead mínimo no *Hot Path* e saída estruturada em JSON (análogo a `SLF4J + Logback` JSON). |
| **ADR-07** | Qualidade e Produção | **Etapa 8 incluída** | Adiciona logs estruturados, *health checks*, *graceful shutdown*, testes e `README.md` completo com limitações financeiras. |
| **AUD-01** | Escopo da Trava Anti-Spam | **Por par + direção** | Chave `lock:arbitrage:<PAIR>:<BUY_EXCHANGE>:<SELL_EXCHANGE>` com `SET NX` + TTL (3s), permitindo detectar inversão imediata de sentido. |
| **AUD-02** | Limiar Mínimo de Spread | **`MIN_SPREAD_PERCENTAGE` via `.env`** | Configurável (ex.: `0.01` para validação/demo e valores maiores como `0.25` para simular cobertura acima de taxas). |
| **AUD-03** | Gatilho da Engine | ***Event-driven* no processo** | Avaliação disparada imediatamente após gravação do tick no Redis, evitando polling ocioso e reduzindo latência. |
| **AUD-04** | Build Front-end (`public/`) | **`esbuild` leve + Tailwind CSS** | Compila TypeScript de navegador separado do `tsconfig.json` do backend Node.js. |
| **AUD-05** | Formato Canônico Interno | **`BTCUSDT`, `ETHUSDT`, `SOLUSDT`** | Padrão único interno no Redis, MongoDB, API e painel; tradução isolada nos conectores de cada exchange. |

---

## 2. Ficha Técnica Verificada das APIs Oficiais

### A. Binance — Spot WebSocket Market Streams
- **Endpoints Base:**
  - `wss://data-stream.binance.vision` *(dedicado a dados públicos de mercado — padrão adotado no `.env`)*
  - `wss://stream.binance.com:9443` *(padrão geral)*
  - `wss://stream.binance.com:443` *(alternativa caso porta 9443 tenha restrição de rede)*
- **Stream Selecionado (Topo do Livro):** `<symbol>@bookTicker` com símbolo em **minúsculas** (`btcusdt@bookTicker`, `ethusdt@bookTicker`, `solusdt@bookTicker`).
- **Assinatura Combinada:** `/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker/solusdt@bookTicker`
- **Payload JSON (Stream Combinado):**
  ```json
  {
    "stream": "btcusdt@bookTicker",
    "data": {
      "u": 400900217,
      "s": "BTCUSDT",
      "b": "60000.00",
      "B": "1.5",
      "a": "60001.00",
      "A": "2.0"
    }
  }
  ```
  - `s`: símbolo (`BTCUSDT`)
  - `b`: melhor bid (**string**)
  - `a`: melhor ask (**string**)
  - `B` / `A`: quantidades no topo do livro (**strings**)
  - `u`: updateId numérico
- **Heartbeat (Ping/Pong):** Servidor envia frame `ping` a cada **20 segundos** e exige frame `pong` com payload idêntico em até **60 segundos**; caso contrário derruba a conexão.
- **Limite de Vida da Conexão:** Máximo de **24 horas** contínuas por conexão (pode enviar `serverShutdown` antes de fechar). Reconexão automática obrigatória.
- **Rate Limits:** Máximo **5 mensagens de entrada por segundo** (pings, pongs e controles), **300 tentativas de conexão a cada 5 minutos por IP** e até **1.024 streams por conexão**.

### B. Kraken — WebSocket API v2
- **Endpoint Público:** `wss://ws.kraken.com/v2`
- **Formato de Símbolos na v2:** Usa barra e `BTC` padrão (não `XBT`): `BTC/USDT`, `ETH/USDT`, `SOL/USDT`.
- **Canal Selecionado:** `ticker` com `event_trigger: "bbo"` (*Best-Bid-Offer*, dispara atualização imediata a cada mudança no melhor bid/ask em vez do padrão `"trades"`) e `snapshot: true`.
- **Payload de Assinatura:**
  ```json
  {
    "method": "subscribe",
    "params": {
      "channel": "ticker",
      "symbol": ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
      "event_trigger": "bbo",
      "snapshot": true
    },
    "req_id": 1
  }
  ```
- **Payload JSON de Resposta (`snapshot` / `update`):**
  ```json
  {
    "channel": "ticker",
    "type": "snapshot",
    "data": [
      {
        "symbol": "BTC/USDT",
        "bid": 91234.5,
        "bid_qty": 0.45,
        "ask": 91235.0,
        "ask_qty": 1.20
      }
    ]
  }
  ```
  - Nota: `bid` e `ask` na Kraken v2 chegam como **números** (diferente da Binance, que envia **strings**).
- **Heartbeat / Ping:** A Kraken envia `{ "channel": "heartbeat" }` aproximadamente **1 vez por segundo** quando não há outras mensagens no fluxo, e aceita ping JSON explícito (`{ "method": "ping" }` -> `{ "method": "pong" }`).
- **Rate Limits:** Conexões públicas devem usar backoff exponencial em reconexões para evitar proteção anti-DDoS / ban temporário por IP.
