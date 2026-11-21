import { describe, expect, it } from 'vitest';
import {
  evaluatePairFreshness,
  getTickAgeMs,
  isTickStale,
} from '../src/ingestion/index.js';

describe('staleCheck', () => {
  const now = 1_700_000_010_000;
  const maxAgeMs = 5_000;

  describe('getTickAgeMs', () => {
    it('retorna idade não-negativa e Infinity para updatedAt não finito', () => {
      expect(getTickAgeMs(now - 1200, now)).toBe(1200);
      expect(getTickAgeMs(now + 500, now)).toBe(0);
      expect(getTickAgeMs(Number.NaN, now)).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe('isTickStale', () => {
    it('respeita exatamente o limite maxAgeMs', () => {
      expect(isTickStale(now - 2000, maxAgeMs, now)).toBe(false);
      expect(isTickStale(now - 5000, maxAgeMs, now)).toBe(false); // exatamente no limite
      expect(isTickStale(now - 5001, maxAgeMs, now)).toBe(true); // 1ms acima -> stale
      expect(isTickStale(Number.NaN, maxAgeMs, now)).toBe(true);
      expect(isTickStale(now, 0, now)).toBe(true);
    });
  });

  describe('evaluatePairFreshness', () => {
    it('identifica ausência e defasagem por corretora', () => {
      expect(
        evaluatePairFreshness({ binance: null, kraken: { ask: 10, bid: 9, updatedAt: now } }, maxAgeMs, now),
      ).toMatchObject({ isFresh: false, reason: 'missing_binance' });

      expect(
        evaluatePairFreshness({ binance: { ask: 10, bid: 9, updatedAt: now }, kraken: null }, maxAgeMs, now),
      ).toMatchObject({ isFresh: false, reason: 'missing_kraken' });

      expect(
        evaluatePairFreshness(
          {
            binance: { ask: 10, bid: 9, updatedAt: now - 5001 },
            kraken: { ask: 10, bid: 9, updatedAt: now - 100 },
          },
          maxAgeMs,
          now,
        ),
      ).toMatchObject({ isFresh: false, reason: 'stale_binance', binanceAgeMs: 5001 });

      expect(
        evaluatePairFreshness(
          {
            binance: { ask: 10, bid: 9, updatedAt: now - 100 },
            kraken: { ask: 10, bid: 9, updatedAt: now - 6000 },
          },
          maxAgeMs,
          now,
        ),
      ).toMatchObject({ isFresh: false, reason: 'stale_kraken', krakenAgeMs: 6000 });
    });

    it('aprova quando ambas as corretoras estão frescas', () => {
      const result = evaluatePairFreshness(
        {
          binance: { ask: 100, bid: 99, updatedAt: now - 250 },
          kraken: { ask: 101, bid: 100, updatedAt: now - 400 },
        },
        maxAgeMs,
        now,
      );

      expect(result).toEqual({
        isFresh: true,
        binanceAgeMs: 250,
        krakenAgeMs: 400,
      });
    });
  });
});
