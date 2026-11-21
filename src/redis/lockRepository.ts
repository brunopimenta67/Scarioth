import type { Redis } from 'ioredis';
import type { ExchangeName } from '../types/index.js';

/**
 * Gera a chave canônica da trava anti-spam por par e direção (AUD-01).
 */
export function getArbitrageLockKey(
  pair: string,
  buyExchange: ExchangeName,
  sellExchange: ExchangeName,
): string {
  return `lock:arbitrage:${pair}:${buyExchange}:${sellExchange}`;
}

/**
 * Tenta adquirir a trava atômica de deduplicação no Redis em comando único (`SET NX EX`),
 * eliminando condições de corrida (race conditions) entre ticks simultâneos.
 */
export async function acquireArbitrageLock(
  redis: Redis,
  pair: string,
  buyExchange: ExchangeName,
  sellExchange: ExchangeName,
  ttlSeconds: number,
): Promise<boolean> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`[REDIS] TTL da trava inválido: ${ttlSeconds}. Deve ser inteiro > 0.`);
  }

  const key = getArbitrageLockKey(pair, buyExchange, sellExchange);
  const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}
