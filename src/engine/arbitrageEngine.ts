import type { PairFreshnessResult } from '../ingestion/index.js';
import { acquireArbitrageLock, getPairTickers, type Redis } from '../redis/index.js';
import type { ArbitrageOpportunity, ExchangeName, PairTickers } from '../types/index.js';
import {
  evaluateBidirectionalSpread,
  type BidirectionalSpreadSnapshot,
} from './spreadCalculator.js';

export interface ArbitrageEngineStats {
  evaluationsCount: number;
  detectedCount: number;
  lockedOutCount: number;
  staleSkippedCount: number;
  lastOpportunity: ArbitrageOpportunity | null;
}

export type ArbitrageEvaluationStatus =
  | 'stale_or_missing'
  | 'no_opportunity'
  | 'locked'
  | 'detected';

export interface ArbitrageEvaluationOutcome {
  status: ArbitrageEvaluationStatus;
  opportunity: ArbitrageOpportunity | null;
  snapshot: BidirectionalSpreadSnapshot | null;
  freshness: PairFreshnessResult;
}

export interface ArbitrageEngineOptions {
  getPairTickers: (pair: string) => Promise<PairTickers>;
  acquireLock: (
    pair: string,
    buyExchange: ExchangeName,
    sellExchange: ExchangeName,
    ttlSeconds: number,
  ) => Promise<boolean>;
  minSpreadPercentage: number;
  lockTtlSeconds: number;
  maxTickAgeMs: number;
  now?: () => number;
  onOpportunity?: (opportunity: ArbitrageOpportunity) => void | Promise<void>;
}

/**
 * Orquestrador da Engine de Arbitragem: consulta cotações do Hot Path, calcula spreads
 * bidirecionais, protege contra stale data e deduplica via trava atômica no Redis.
 */
export class ArbitrageEngine {
  private readonly options: ArbitrageEngineOptions;
  private readonly stats: ArbitrageEngineStats = {
    evaluationsCount: 0,
    detectedCount: 0,
    lockedOutCount: 0,
    staleSkippedCount: 0,
    lastOpportunity: null,
  };

  constructor(options: ArbitrageEngineOptions) {
    this.options = options;
  }

  public async evaluatePair(pair: string): Promise<ArbitrageEvaluationOutcome> {
    this.stats.evaluationsCount += 1;

    const tickers = await this.options.getPairTickers(pair);
    const nowMs = this.options.now ? this.options.now() : Date.now();

    const evaluation = evaluateBidirectionalSpread({
      pair,
      tickers,
      minSpreadPercentage: this.options.minSpreadPercentage,
      maxTickAgeMs: this.options.maxTickAgeMs,
      now: nowMs,
    });

    if (!evaluation.freshness.isFresh || !evaluation.snapshot) {
      this.stats.staleSkippedCount += 1;
      return {
        status: 'stale_or_missing',
        opportunity: null,
        snapshot: evaluation.snapshot,
        freshness: evaluation.freshness,
      };
    }

    if (!evaluation.opportunity) {
      return {
        status: 'no_opportunity',
        opportunity: null,
        snapshot: evaluation.snapshot,
        freshness: evaluation.freshness,
      };
    }

    const opp = evaluation.opportunity;
    const acquired = await this.options.acquireLock(
      opp.pair,
      opp.buyExchange,
      opp.sellExchange,
      this.options.lockTtlSeconds,
    );

    if (!acquired) {
      this.stats.lockedOutCount += 1;
      return {
        status: 'locked',
        opportunity: null,
        snapshot: evaluation.snapshot,
        freshness: evaluation.freshness,
      };
    }

    this.stats.detectedCount += 1;
    this.stats.lastOpportunity = opp;

    if (this.options.onOpportunity) {
      try {
        await this.options.onOpportunity(opp);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[ENGINE] Erro no consumidor onOpportunity (${opp.pair}): ${msg}`);
      }
    }

    return {
      status: 'detected',
      opportunity: opp,
      snapshot: evaluation.snapshot,
      freshness: evaluation.freshness,
    };
  }

  public getStats(): ArbitrageEngineStats {
    return {
      ...this.stats,
      lastOpportunity: this.stats.lastOpportunity ? { ...this.stats.lastOpportunity } : null,
    };
  }
}

export type RedisArbitrageEngineOptions = Omit<
  ArbitrageEngineOptions,
  'getPairTickers' | 'acquireLock'
>;

/**
 * Cria a instância padrão da Engine conectada diretamente aos repositórios do Redis.
 */
export function createRedisArbitrageEngine(
  redis: Redis,
  options: RedisArbitrageEngineOptions,
): ArbitrageEngine {
  return new ArbitrageEngine({
    ...options,
    getPairTickers: (pair) => getPairTickers(redis, pair),
    acquireLock: (pair, buyExchange, sellExchange, ttlSeconds) =>
      acquireArbitrageLock(redis, pair, buyExchange, sellExchange, ttlSeconds),
  });
}
