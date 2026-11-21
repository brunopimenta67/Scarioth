import { env } from '../config/index.js';
import { calculateBidirectionalSpreads, createRedisArbitrageEngine } from '../engine/index.js';
import { IngestionManager, evaluatePairFreshness } from '../ingestion/index.js';
import {
  acquireArbitrageLock,
  connectRedis,
  disconnectRedis,
  getArbitrageLockKey,
  getPairTickers,
  type Redis,
} from '../redis/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runEngineSmokeTest(): Promise<void> {
  let redisClient: Redis | undefined;
  let ingestion: IngestionManager | undefined;

  const lockKeyMain = getArbitrageLockKey('TESTUSDT', 'binance', 'kraken');
  const lockKeyOpposite = getArbitrageLockKey('TESTUSDT', 'kraken', 'binance');

  console.log('=== Scarioth — Smoke Test da Engine + Trava Atômica Redis (Etapa 4) ===');

  try {
    redisClient = await connectRedis();

    // Limpeza preventiva antes do teste
    await redisClient.del(lockKeyMain, lockKeyOpposite);

    // 1. Teste de Concorrência Atômica Real no Redis
    console.log('\n--- 1. Concorrência Atômica Real da Trava (Promise.all) ---');
    const [firstLock, secondLock] = await Promise.all([
      acquireArbitrageLock(redisClient, 'TESTUSDT', 'binance', 'kraken', 3),
      acquireArbitrageLock(redisClient, 'TESTUSDT', 'binance', 'kraken', 3),
    ]);

    const winsCount = [firstLock, secondLock].filter(Boolean).length;
    if (winsCount !== 1) {
      throw new Error(
        `Esperado exatamente 1 vencedor na corrida concorrente, obtido: [${firstLock}, ${secondLock}]`,
      );
    }

    const ttl = await redisClient.ttl(lockKeyMain);
    if (ttl < 1 || ttl > 3) {
      throw new Error(`TTL inesperado para ${lockKeyMain}: ${ttl}s (esperado entre 1s e 3s).`);
    }

    const oppositeLock = await acquireArbitrageLock(redisClient, 'TESTUSDT', 'kraken', 'binance', 3);
    if (!oppositeLock) {
      throw new Error('A direção oposta deveria adquirir trava independente (AUD-01).');
    }

    console.log(
      `Trava atômica validada: resultados simultâneos=[${firstLock}, ${secondLock}] (1 vencedor), ` +
        `TTL(${lockKeyMain})=${ttl}s, direção oposta independente=${oppositeLock}`,
    );

    await redisClient.del(lockKeyMain, lockKeyOpposite);

    // 2. Pipeline Ao Vivo Curto (~8s)
    console.log('\n--- 2. Pipeline Ao Vivo (Ingestão + Engine Event-Driven por ~8s) ---');
    const engine = createRedisArbitrageEngine(redisClient, {
      minSpreadPercentage: env.MIN_SPREAD_PERCENTAGE,
      lockTtlSeconds: env.ARBITRAGE_LOCK_TTL_SECONDS,
      maxTickAgeMs: env.MAX_TICK_AGE_MS,
      onOpportunity: (opp) => {
        console.log(
          `[OPORTUNIDADE AO VIVO] ${opp.pair}: ${opp.buyExchange}->${opp.sellExchange} +${opp.spreadPercentage.toFixed(4)}%`,
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
        void engine.evaluatePair(tick.pair).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[SMOKE-ENGINE] Erro ao avaliar ${tick.pair}: ${msg}`);
        });
      },
    });

    ingestion.start();
    await sleep(8_000);

    const stats = engine.getStats();
    if (stats.evaluationsCount <= 0) {
      throw new Error('Engine não executou nenhuma avaliação durante os 8s de execução ao vivo.');
    }

    console.log(
      `Estatísticas após 8s: avaliações=${stats.evaluationsCount}, oportunidades=${stats.detectedCount}, travadas=${stats.lockedOutCount}, stale=${stats.staleSkippedCount}`,
    );

    const now = Date.now();
    for (const pair of env.MONITORED_PAIRS) {
      const tickers = await getPairTickers(redisClient, pair);
      const freshness = evaluatePairFreshness(tickers, env.MAX_TICK_AGE_MS, now);
      const snapshot = freshness.isFresh ? calculateBidirectionalSpreads(pair, tickers) : null;

      if (snapshot) {
        console.log(
          `  [${pair}] binance->kraken=${snapshot.binanceToKraken.spreadPercentage.toFixed(4)}% | ` +
            `kraken->binance=${snapshot.krakenToBinance.spreadPercentage.toFixed(4)}% | ` +
            `melhor=${snapshot.bestDirection.buyExchange}->${snapshot.bestDirection.sellExchange} (${snapshot.bestDirection.spreadPercentage.toFixed(4)}%)`,
        );
      } else {
        console.log(`  [${pair}] aguardando frescor (${freshness.reason ?? 'sem dados'})`);
      }
    }

    console.log('\nSmoke test da Etapa 4 concluído com sucesso!');
  } catch (error) {
    console.error('[SMOKE-ENGINE] Falha:', error);
    process.exitCode = 1;
  } finally {
    if (ingestion) {
      ingestion.stop();
    }
    if (redisClient) {
      await redisClient.del(lockKeyMain, lockKeyOpposite).catch(() => undefined);
      await disconnectRedis(redisClient);
    }
  }
}

await runEngineSmokeTest();
