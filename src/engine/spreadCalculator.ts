import { evaluatePairFreshness, type PairFreshnessResult } from '../ingestion/index.js';
import type {
  ArbitrageOpportunity,
  ExchangeName,
  PairTickers,
  StoredTicker,
} from '../types/index.js';

export interface DirectionSpread {
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
  buyPrice: number;
  sellPrice: number;
  spreadAbsolute: number;
  spreadPercentage: number;
}

export interface BidirectionalSpreadSnapshot {
  pair: string;
  binanceToKraken: DirectionSpread;
  krakenToBinance: DirectionSpread;
  bestDirection: DirectionSpread;
}

export interface EvaluateSpreadInput {
  pair: string;
  tickers: PairTickers;
  minSpreadPercentage: number;
  maxTickAgeMs: number;
  now?: number;
}

export interface EvaluateSpreadResult {
  opportunity: ArbitrageOpportunity | null;
  snapshot: BidirectionalSpreadSnapshot | null;
  freshness: PairFreshnessResult;
}

function isValidStoredTicker(ticker: StoredTicker | null): ticker is StoredTicker {
  if (!ticker) {
    return false;
  }
  return (
    Number.isFinite(ticker.ask) &&
    Number.isFinite(ticker.bid) &&
    Number.isFinite(ticker.updatedAt) &&
    ticker.ask > 0 &&
    ticker.bid > 0 &&
    ticker.bid <= ticker.ask
  );
}

/**
 * Calcula spread absoluto e percentual para uma direção (compra em buyExchange, venda em sellExchange).
 */
export function calculateDirectionSpread(
  buyExchange: ExchangeName,
  sellExchange: ExchangeName,
  buyPrice: number,
  sellPrice: number,
): DirectionSpread | null {
  if (
    !Number.isFinite(buyPrice) ||
    !Number.isFinite(sellPrice) ||
    buyPrice <= 0 ||
    sellPrice <= 0
  ) {
    return null;
  }

  const spreadAbsolute = sellPrice - buyPrice;
  const spreadPercentage = (spreadAbsolute / buyPrice) * 100;

  return {
    buyExchange,
    sellExchange,
    buyPrice,
    sellPrice,
    spreadAbsolute,
    spreadPercentage,
  };
}

/**
 * Calcula os spreads nos dois sentidos (Binance -> Kraken e Kraken -> Binance)
 * e retorna a melhor direção encontrada.
 */
export function calculateBidirectionalSpreads(
  pair: string,
  tickers: PairTickers,
): BidirectionalSpreadSnapshot | null {
  if (!isValidStoredTicker(tickers.binance) || !isValidStoredTicker(tickers.kraken)) {
    return null;
  }

  const binanceToKraken = calculateDirectionSpread(
    'binance',
    'kraken',
    tickers.binance.ask,
    tickers.kraken.bid,
  );
  const krakenToBinance = calculateDirectionSpread(
    'kraken',
    'binance',
    tickers.kraken.ask,
    tickers.binance.bid,
  );

  if (!binanceToKraken || !krakenToBinance) {
    return null;
  }

  const bestDirection =
    binanceToKraken.spreadPercentage >= krakenToBinance.spreadPercentage
      ? binanceToKraken
      : krakenToBinance;

  return {
    pair,
    binanceToKraken,
    krakenToBinance,
    bestDirection,
  };
}

/**
 * Valida frescor contra stale data (Invariante 8), calcula spread bidirecional (Invariante 6)
 * e verifica se a melhor direção supera o limiar mínimo configurado.
 */
export function evaluateBidirectionalSpread(input: EvaluateSpreadInput): EvaluateSpreadResult {
  const now = input.now ?? Date.now();
  const freshness = evaluatePairFreshness(input.tickers, input.maxTickAgeMs, now);

  if (!freshness.isFresh) {
    return {
      opportunity: null,
      snapshot: null,
      freshness,
    };
  }

  const snapshot = calculateBidirectionalSpreads(input.pair, input.tickers);
  if (!snapshot) {
    return {
      opportunity: null,
      snapshot: null,
      freshness,
    };
  }

  const best = snapshot.bestDirection;
  const meetsThreshold =
    best.spreadAbsolute > 0 &&
    Number.isFinite(input.minSpreadPercentage) &&
    best.spreadPercentage >= input.minSpreadPercentage;

  if (!meetsThreshold) {
    return {
      opportunity: null,
      snapshot,
      freshness,
    };
  }

  return {
    opportunity: {
      timestamp: new Date(now),
      pair: input.pair,
      buyExchange: best.buyExchange,
      sellExchange: best.sellExchange,
      buyPrice: best.buyPrice,
      sellPrice: best.sellPrice,
      spreadAbsolute: best.spreadAbsolute,
      spreadPercentage: best.spreadPercentage,
    },
    snapshot,
    freshness,
  };
}
