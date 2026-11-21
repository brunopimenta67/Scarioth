import { env } from './config/index.js';
import { connectMongo, disconnectMongo, type MongoConnection } from './database/index.js';
import { IngestionManager, evaluatePairFreshness } from './ingestion/index.js';
import { connectRedis, disconnectRedis, getPairTickers, type Redis } from './redis/index.js';

const SUMMARY_INTERVAL_MS = 5000;

async function bootstrap(): Promise<void> {
  let redisClient: Redis | undefined;
  let mongoConnection: MongoConnection | undefined;
  let ingestion: IngestionManager | undefined;
  let summaryTimer: NodeJS.Timeout | undefined;
  let isShuttingDown = false;

  console.log('=== Scarioth — Etapa 3 (Ingestão WebSocket em Tempo Real + Hot Path Redis) ===');
  console.log(`Ambiente: ${env.NODE_ENV} | Pares: ${env.MONITORED_PAIRS.join(', ')}`);

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
    console.log(`MongoDB conectado (banco "${env.MONGO_DB_NAME}" | coleção "${col.name}" como ${col.type})`);

    ingestion = new IngestionManager({
      redis: redisClient,
      pairs: env.MONITORED_PAIRS,
      maxTickAgeMs: env.MAX_TICK_AGE_MS,
      binanceWsBaseUrl: env.BINANCE_WS_BASE_URL,
      krakenWsUrl: env.KRAKEN_WS_URL,
    });

    ingestion.start();
    console.log('Ingestão WebSocket iniciada (Binance + Kraken v2). Pressione Ctrl+C para encerrar.');

    summaryTimer = setInterval(() => {
      void (async () => {
        if (!redisClient || !ingestion || isShuttingDown) {
          return;
        }

        const now = Date.now();
        const health = ingestion.getHealthSnapshots();

        console.log(
          `\n[STATUS ${new Date(now).toISOString()}] WS Binance=${health.binance.state} (reconexões=${health.binance.reconnectAttempts}) | WS Kraken=${health.kraken.state} (reconexões=${health.kraken.reconnectAttempts})`,
        );

        for (const pair of env.MONITORED_PAIRS) {
          const tickers = await getPairTickers(redisClient, pair);
          const freshness = evaluatePairFreshness(tickers, env.MAX_TICK_AGE_MS, now);

          const binStr = tickers.binance
            ? `${tickers.binance.bid}/${tickers.binance.ask} (${freshness.binanceAgeMs}ms)`
            : 'sem dados';
          const krkStr = tickers.kraken
            ? `${tickers.kraken.bid}/${tickers.kraken.ask} (${freshness.krakenAgeMs}ms)`
            : 'sem dados';

          console.log(
            `  ${pair}: Binance[bid/ask]=${binStr} | Kraken[bid/ask]=${krkStr} | fresh=${freshness.isFresh}${freshness.reason ? ` (${freshness.reason})` : ''}`,
          );
        }
      })().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[STATUS] Erro ao ler resumo no Redis: ${msg}`);
      });
    }, SUMMARY_INTERVAL_MS);
  } catch (error) {
    console.error('[BOOT] Falha ao iniciar Etapa 3:', error);
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
