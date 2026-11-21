import { env } from './config/index.js';
import { connectMongo, disconnectMongo, type MongoConnection } from './database/index.js';
import { calculateBidirectionalSpreads, createRedisArbitrageEngine } from './engine/index.js';
import { IngestionManager, evaluatePairFreshness } from './ingestion/index.js';
import { connectRedis, disconnectRedis, getPairTickers, type Redis } from './redis/index.js';

const SUMMARY_INTERVAL_MS = 5000;

async function bootstrap(): Promise<void> {
  let redisClient: Redis | undefined;
  let mongoConnection: MongoConnection | undefined;
  let ingestion: IngestionManager | undefined;
  let summaryTimer: NodeJS.Timeout | undefined;
  let isShuttingDown = false;

  console.log('=== Scarioth — Etapa 4 (Engine de Spread Bidirecional + Trava Atômica 3s) ===');
  console.log(
    `Ambiente: ${env.NODE_ENV} | Pares: ${env.MONITORED_PAIRS.join(', ')} | Spread mínimo: ${env.MIN_SPREAD_PERCENTAGE}% | Lock: ${env.ARBITRAGE_LOCK_TTL_SECONDS}s`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    console.log(`\n[SHUTDOWN] Sinal ${signal} recebido. Encerrando recursos...`);

    if (summaryTimer) {
      clearInterval(summaryTimer);
      summaryTimer = undefined;
    }

    if (ingestion) {
      ingestion.stop();
    }

    if (redisClient) {
      await disconnectRedis(redisClient);
    }

    if (mongoConnection) {
      await disconnectMongo(mongoConnection.client);
    }

    console.log('[SHUTDOWN] Conexões encerradas com segurança.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    redisClient = await connectRedis();
    console.log(`Redis conectado (${env.REDIS_HOST}:${env.REDIS_PORT})`);

    mongoConnection = await connectMongo();
    const col = mongoConnection.opportunitiesCollection;
    console.log(`MongoDB conectado (banco "${env.MONGO_DB_NAME}" | coleção "${col.name}" pronta como ${col.type})`);

    const engine = createRedisArbitrageEngine(redisClient, {
      minSpreadPercentage: env.MIN_SPREAD_PERCENTAGE,
      lockTtlSeconds: env.ARBITRAGE_LOCK_TTL_SECONDS,
      maxTickAgeMs: env.MAX_TICK_AGE_MS,
      onOpportunity: (opp) => {
        console.log(
          `\n>>> [OPORTUNIDADE] ${opp.pair} | Comprar em ${opp.buyExchange.toUpperCase()} (${opp.buyPrice}) -> Vender em ${opp.sellExchange.toUpperCase()} (${opp.sellPrice}) | Spread: +${opp.spreadPercentage.toFixed(4)}% (+${opp.spreadAbsolute.toFixed(4)}) <<<`,
        );
      },
    });

    ingestion = new IngestionManager({
      redis: redisClient,
      pairs: env.MONITORED_PAIRS,
      maxTickAgeMs: env.MAX_TICK_AGE_MS,
      binanceWsBaseUrl: env.BINANCE_WS_BASE_URL,
      krakenWsUrl: env.KRAKEN_WS_URL,
      onTick: (tick) => {
        if (isShuttingDown) {
          return;
        }
        void engine.evaluatePair(tick.pair).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ENGINE] Erro ao avaliar ${tick.pair}: ${msg}`);
        });
      },
    });

    ingestion.start();
    console.log('Ingestão e Engine iniciadas. Pressione Ctrl+C para encerrar.');

    summaryTimer = setInterval(() => {
      void (async () => {
        if (!redisClient || !ingestion || isShuttingDown) {
          return;
        }

        const now = Date.now();
        const health = ingestion.getHealthSnapshots();
        const stats = engine.getStats();

        console.log(
          `\n[STATUS ${new Date(now).toISOString()}] WS Binance=${health.binance.state} | WS Kraken=${health.kraken.state} | ` +
            `Engine: avaliações=${stats.evaluationsCount}, oportunidades=${stats.detectedCount}, travadas(${env.ARBITRAGE_LOCK_TTL_SECONDS}s)=${stats.lockedOutCount}, stale=${stats.staleSkippedCount}`,
        );

        for (const pair of env.MONITORED_PAIRS) {
          const tickers = await getPairTickers(redisClient, pair);
          const freshness = evaluatePairFreshness(tickers, env.MAX_TICK_AGE_MS, now);
          const spreads = freshness.isFresh ? calculateBidirectionalSpreads(pair, tickers) : null;

          const binStr = tickers.binance
            ? `${tickers.binance.bid}/${tickers.binance.ask} (${freshness.binanceAgeMs}ms)`
            : 'sem dados';
          const krkStr = tickers.kraken
            ? `${tickers.kraken.bid}/${tickers.kraken.ask} (${freshness.krakenAgeMs}ms)`
            : 'sem dados';

          const spreadStr = spreads
            ? `melhor spread: ${spreads.bestDirection.spreadPercentage.toFixed(4)}% (${spreads.bestDirection.buyExchange}->${spreads.bestDirection.sellExchange})`
            : `sem cálculo (${freshness.reason ?? 'dados inválidos'})`;

          console.log(`  ${pair}: Binance=${binStr} | Kraken=${krkStr} | ${spreadStr}`);
        }
      })().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[STATUS] Erro ao ler resumo: ${msg}`);
      });
    }, SUMMARY_INTERVAL_MS);
  } catch (error) {
    console.error('[BOOT] Falha ao iniciar Etapa 4:', error);
    if (summaryTimer) {
      clearInterval(summaryTimer);
    }
    if (ingestion) {
      ingestion.stop();
    }
    if (redisClient) {
      await disconnectRedis(redisClient);
    }
    if (mongoConnection) {
      await disconnectMongo(mongoConnection.client);
    }
    process.exitCode = 1;
  }
}

await bootstrap();
