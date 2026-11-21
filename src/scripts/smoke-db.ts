import { env } from '../config/index.js';
import {
  OPPORTUNITIES_COLLECTION,
  connectMongo,
  disconnectMongo,
  ensureOpportunitiesTimeSeriesCollection,
  pingMongo,
  type MongoConnection,
} from '../database/index.js';
import { connectRedis, disconnectRedis, pingRedis, type Redis } from '../redis/index.js';

const SMOKE_KEY = 'scarioth:smoke:check';

async function runDatabaseSmokeTest(): Promise<void> {
  let redisClient: Redis | undefined;
  let mongoConnection: MongoConnection | undefined;

  try {
    console.log('=== Scarioth — Smoke Test de Bancos de Dados (Etapa 2) ===');

    // 1. Redis: conexão, PING, SET/GET/DEL temporário
    redisClient = await connectRedis();
    const redisPingOk = await pingRedis(redisClient);
    if (!redisPingOk) {
      throw new Error('Falha na verificação pingRedis após conexão.');
    }

    await redisClient.set(SMOKE_KEY, 'ok', 'EX', 10);
    const readValue = await redisClient.get(SMOKE_KEY);
    if (readValue !== 'ok') {
      throw new Error(`Leitura inesperada no Redis para ${SMOKE_KEY}: "${readValue}"`);
    }
    await redisClient.del(SMOKE_KEY);

    console.log(
      `Redis conectado (${env.REDIS_HOST}:${env.REDIS_PORT} — PING: PONG, SET/GET/DEL: OK)`,
    );

    // 2. MongoDB: conexão, ping, criação nativa Time-Series + idempotência
    mongoConnection = await connectMongo();
    const mongoPingOk = await pingMongo(mongoConnection.db);
    if (!mongoPingOk) {
      throw new Error('Falha na verificação pingMongo após conexão.');
    }

    const firstStatus = mongoConnection.opportunitiesCollection;
    const secondStatus = await ensureOpportunitiesTimeSeriesCollection(mongoConnection.db);
    if (secondStatus.created !== false) {
      throw new Error('Falha na verificação de idempotência da coleção Time-Series.');
    }

    console.log(
      `MongoDB conectado (banco "${env.MONGO_DB_NAME}" — coleção "${OPPORTUNITIES_COLLECTION}" validada como ${firstStatus.type} | created=${firstStatus.created}, timeField=${firstStatus.timeField}, metaField=${firstStatus.metaField}, granularity=${firstStatus.granularity ?? 'default'}, idempotente=true)`,
    );
  } catch (error) {
    console.error('[SMOKE-DB] Falha no smoke test:', error);
    process.exitCode = 1;
  } finally {
    if (redisClient) {
      await disconnectRedis(redisClient);
    }
    if (mongoConnection) {
      await disconnectMongo(mongoConnection.client);
    }
  }
}

await runDatabaseSmokeTest();
