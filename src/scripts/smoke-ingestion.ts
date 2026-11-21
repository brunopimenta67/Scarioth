import { env } from '../config/index.js';
import {
  IngestionManager,
  evaluatePairFreshness,
  isTickStale,
} from '../ingestion/index.js';
import {
  connectRedis,
  disconnectRedis,
  getPairTickers,
  getTickerKey,
  type Redis,
} from '../redis/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runIngestionSmokeTest(): Promise<void> {
  let redisClient: Redis | undefined;
  let ingestion: IngestionManager | undefined;

  console.log('=== Scarioth — Smoke Test de Ingestão WebSocket + Redis (Etapa 3) ===');
  console.log(`Pares monitorados: ${env.MONITORED_PAIRS.join(', ')}`);

  try {
    redisClient = await connectRedis();
    ingestion = new IngestionManager({
      redis: redisClient,
      pairs: env.MONITORED_PAIRS,
      maxTickAgeMs: env.MAX_TICK_AGE_MS,
      binanceWsBaseUrl: env.BINANCE_WS_BASE_URL,
      krakenWsUrl: env.KRAKEN_WS_URL,
    });

    ingestion.start();

    // 1. Aguardar até 20s todos os pares terem cotações frescas de Binance e Kraken no Redis
    const deadline = Date.now() + 20_000;
    let allPairsFresh = false;

    while (Date.now() < deadline) {
      const checks = await Promise.all(
        env.MONITORED_PAIRS.map(async (pair) => {
          const tickers = await getPairTickers(redisClient!, pair);
          return evaluatePairFreshness(tickers, env.MAX_TICK_AGE_MS);
        }),
      );

      if (checks.every((c) => c.isFresh)) {
        allPairsFresh = true;
        break;
      }

      await sleep(1000);
    }

    if (!allPairsFresh) {
      const snapshots = ingestion.getHealthSnapshots();
      throw new Error(
        `Timeout aguardando todos os 6 hashes frescos no Redis. Status WS: ${JSON.stringify(snapshots)}`,
      );
    }

    console.log('\n--- 1. Cotações ao vivo gravadas no Redis (6 hashes) ---');
    const now = Date.now();
    for (const pair of env.MONITORED_PAIRS) {
      const tickers = await getPairTickers(redisClient, pair);
      const freshness = evaluatePairFreshness(tickers, env.MAX_TICK_AGE_MS, now);
      const binanceTtl = await redisClient.ttl(getTickerKey('binance', pair));
      const krakenTtl = await redisClient.ttl(getTickerKey('kraken', pair));

      if (!tickers.binance || !tickers.kraken || !freshness.isFresh) {
        throw new Error(`Par ${pair} inválido ou não fresco após warmup.`);
      }

      console.log(
        `[${pair}] Binance: bid=${tickers.binance.bid} ask=${tickers.binance.ask} (ttl=${binanceTtl}s, age=${freshness.binanceAgeMs}ms) | ` +
          `Kraken: bid=${tickers.kraken.bid} ask=${tickers.kraken.ask} (ttl=${krakenTtl}s, age=${freshness.krakenAgeMs}ms) | fresh=${freshness.isFresh}`,
      );
    }

    // 2. Validação da lógica de Stale Data
    console.log('\n--- 2. Validação de proteção contra Stale Data ---');
    const testNow = Date.now();
    const expiredAt = testNow - (env.MAX_TICK_AGE_MS + 1000);
    if (!isTickStale(expiredAt, env.MAX_TICK_AGE_MS, testNow)) {
      throw new Error('isTickStale falhou ao detectar timestamp defasado.');
    }

    const simulatedStale = evaluatePairFreshness(
      {
        binance: { ask: 100, bid: 99, updatedAt: testNow },
        kraken: { ask: 101, bid: 100, updatedAt: expiredAt },
      },
      env.MAX_TICK_AGE_MS,
      testNow,
    );

    if (simulatedStale.isFresh || simulatedStale.reason !== 'stale_kraken') {
      throw new Error(
        `evaluatePairFreshness retornou resultado inesperado para stale simulado: ${JSON.stringify(simulatedStale)}`,
      );
    }
    console.log(
      `Proteção Stale Data validada: isFresh=${simulatedStale.isFresh}, reason=${simulatedStale.reason} (age=${simulatedStale.krakenAgeMs}ms > ${env.MAX_TICK_AGE_MS}ms)`,
    );

    // 3. Validação de resiliência e reconexão ao vivo
    console.log('\n--- 3. Validação de reconexão automática ao vivo ---');
    const binanceConnector = ingestion.getConnector('binance');
    const reconnectTriggeredAt = Date.now();
    binanceConnector.forceReconnect('smoke-test-reconnect');

    const reconnectDeadline = Date.now() + 8_000;
    let reconnectedWithNewTicks = false;

    while (Date.now() < reconnectDeadline) {
      await sleep(250);
      const snap = binanceConnector.getHealthSnapshot(env.MAX_TICK_AGE_MS);
      if (
        snap.state === 'connected' &&
        snap.reconnectAttempts >= 1 &&
        snap.lastTickAt !== null &&
        snap.lastTickAt > reconnectTriggeredAt
      ) {
        reconnectedWithNewTicks = true;
        console.log(
          `Reconexão Binance confirmada: state=${snap.state}, reconnectAttempts=${snap.reconnectAttempts}, novoTickRecebido=${snap.lastTickAt > reconnectTriggeredAt}`,
        );
        break;
      }
    }

    if (!reconnectedWithNewTicks) {
      throw new Error('Conector Binance não reconectou com novos ticks dentro de 8s.');
    }

    console.log('\nSmoke test da Etapa 3 concluído com sucesso!');
  } catch (error) {
    console.error('[SMOKE-INGESTION] Falha:', error);
    process.exitCode = 1;
  } finally {
    if (ingestion) {
      ingestion.stop();
    }
    if (redisClient) {
      await disconnectRedis(redisClient);
    }
  }
}

await runIngestionSmokeTest();
