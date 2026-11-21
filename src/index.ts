import { env } from './config/index.js';
import { connectMongo, disconnectMongo, type MongoConnection } from './database/index.js';
import { connectRedis, disconnectRedis, type Redis } from './redis/index.js';

async function bootstrap(): Promise<void> {
  let redisClient: Redis | undefined;
  let mongoConnection: MongoConnection | undefined;

  console.log('=== Scarioth — Etapa 2 (Configuração + Conexões Redis e MongoDB) ===');
  console.log(`Ambiente: ${env.NODE_ENV} | Porta HTTP prevista: ${env.PORT} | Log: ${env.LOG_LEVEL}`);
  console.log(`Pares monitorados: ${env.MONITORED_PAIRS.join(', ')}`);

  try {
    redisClient = await connectRedis();
    console.log(`Redis conectado (${env.REDIS_HOST}:${env.REDIS_PORT})`);

    mongoConnection = await connectMongo();
    const col = mongoConnection.opportunitiesCollection;
    console.log(
      `MongoDB conectado (banco "${env.MONGO_DB_NAME}" | coleção "${col.name}" como ${col.type}, created=${col.created}, timeField=${col.timeField}, metaField=${col.metaField})`,
    );

    console.log(
      'Status: Camada de dados da Etapa 2 validada (ingestão e servidor HTTP entram nas próximas etapas).',
    );
  } catch (error) {
    console.error('[BOOT] Falha ao inicializar conexões da Etapa 2:', error);
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

await bootstrap();
