import { MongoClient } from 'mongodb';
import { env } from '../config/index.js';
import {
  AsyncOpportunityWriter,
  OPPORTUNITIES_COLLECTION,
  connectMongo,
  createMongoOpportunityWriter,
  disconnectMongo,
  findOpportunities,
  insertOpportunity,
  type MongoConnection,
} from '../database/index.js';
import type { ArbitrageOpportunity } from '../types/index.js';

const TEST_PAIR_MAIN = 'SMOKETESTUSDT';
const TEST_PAIR_OTHER = 'SMOKETEST2USDT';

async function runPersistenceSmokeTest(): Promise<void> {
  let mongoConnection: MongoConnection | undefined;

  console.log('=== Scarioth — Smoke Test do Cold Path MongoDB Time-Series (Etapa 5) ===');

  try {
    mongoConnection = await connectMongo();
    const { db } = mongoConnection;
    const collection = db.collection(OPPORTUNITIES_COLLECTION);

    // 1. Verificar índices criados na coleção Time-Series
    const indexes = await collection.indexes();
    const indexNames = indexes.map((idx) => idx.name);
    if (!indexNames.includes('idx_pair_timestamp_desc') || !indexNames.includes('idx_timestamp_desc')) {
      throw new Error(`Índices esperados não encontrados: ${JSON.stringify(indexNames)}`);
    }
    console.log(`Índices Time-Series confirmados: ${indexNames.join(', ')}`);

    // 2. Gravação assíncrona não-bloqueante + flush
    const writer = createMongoOpportunityWriter(db);
    const baseTime = Date.now();

    const oppOlder: ArbitrageOpportunity = {
      timestamp: new Date(baseTime - 1000),
      pair: TEST_PAIR_MAIN,
      buyExchange: 'binance',
      sellExchange: 'kraken',
      buyPrice: 60000,
      sellPrice: 60050,
      spreadAbsolute: 50,
      spreadPercentage: (50 / 60000) * 100,
    };

    const oppNewer: ArbitrageOpportunity = {
      timestamp: new Date(baseTime),
      pair: TEST_PAIR_MAIN,
      buyExchange: 'kraken',
      sellExchange: 'binance',
      buyPrice: 60100,
      sellPrice: 60180,
      spreadAbsolute: 80,
      spreadPercentage: (80 / 60100) * 100,
    };

    const oppOtherPair: ArbitrageOpportunity = {
      timestamp: new Date(baseTime),
      pair: TEST_PAIR_OTHER,
      buyExchange: 'binance',
      sellExchange: 'kraken',
      buyPrice: 1700,
      sellPrice: 1705,
      spreadAbsolute: 5,
      spreadPercentage: (5 / 1700) * 100,
    };

    const q1 = writer.enqueue(oppOlder);
    const q2 = writer.enqueue(oppNewer);
    const q3 = writer.enqueue(oppOtherPair);

    if (!q1 || !q2 || !q3) {
      throw new Error('Falha inesperada ao enfileirar oportunidades sintéticas.');
    }

    await writer.flush();
    const stats = writer.getStats();
    if (stats.persistedCount !== 3 || stats.failedCount !== 0) {
      throw new Error(`Estatísticas inesperadas após flush: ${JSON.stringify(stats)}`);
    }
    console.log(
      `Gravação assíncrona validada: persisted=${stats.persistedCount}, failed=${stats.failedCount}, inFlight=${stats.inFlightCount}`,
    );

    // 3. Consulta ordenada decrescente com filtro por par
    const results = await findOpportunities(db, { pair: TEST_PAIR_MAIN, limit: 10 });
    if (results.length !== 2) {
      throw new Error(`Esperados 2 registros para ${TEST_PAIR_MAIN}, obtidos ${results.length}.`);
    }

    const [first, second] = results;
    if (!first || !second) {
      throw new Error('Resultados vazios inesperados na consulta.');
    }

    if (!(first.timestamp instanceof Date) || !(second.timestamp instanceof Date)) {
      throw new Error('Campo timestamp não retornou como Date.');
    }

    if (first.timestamp.getTime() <= second.timestamp.getTime()) {
      throw new Error('Ordenação decrescente por timestamp falhou.');
    }

    if (
      !first.id ||
      first.buyExchange !== 'kraken' ||
      first.sellExchange !== 'binance' ||
      first.spreadAbsolute !== 80
    ) {
      throw new Error(`Campos divergentes no documento retornado: ${JSON.stringify(first)}`);
    }

    console.log(
      `Consulta decrescente validada: ${results.length} registros para ${TEST_PAIR_MAIN}, primeiro=${first.buyExchange}->${first.sellExchange} (+${first.spreadPercentage.toFixed(4)}%)`,
    );

    // 4. Resiliência real contra MongoDB indisponível sem crash
    const unreachableClient = new MongoClient('mongodb://127.0.0.1:27099', {
      serverSelectionTimeoutMS: 500,
      connectTimeoutMS: 500,
    });

    const resilientWriter = new AsyncOpportunityWriter({
      insert: async (opp) => {
        try {
          await unreachableClient.connect();
          await insertOpportunity(unreachableClient.db(env.MONGO_DB_NAME), opp);
        } finally {
          await unreachableClient.close().catch(() => undefined);
        }
      },
      onError: () => {
        // Erro capturado intencionalmente neste teste de resiliência
      },
    });

    resilientWriter.enqueue(oppNewer);
    await resilientWriter.flush();
    const failStats = resilientWriter.getStats();

    if (failStats.failedCount !== 1 || failStats.lastError === null || failStats.persistedCount !== 0) {
      throw new Error(`Teste de tolerância a falha retornou estado inesperado: ${JSON.stringify(failStats)}`);
    }

    console.log(
      `Resiliência a falha de MongoDB validada: processo vivo, failedCount=${failStats.failedCount}, erro capturado="${failStats.lastError}"`,
    );
    console.log('\nSmoke test da Etapa 5 concluído com sucesso!');
  } catch (error) {
    console.error('[SMOKE-PERSISTENCE] Falha:', error);
    process.exitCode = 1;
  } finally {
    if (mongoConnection) {
      await mongoConnection.db
        .collection(OPPORTUNITIES_COLLECTION)
        .deleteMany({ pair: { $in: [TEST_PAIR_MAIN, TEST_PAIR_OTHER] } })
        .catch((err: unknown) => {
          console.error('[SMOKE-PERSISTENCE] Falha ao limpar dados sintéticos:', err);
        });
      await disconnectMongo(mongoConnection.client);
    }
  }
}

await runPersistenceSmokeTest();
