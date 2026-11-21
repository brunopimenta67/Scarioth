import WebSocket from 'ws';
import {
  buildHealthReport,
  buildMarketSnapshotMessage,
  createScariothServer,
  type ScariothServer,
} from '../api/index.js';
import { env } from '../config/index.js';
import {
  connectMongo,
  createMongoOpportunityWriter,
  disconnectMongo,
  findOpportunities,
  pingMongo,
  type MongoConnection,
} from '../database/index.js';
import { createRedisArbitrageEngine } from '../engine/index.js';
import { IngestionManager } from '../ingestion/index.js';
import {
  connectRedis,
  disconnectRedis,
  getPairTickers,
  pingRedis,
  type Redis,
} from '../redis/index.js';

async function runApiSmokeTest(): Promise<void> {
  let redisClient: Redis | undefined;
  let mongoConnection: MongoConnection | undefined;
  let ingestion: IngestionManager | undefined;
  let apiServer: ScariothServer | undefined;
  let snapshotTimer: NodeJS.Timeout | undefined;
  let wsClient: WebSocket | undefined;

  console.log('=== Scarioth — Smoke Test da API HTTP + Broadcast WS (Etapa 6) ===');

  try {
    redisClient = await connectRedis();
    mongoConnection = await connectMongo();

    const activeRedis = redisClient;
    const activeMongo = mongoConnection;
    const writer = createMongoOpportunityWriter(activeMongo.db);
    const engine = createRedisArbitrageEngine(activeRedis, {
      minSpreadPercentage: env.MIN_SPREAD_PERCENTAGE,
      lockTtlSeconds: env.ARBITRAGE_LOCK_TTL_SECONDS,
      maxTickAgeMs: env.MAX_TICK_AGE_MS,
      onOpportunity: (opp) => {
        writer.enqueue(opp);
        apiServer?.broadcastOpportunity(opp);
      },
    });

    const activeIngestion = new IngestionManager({
      redis: activeRedis,
      pairs: env.MONITORED_PAIRS,
      maxTickAgeMs: env.MAX_TICK_AGE_MS,
      binanceWsBaseUrl: env.BINANCE_WS_BASE_URL,
      krakenWsUrl: env.KRAKEN_WS_URL,
      onTick: (tick) => {
        void engine.evaluatePair(tick.pair).catch(() => undefined);
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

    const serverInfo = await apiServer.start(0, '127.0.0.1');
    console.log(`Servidor de smoke test iniciado em ${serverInfo.url}`);

    activeIngestion.start();

    snapshotTimer = setInterval(() => {
      void (async () => {
        if (!apiServer || apiServer.getConnectedClientsCount() === 0) {
          return;
        }
        const snapshot = await buildMarketSnapshotMessage({
          pairs: env.MONITORED_PAIRS,
          getPairTickers: (pair) => getPairTickers(activeRedis, pair),
          exchangesHealth: activeIngestion.getHealthSnapshots(),
          maxTickAgeMs: env.MAX_TICK_AGE_MS,
        });
        apiServer.broadcastMarketSnapshot(snapshot);
      })().catch(() => undefined);
    }, 1000);

    // 1. Testar GET /health
    const healthRes = await fetch(`${serverInfo.url}/health`);
    const healthJson = (await healthRes.json()) as {
      status: string;
      dependencies: { redis: { ok: boolean }; mongodb: { ok: boolean } };
    };
    if (
      healthRes.status !== 200 ||
      !healthJson.dependencies.redis.ok ||
      !healthJson.dependencies.mongodb.ok
    ) {
      throw new Error(`GET /health retornou estado inválido: ${healthRes.status} ${JSON.stringify(healthJson)}`);
    }
    console.log(
      `[1/4] GET /health -> ${healthRes.status} (status=${healthJson.status}, redis=${healthJson.dependencies.redis.ok}, mongo=${healthJson.dependencies.mongodb.ok})`,
    );

    // 2. Testar GET /api/opportunities?limit=5
    const oppsRes = await fetch(`${serverInfo.url}/api/opportunities?limit=5`);
    const oppsJson = (await oppsRes.json()) as {
      count: number;
      data: unknown[];
    };
    if (oppsRes.status !== 200 || typeof oppsJson.count !== 'number' || !Array.isArray(oppsJson.data)) {
      throw new Error(`GET /api/opportunities falhou: ${oppsRes.status}`);
    }
    console.log(`[2/4] GET /api/opportunities?limit=5 -> ${oppsRes.status} (count=${oppsJson.count})`);

    // 3. Testar validação 400 em parâmetro inválido
    const badRes = await fetch(`${serverInfo.url}/api/opportunities?limit=-5`);
    if (badRes.status !== 400) {
      throw new Error(`Esperado status 400 em limit=-5, obtido ${badRes.status}`);
    }
    console.log(`[3/5] GET /api/opportunities?limit=-5 -> ${badRes.status} (validação 400 OK)`);

    // 4. Testar arquivos estáticos do painel web
    const [htmlRes, jsRes, cssRes] = await Promise.all([
      fetch(`${serverInfo.url}/`),
      fetch(`${serverInfo.url}/app.js`),
      fetch(`${serverInfo.url}/styles.css`),
    ]);
    if (htmlRes.status !== 200 || jsRes.status !== 200 || cssRes.status !== 200) {
      throw new Error(
        `Falha ao servir assets estáticos: /=${htmlRes.status}, /app.js=${jsRes.status}, /styles.css=${cssRes.status}`,
      );
    }
    console.log(
      `[4/5] Assets estáticos -> /=${htmlRes.status}, /app.js=${jsRes.status}, /styles.css=${cssRes.status}`,
    );

    // 5. Testar WebSocket /ws recebendo welcome + market_snapshot ao vivo com todos os pares frescos
    let receivedWelcome = false;
    let freshSnapshotPairs: string[] = [];

    wsClient = new WebSocket(serverInfo.wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout aguardando welcome + market_snapshot ao vivo via /ws'));
      }, 15_000);

      wsClient!.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      wsClient!.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          pairs?: Array<{ pair: string; isFresh: boolean }>;
        };

        if (msg.type === 'welcome') {
          receivedWelcome = true;
        }

        if (msg.type === 'market_snapshot' && Array.isArray(msg.pairs)) {
          const allListed = env.MONITORED_PAIRS.every((p) =>
            msg.pairs!.some((item) => item.pair === p && item.isFresh),
          );
          if (allListed) {
            freshSnapshotPairs = msg.pairs.map((p) => p.pair);
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });

    if (!receivedWelcome || freshSnapshotPairs.length !== env.MONITORED_PAIRS.length) {
      throw new Error('Fluxo WS incompleto no smoke test.');
    }

    console.log(
      `[5/5] WS /ws -> welcome=true + market_snapshot ao vivo recebido com pares frescos: ${freshSnapshotPairs.join(', ')}`,
    );
    console.log('\nSmoke test da Etapa 6 concluído com sucesso!');
  } catch (error) {
    console.error('[SMOKE-API] Falha:', error);
    process.exitCode = 1;
  } finally {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
    }
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.close();
    }
    if (ingestion) {
      ingestion.stop();
    }
    if (apiServer) {
      await apiServer.close().catch(() => undefined);
    }
    if (redisClient) {
      await disconnectRedis(redisClient);
    }
    if (mongoConnection) {
      await disconnectMongo(mongoConnection.client);
    }
  }
}

await runApiSmokeTest();
