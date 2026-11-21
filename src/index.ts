import { env } from './config/index.js';

function bootstrapStage1(): void {
  console.log('=== Scarioth — Etapa 1 (Configuração Fail-Fast Validada) ===');
  console.log(`Ambiente: ${env.NODE_ENV} | Porta HTTP prevista: ${env.PORT} | Log: ${env.LOG_LEVEL}`);
  console.log(`Redis alvo: ${env.REDIS_HOST}:${env.REDIS_PORT} (senha: ${env.REDIS_PASSWORD ? 'definida' : 'não definida'})`);
  console.log(`MongoDB alvo: banco "${env.MONGO_DB_NAME}" (URI configurada)`);
  console.log(`Exchanges WS: Binance=${env.BINANCE_WS_BASE_URL} | Kraken=${env.KRAKEN_WS_URL}`);
  console.log(`Pares monitorados: ${env.MONITORED_PAIRS.join(', ')}`);
  console.log(
    `Parâmetros da Engine: spread mínimo=${env.MIN_SPREAD_PERCENTAGE}% | lock TTL=${env.ARBITRAGE_LOCK_TTL_SECONDS}s | stale max=${env.MAX_TICK_AGE_MS}ms`,
  );
  console.log('Status: Fundação da Etapa 1 pronta (sem conexões de banco nesta etapa).');
}

bootstrapStage1();
