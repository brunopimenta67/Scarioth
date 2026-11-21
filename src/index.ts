import {
  buildHealthReport,
  buildMarketSnapshotMessage,
  createScariothServer,
  type ScariothServer,
} from './api/index.js';
import { env } from './config/index.js';
import {
  connectMongo,
  createMongoOpportunityWriter,
  disconnectMongo,
  findOpportunities,
  pingMongo,
  type AsyncOpportunityWriter,
  type MongoConnection,
} from './database/index.js';
import { calculateBidirectionalSpreads, createRedisArbitrageEngine } from './engine/index.js';
import { IngestionManager, evaluatePairFreshness } from './ingestion/index.js';
import {
  connectRedis,
  disconnectRedis,
  getPairTickers,
  pingRedis,
  type Redis,
} from './redis/index.js';

const SUMMARY_INTERVAL_MS = 5000;
const WS_SNAPSHOT_INTERVAL_MS = 1000;

async function bootstrap(): Promise<void> {
  let redisClient: Redis | undefined;
  let mongoConnection: MongoConnection | undefined;
  let opportunityWriter: AsyncOpportunityWriter | undefined;
  let ingestion: IngestionManager | undefined;
  let apiServer: ScariothServer | undefined;
  let summaryTimer: NodeJS.Timeout | undefined;
  let snapshotTimer: NodeJS.Timeout | undefined;
  let isShuttingDown = false;

  console.log('=== Scarioth — Etapa 6 (API HTTP Fastify + WebSocket Broadcast + Health Check) ===');
  console.log(
    `Ambiente: ${env.NODE_ENV} | Porta: ${env.PORT} | Pares: ${env.MONITORED_PAIRS.join(', ')} | Spread mínimo: ${env.MIN_SPREAD_PERCENTAGE}% | Lock: ${env.ARBITRAGE_LOCK_TTL_SECONDS}s`,
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

    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = undefined;
    }

    if (ingestion) {
      ingestion.stop();
    }

    if (apiServer) {
      await apiServer.close();
    }

    if (opportunityWriter) {
      await opportunityWriter.flush();
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
    console.log(
      `MongoDB conectado (banco "${env.MONGO_DB_NAME}" | coleção "${col.name}" pronta como ${col.type})`,
    );

    const activeRedis = redisClient;
    const activeMongo = mongoConnection;

    const writer = createMongoOpportunityWriter(activeMongo.db);
    opportunityWriter = writer;

    const engine = createRedisArbitrageEngine(activeRedis, {
      minSpreadPercentage: env.MIN_SPREAD_PERCENTAGE,
      lockTtlSeconds: env.ARBITRAGE_LOCK_TTL_SECONDS,
      maxTickAgeMs: env.MAX_TICK_AGE_MS,
      onOpportunity: (opp) => {
        const queued = writer.enqueue(opp);
        const notifiedClients = apiServer ? apiServer.broadcastOpportunity(opp) : 0;
        const persistStatus = queued
          ? 'enviada para gravação assíncrona no MongoDB'
          : 'descartada por fila cheia (backpressure)';
        console.log(
          `\n>>> [OPORTUNIDADE] ${opp.pair} | Comprar em ${opp.buyExchange.toUpperCase()} (${opp.buyPrice}) -> Vender em ${opp.sellExchange.toUpperCase()} (${opp.sellPrice}) | Spread: +${opp.spreadPercentage.toFixed(4)}% (+${opp.spreadAbsolute.toFixed(4)}) | Cold Path: ${persistStatus} | WS painel: ${notifiedClients} cliente(s) <<<`,
        );
      },
    });

    const activeIngestion = new IngestionManager({
      redis: activeRedis,
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
    ingestion = activeIngestion;

    apiServer = await createScariothServer({
      findOpportunities: (query) => findOpportunities(activeMongo.db, query),
      getHealth: (wsClients) =>
        buildHealthReport({
          pingRedis: () => pingRedis(activeRedis),
          pingMongo: () => pingMongo(activeMongo.db),
          getExchangesHealth: () => activeIngestion.getHealthSnapshots(),
          wsClients,
          getEngineStats: () => engine.getStats(),
          getColdPathStats: () => writer.getStats(),
        }),
      monitoredPairs: env.MONITORED_PAIRS,
      minSpreadPercentage: env.MIN_SPREAD_PERCENTAGE,
    });

    const serverInfo = await apiServer.start(env.PORT);
    console.log(`API HTTP pronta em http://127.0.0.1:${serverInfo.port}`);
    console.log(
      `Endpoints: GET /api/opportunities | GET /health | WS ws://127.0.0.1:${serverInfo.port}/ws`,
    );

    activeIngestion.start();
    console.log('Ingestão, Engine, Cold Path e API iniciados. Pressione Ctrl+C para encerrar.');

    snapshotTimer = setInterval(() => {
      void (async () => {
        if (!apiServer || isShuttingDown || apiServer.getConnectedClientsCount() === 0) {
          return;
        }

        const snapshot = await buildMarketSnapshotMessage({
          pairs: env.MONITORED_PAIRS,
          getPairTickers: (pair) => getPairTickers(activeRedis, pair),
          exchangesHealth: activeIngestion.getHealthSnapshots(),
          maxTickAgeMs: env.MAX_TICK_AGE_MS,
        });

        apiServer.broadcastMarketSnapshot(snapshot);
      })().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WS-SERVER] Erro ao enviar snapshot de mercado: ${msg}`);
      });
    }, WS_SNAPSHOT_INTERVAL_MS);

    summaryTimer = setInterval(() => {
      void (async () => {
        if (!apiServer || isShuttingDown) {
          return;
        }

        const now = Date.now();
        const health = activeIngestion.getHealthSnapshots();
        const stats = engine.getStats();
        const writerStats = writer.getStats();
        const wsClients = apiServer.getConnectedClientsCount();

        console.log(
          `\n[STATUS ${new Date(now).toISOString()}] WS Binance=${health.binance.state} | WS Kraken=${health.kraken.state} | Painel WS=${wsClients} cliente(s) | ` +
            `Engine: avaliações=${stats.evaluationsCount}, oportunidades=${stats.detectedCount}, travadas(${env.ARBITRAGE_LOCK_TTL_SECONDS}s)=${stats.lockedOutCount}, stale=${stats.staleSkippedCount}`,
        );
        console.log(
          `  MongoDB: gravadas=${writerStats.persistedCount}, em_voo=${writerStats.inFlightCount}, falhas=${writerStats.failedCount}, descartadas=${writerStats.droppedCount}`,
        );

        for (const pair of env.MONITORED_PAIRS) {
          const tickers = await getPairTickers(activeRedis, pair);
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
    console.error('[BOOT] Falha ao iniciar Etapa 6:', error);
    if (summaryTimer) {
      clearInterval(summaryTimer);
    }
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
    }
    if (ingestion) {
      ingestion.stop();
    }
    if (apiServer) {
      await apiServer.close().catch(() => undefined);
    }
    if (opportunityWriter) {
      await opportunityWriter.flush().catch(() => undefined);
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
