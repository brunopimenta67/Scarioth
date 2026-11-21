import type { Redis } from 'ioredis';
import type { ExchangeName, NormalizedTick, PairTickers, StoredTicker } from '../types/index.js';

/**
 * Gera a chave canônica do Hash de cotação no Redis.
 */
export function getTickerKey(exchange: ExchangeName, pair: string): string {
  return `ticker:${exchange}:${pair}`;
}

/**
 * Calcula o TTL defensivo das cotações no Redis (3x a janela de stale, mínimo de 15s)
 * para distinguir dado defasado de chave ausente sem acumular dados eternamente.
 */
export function getTickerTtlSeconds(maxTickAgeMs: number): number {
  return Math.max(Math.ceil((maxTickAgeMs * 3) / 1000), 15);
}

function parseStoredTicker(raw: Record<string, string> | null | undefined): StoredTicker | null {
  if (!raw || Object.keys(raw).length === 0) {
    return null;
  }

  if (raw.ask === undefined || raw.bid === undefined || raw.updatedAt === undefined) {
    return null;
  }

  const ask = Number(raw.ask);
  const bid = Number(raw.bid);
  const updatedAt = Number(raw.updatedAt);

  if (
    !Number.isFinite(ask) ||
    !Number.isFinite(bid) ||
    !Number.isFinite(updatedAt) ||
    ask <= 0 ||
    bid <= 0 ||
    updatedAt <= 0 ||
    bid > ask
  ) {
    return null;
  }

  return { ask, bid, updatedAt };
}

/**
 * Persiste ask, bid e updatedAt em transação atômica (MULTI/EXEC) junto ao TTL,
 * evitando leitura parcial entre ticks consecutivos.
 */
export async function saveTicker(
  redis: Redis,
  tick: NormalizedTick,
  ttlSeconds: number,
): Promise<void> {
  const key = getTickerKey(tick.exchange, tick.pair);
  const results = await redis
    .multi()
    .hset(key, {
      ask: String(tick.ask),
      bid: String(tick.bid),
      updatedAt: String(tick.updatedAt),
    })
    .expire(key, ttlSeconds)
    .exec();

  if (!results) {
    throw new Error(`[REDIS] Transação MULTI ao gravar ${key} foi abortada.`);
  }

  for (const [err] of results) {
    if (err) {
      throw err;
    }
  }
}

/**
 * Lê e valida uma cotação armazenada no Redis para uma corretora e par específicos.
 */
export async function getTicker(
  redis: Redis,
  exchange: ExchangeName,
  pair: string,
): Promise<StoredTicker | null> {
  const raw = await redis.hgetall(getTickerKey(exchange, pair));
  return parseStoredTicker(raw);
}

/**
 * Busca simultaneamente as cotações de Binance e Kraken para um par via pipeline.
 */
export async function getPairTickers(redis: Redis, pair: string): Promise<PairTickers> {
  const pipeline = redis.pipeline();
  pipeline.hgetall(getTickerKey('binance', pair));
  pipeline.hgetall(getTickerKey('kraken', pair));

  const results = await pipeline.exec();
  if (!results) {
    throw new Error(`[REDIS] Pipeline getPairTickers para ${pair} retornou nulo.`);
  }

  const binanceResult = results[0];
  const krakenResult = results[1];

  if (binanceResult?.[0]) {
    throw binanceResult[0];
  }
  if (krakenResult?.[0]) {
    throw krakenResult[0];
  }

  const rawBinance = binanceResult?.[1] as Record<string, string> | undefined;
  const rawKraken = krakenResult?.[1] as Record<string, string> | undefined;

  return {
    binance: parseStoredTicker(rawBinance),
    kraken: parseStoredTicker(rawKraken),
  };
}
