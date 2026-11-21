import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildHealthReport,
  createScariothServer,
  type ScariothServer,
} from '../../src/api/index.js';
import {
  OPPORTUNITIES_COLLECTION,
  connectMongo,
  disconnectMongo,
  findOpportunities,
  insertOpportunity,
  pingMongo,
  type MongoConnection,
} from '../../src/database/index.js';
import {
  acquireArbitrageLock,
  connectRedis,
  disconnectRedis,
  getArbitrageLockKey,
  pingRedis,
  type Redis,
} from '../../src/redis/index.js';
import type { ExchangeHealthSnapshot } from '../../src/types/index.js';

const INTEG_PAIR = 'INTEGTESTUSDT';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHealthyExchange(exchange: 'binance' | 'kraken'): ExchangeHealthSnapshot {
  const now = Date.now();
  return {
    exchange,
    state: 'connected',
    connectedAt: now - 10_000,
    lastMessageAt: now - 100,
    lastTickAt: now - 100,
    reconnectAttempts: 0,
    lastError: null,
    subscribedPairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    isStale: false,
  };
}

describe('Integração Real — Redis Lock + MongoDB Time-Series + Fastify HTTP', () => {
  let redisClient: Redis;
  let mongoConnection: MongoConnection;
  let apiServer: ScariothServer | undefined;

  const lockKeyBinToKrk = getArbitrageLockKey(INTEG_PAIR, 'binance', 'kraken');
  const lockKeyKrkToBin = getArbitrageLockKey(INTEG_PAIR, 'kraken', 'binance');

  beforeAll(async () => {
    redisClient = await connectRedis();
    mongoConnection = await connectMongo();
  });

  beforeEach(async () => {
    await redisClient.del(lockKeyBinToKrk, lockKeyKrkToBin);
    await mongoConnection.db
      .collection(OPPORTUNITIES_COLLECTION)
      .deleteMany({ pair: INTEG_PAIR });
  });

  afterAll(async () => {
    if (apiServer) {
      await apiServer.close().catch(() => undefined);
    }
    if (redisClient) {
      await redisClient.del(lockKeyBinToKrk, lockKeyKrkToBin).catch(() => undefined);
      await disconnectRedis(redisClient);
    }
    if (mongoConnection) {
      await mongoConnection.db
        .collection(OPPORTUNITIES_COLLECTION)
        .deleteMany({ pair: INTEG_PAIR })
        .catch(() => undefined);
      await disconnectMongo(mongoConnection.client);
    }
  });

  it('garante trava atômica concorrente no Redis (1 vencedor em 5 chamadas), independência de direção e expiração por TTL', async () => {
    const attempts = await Promise.all([
      acquireArbitrageLock(redisClient, INTEG_PAIR, 'binance', 'kraken', 2),
      acquireArbitrageLock(redisClient, INTEG_PAIR, 'binance', 'kraken', 2),
      acquireArbitrageLock(redisClient, INTEG_PAIR, 'binance', 'kraken', 2),
      acquireArbitrageLock(redisClient, INTEG_PAIR, 'binance', 'kraken', 2),
      acquireArbitrageLock(redisClient, INTEG_PAIR, 'binance', 'kraken', 2),
    ]);

    const wins = attempts.filter(Boolean).length;
    expect(wins).toBe(1);
    expect(attempts.filter((v) => !v)).toHaveLength(4);

    // Direção oposta deve adquirir trava independente (AUD-01)
    const oppositeWon = await acquireArbitrageLock(
      redisClient,
      INTEG_PAIR,
      'kraken',
      'binance',
      2,
    );
    expect(oppositeWon).toBe(true);

    const ttl = await redisClient.ttl(lockKeyBinToKrk);
    expect(ttl).toBeGreaterThanOrEqual(1);
    expect(ttl).toBeLessThanOrEqual(2);

    // Após expirar TTL (2s), deve permitir adquirir novamente
    await sleep(2_200);
    const wonAfterExpire = await acquireArbitrageLock(
      redisClient,
      INTEG_PAIR,
      'binance',
      'kraken',
      2,
    );
    expect(wonAfterExpire).toBe(true);
  });

  it('persiste no MongoDB Time-Series e responde corretamente em GET /api/opportunities e GET /health', async () => {
    const sampleDate = new Date('2026-11-21T21:00:00.000Z');
    await insertOpportunity(mongoConnection.db, {
      timestamp: sampleDate,
      pair: INTEG_PAIR,
      buyExchange: 'binance',
      sellExchange: 'kraken',
      buyPrice: 1000,
      sellPrice: 1005,
      spreadAbsolute: 5,
      spreadPercentage: 0.5,
    });

    apiServer = await createScariothServer({
      findOpportunities: (query) => findOpportunities(mongoConnection.db, query),
      getHealth: (wsClients) =>
        buildHealthReport({
          pingRedis: () => pingRedis(redisClient),
          pingMongo: () => pingMongo(mongoConnection.db),
          getExchangesHealth: () => ({
            binance: makeHealthyExchange('binance'),
            kraken: makeHealthyExchange('kraken'),
          }),
          wsClients,
        }),
      monitoredPairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      minSpreadPercentage: 0.01,
    });

    const oppsRes = await apiServer.app.inject({
      method: 'GET',
      url: `/api/opportunities?pair=${INTEG_PAIR}&limit=5`,
    });

    expect(oppsRes.statusCode).toBe(200);
    const oppsJson = oppsRes.json() as {
      count: number;
      data: Array<{
        id: string;
        timestamp: string;
        pair: string;
        buyExchange: string;
        sellExchange: string;
        buyPrice: number;
        sellPrice: number;
        spreadAbsolute: number;
        spreadPercentage: number;
      }>;
    };

    expect(oppsJson.count).toBe(1);
    expect(oppsJson.data[0]).toMatchObject({
      timestamp: sampleDate.toISOString(),
      pair: INTEG_PAIR,
      buyExchange: 'binance',
      sellExchange: 'kraken',
      buyPrice: 1000,
      sellPrice: 1005,
      spreadAbsolute: 5,
      spreadPercentage: 0.5,
    });
    expect(oppsJson.data[0]?.id).toBeTruthy();

    const healthRes = await apiServer.app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(healthRes.statusCode).toBe(200);
    const healthJson = healthRes.json() as {
      status: string;
      dependencies: { redis: { ok: boolean }; mongodb: { ok: boolean } };
    };
    expect(healthJson.status).toBe('ok');
    expect(healthJson.dependencies).toEqual({
      redis: { ok: true },
      mongodb: { ok: true },
    });
  });
});
