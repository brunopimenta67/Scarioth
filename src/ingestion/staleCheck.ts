import type { PairTickers } from '../types/index.js';

/**
 * Calcula a idade (em ms) de uma cotação a partir do timestamp local de recebimento.
 */
export function getTickAgeMs(updatedAt: number, now: number = Date.now()): number {
  if (!Number.isFinite(updatedAt)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, now - updatedAt);
}

/**
 * Indica se uma cotação excedeu a janela máxima de frescor (stale data).
 */
export function isTickStale(
  updatedAt: number,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(updatedAt) || maxAgeMs <= 0) {
    return true;
  }
  return getTickAgeMs(updatedAt, now) > maxAgeMs;
}

export type PairFreshnessReason =
  | 'missing_binance'
  | 'missing_kraken'
  | 'stale_binance'
  | 'stale_kraken';

export interface PairFreshnessResult {
  isFresh: boolean;
  reason?: PairFreshnessReason;
  binanceAgeMs: number | null;
  krakenAgeMs: number | null;
}

/**
 * Avalia se ambas as cotações (Binance e Kraken) de um par existem e estão frescas
 * antes que a Engine calcule qualquer spread.
 */
export function evaluatePairFreshness(
  tickers: PairTickers,
  maxAgeMs: number,
  now: number = Date.now(),
): PairFreshnessResult {
  const binanceAgeMs = tickers.binance ? getTickAgeMs(tickers.binance.updatedAt, now) : null;
  const krakenAgeMs = tickers.kraken ? getTickAgeMs(tickers.kraken.updatedAt, now) : null;

  if (!tickers.binance) {
    return { isFresh: false, reason: 'missing_binance', binanceAgeMs, krakenAgeMs };
  }

  if (!tickers.kraken) {
    return { isFresh: false, reason: 'missing_kraken', binanceAgeMs, krakenAgeMs };
  }

  if (isTickStale(tickers.binance.updatedAt, maxAgeMs, now)) {
    return { isFresh: false, reason: 'stale_binance', binanceAgeMs, krakenAgeMs };
  }

  if (isTickStale(tickers.kraken.updatedAt, maxAgeMs, now)) {
    return { isFresh: false, reason: 'stale_kraken', binanceAgeMs, krakenAgeMs };
  }

  return { isFresh: true, binanceAgeMs, krakenAgeMs };
}
