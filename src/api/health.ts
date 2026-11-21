import type { OpportunityWriterStats } from '../database/index.js';
import type { ArbitrageEngineStats } from '../engine/index.js';
import type {
  ExchangeConnectionState,
  ExchangeHealthSnapshot,
  ExchangeName,
} from '../types/index.js';

export type OverallHealthStatus = 'ok' | 'degraded' | 'down';

export interface ExchangeHealthSummary {
  state: ExchangeConnectionState;
  isStale: boolean;
  reconnectAttempts: number;
  lastTickAt: number | null;
}

export interface HealthReport {
  status: OverallHealthStatus;
  timestamp: string;
  uptimeSeconds: number;
  dependencies: {
    redis: { ok: boolean };
    mongodb: { ok: boolean };
  };
  exchanges: Record<ExchangeName, ExchangeHealthSummary>;
  wsClients: number;
  engine?: ArbitrageEngineStats;
  coldPath?: OpportunityWriterStats;
}

export interface EvaluateHealthInput {
  redisOk: boolean;
  mongoOk: boolean;
  binance: ExchangeHealthSnapshot;
  kraken: ExchangeHealthSnapshot;
}

/**
 * Determina o status global de saúde e o código HTTP correspondente:
 * - `down` (503): Redis ou MongoDB indisponível
 * - `ok` (200): bancos respondendo e ambas as corretoras conectadas e frescas
 * - `degraded` (200): bancos saudáveis, porém alguma corretora está reconectando ou stale
 */
export function evaluateOverallHealth(input: EvaluateHealthInput): {
  status: OverallHealthStatus;
  httpStatusCode: 200 | 503;
} {
  if (!input.redisOk || !input.mongoOk) {
    return { status: 'down', httpStatusCode: 503 };
  }

  const binanceHealthy = input.binance.state === 'connected' && !input.binance.isStale;
  const krakenHealthy = input.kraken.state === 'connected' && !input.kraken.isStale;

  if (binanceHealthy && krakenHealthy) {
    return { status: 'ok', httpStatusCode: 200 };
  }

  return { status: 'degraded', httpStatusCode: 200 };
}

export interface BuildHealthReportOptions {
  pingRedis: () => Promise<boolean>;
  pingMongo: () => Promise<boolean>;
  getExchangesHealth: () => Record<ExchangeName, ExchangeHealthSnapshot>;
  wsClients: number;
  getEngineStats?: () => ArbitrageEngineStats;
  getColdPathStats?: () => OpportunityWriterStats;
}

function summarizeExchange(snapshot: ExchangeHealthSnapshot): ExchangeHealthSummary {
  return {
    state: snapshot.state,
    isStale: snapshot.isStale,
    reconnectAttempts: snapshot.reconnectAttempts,
    lastTickAt: snapshot.lastTickAt,
  };
}

/**
 * Executa os pings das dependências críticas em paralelo e monta o relatório de saúde.
 */
export async function buildHealthReport(
  options: BuildHealthReportOptions,
): Promise<{ report: HealthReport; httpStatusCode: 200 | 503 }> {
  const [redisOk, mongoOk] = await Promise.all([
    options.pingRedis().catch(() => false),
    options.pingMongo().catch(() => false),
  ]);

  const exchanges = options.getExchangesHealth();
  const { status, httpStatusCode } = evaluateOverallHealth({
    redisOk,
    mongoOk,
    binance: exchanges.binance,
    kraken: exchanges.kraken,
  });

  const report: HealthReport = {
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    dependencies: {
      redis: { ok: redisOk },
      mongodb: { ok: mongoOk },
    },
    exchanges: {
      binance: summarizeExchange(exchanges.binance),
      kraken: summarizeExchange(exchanges.kraken),
    },
    wsClients: options.wsClients,
    ...(options.getEngineStats ? { engine: options.getEngineStats() } : {}),
    ...(options.getColdPathStats ? { coldPath: options.getColdPathStats() } : {}),
  };

  return { report, httpStatusCode };
}
