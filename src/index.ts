import {
  buildHealthReport,
  buildMarketSnapshotMessage,
  createScariothServer,
  type ScariothServer,
} from './api/index.js';
import { createLogger, env, logger } from './config/index.js';
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
import { createGracefulShutdown } from './shutdown.js';

const SUMMARY_INTERVAL_MS = 5000;
const WS_SNAPSHOT_INTERVAL_MS = 1000;

async function bootstrap(): Promise<void> {
  logger.level = env.LOG_LEVEL;
  const log = createLogger('app');

  let redisClient: Redis | undefined;
  let mongoConnection: MongoConnection | undefined;
  let opportunityWriter: AsyncOpportunityWriter | undefined;
  let ingestion: IngestionManager | undefined;
  let apiServer: ScariothServer | undefined;
  let summaryTimer: NodeJS.Timeout | undefined;
  let snapshotTimer: NodeJS.Timeout | undefined;
  let isShuttingDown = false;

  const shutdown = createGracefulShutdown({
    steps: {
      clearTimers: () => {
        isShuttingDown = true;
        if (summaryTimer) {
          clearInterval(summaryTimer);
          summaryTimer = undefined;
        }
        if (snapshotTimer) {
          clearInterval(snapshotTimer);
          snapshotTimer = undefined;
        }
      },
      stopIngestion: () => {
        ingestion?.stop();
      },
      closeApiServer: async () => {
        if (apiServer) {
          await apiServer.close();
          apiServer = undefined;
        }
      },
      flushColdPath: async () => {
        if (opportunityWriter) {
          await opportunityWriter.flush();
        }
      },
      disconnectRedis: async () => {
        if (redisClient) {
          await disconnectRedis(redisClient);
          redisClient = undefined;
        }
      },
      disconnectMongo: async () => {
        if (mongoConnection) {
          await disconnectMongo(mongoConnection.client);
          mongoConnection = undefined;
        }
      },
    },
    onExit: (code) => {
      process.exit(code);
    },
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (error: Error) => {
    log.fatal({ err: error.message, stack: error.stack }, 'Exceção não capturada.');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.fatal({ err: msg }, 'Promise rejeitada sem tratamento.');
    void shutdown('unhandledRejection', 1);
  });

  log.info(
    {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      pairs: env.MONITORED_PAIRS,
      minSpreadPercentage: env.MIN_SPREAD_PERCENTAGE,
      lockTtlSeconds: env.ARBITRAGE_LOCK_TTL_SECONDS,
      maxTickAgeMs: env.MAX_TICK_AGE_MS,
    },
    'Inicializando Scarioth Arbitrage Scanner.',
  );

  try {
    redisClient = await connectRedis();
    log.info({ host: env.REDIS_HOST, port: env.REDIS_PORT }, 'Redis conectado.');

    mongoConnection = await connectMongo();
    const col = mongoConnection.opportunitiesCollection;
    log.info(
      { db: env.MONGO_DB_NAME, collection: col.name, type: col.type },
      'MongoDB Time-Series conectado.',
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
        const wsClientsNotified = apiServer ? apiServer.broadcastOpportunity(opp) : 0;
        log.info(
          {
            pair: opp.pair,
            buyExchange: opp.buyExchange,
            sellExchange: opp.sellExchange,
            buyPrice: opp.buyPrice,
            sellPrice: opp.sellPrice,
            spreadAbsolute: Number(opp.spreadAbsolute.toFixed(6)),
            spreadPercentage: Number(opp.spreadPercentage.toFixed(4)),
            queuedForMongo: queued,
            wsClientsNotified,
          },
          'Oportunidade de arbitragem detectada.',
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
          log.error({ pair: tick.pair, err: msg }, 'Erro ao avaliar par na Engine.');
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
    log.info(
      { url: serverInfo.url, wsUrl: serverInfo.wsUrl },
      'Servidor HTTP Fastify e WebSocket iniciados.',
    );

    activeIngestion.start();
    log.info('Ingestão, Engine, Cold Path e API em operação. Pressione Ctrl+C para encerrar.');

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
        log.error({ err: msg }, 'Erro ao enviar snapshot de mercado via WebSocket.');
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

        const pairsSummary: Record<string, unknown> = {};
        for (const pair of env.MONITORED_PAIRS) {
          const tickers = await getPairTickers(activeRedis, pair);
          const freshness = evaluatePairFreshness(tickers, env.MAX_TICK_AGE_MS, now);
          const spreads = freshness.isFresh ? calculateBidirectionalSpreads(pair, tickers) : null;

          pairsSummary[pair] = {
            fresh: freshness.isFresh,
            ...(freshness.reason ? { reason: freshness.reason } : {}),
            bestSpreadPct: spreads
              ? Number(spreads.bestDirection.spreadPercentage.toFixed(4))
              : null,
            direction: spreads
              ? `${spreads.bestDirection.buyExchange}->${spreads.bestDirection.sellExchange}`
              : null,
          };
        }

        log.info(
          {
            binanceState: health.binance.state,
            krakenState: health.kraken.state,
            wsClients: apiServer.getConnectedClientsCount(),
            evaluations: stats.evaluationsCount,
            detected: stats.detectedCount,
            lockedOut: stats.lockedOutCount,
            staleSkipped: stats.staleSkippedCount,
            mongoPersisted: writerStats.persistedCount,
            mongoFailed: writerStats.failedCount,
            pairs: pairsSummary,
          },
          'Resumo operacional periódico.',
        );
      })().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'Erro ao montar resumo operacional periódico.');
      });
    }, SUMMARY_INTERVAL_MS);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.fatal({ err: msg }, 'Falha crítica durante a inicialização.');
    await shutdown('bootstrap_error', 1);
  }
}

await bootstrap();
