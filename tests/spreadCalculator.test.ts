import { describe, expect, it } from 'vitest';
import {
  calculateBidirectionalSpreads,
  evaluateBidirectionalSpread,
} from '../src/engine/index.js';

describe('spreadCalculator', () => {
  const now = 1_700_000_050_000;
  const maxTickAgeMs = 5_000;

  it('detecta oportunidade no sentido Binance -> Kraken (compra Ask Binance, vende Bid Kraken)', () => {
    const result = evaluateBidirectionalSpread({
      pair: 'BTCUSDT',
      tickers: {
        binance: { bid: 60000, ask: 60010, updatedAt: now - 100 },
        kraken: { bid: 60130.02, ask: 60150, updatedAt: now - 200 },
      },
      minSpreadPercentage: 0.1,
      maxTickAgeMs,
      now,
    });

    expect(result.freshness.isFresh).toBe(true);
    expect(result.opportunity).not.toBeNull();
    expect(result.opportunity).toMatchObject({
      pair: 'BTCUSDT',
      buyExchange: 'binance',
      sellExchange: 'kraken',
      buyPrice: 60010,
      sellPrice: 60130.02,
    });
    expect(result.opportunity!.spreadAbsolute).toBeCloseTo(120.02, 6);
    expect(result.opportunity!.spreadPercentage).toBeCloseTo(0.2, 4);
    expect(result.opportunity!.timestamp).toEqual(new Date(now));
  });

  it('detecta oportunidade no sentido inverso Kraken -> Binance (compra Ask Kraken, vende Bid Binance)', () => {
    const result = evaluateBidirectionalSpread({
      pair: 'ETHUSDT',
      tickers: {
        binance: { bid: 2010, ask: 2012, updatedAt: now - 150 },
        kraken: { bid: 1998, ask: 2000, updatedAt: now - 250 },
      },
      minSpreadPercentage: 0.1,
      maxTickAgeMs,
      now,
    });

    expect(result.opportunity).not.toBeNull();
    expect(result.opportunity).toMatchObject({
      pair: 'ETHUSDT',
      buyExchange: 'kraken',
      sellExchange: 'binance',
      buyPrice: 2000,
      sellPrice: 2010,
      spreadAbsolute: 10,
    });
    expect(result.opportunity!.spreadPercentage).toBeCloseTo(0.5, 6);
  });

  it('retorna null quando ambos os sentidos são negativos, mantendo o snapshot preenchido', () => {
    const result = evaluateBidirectionalSpread({
      pair: 'SOLUSDT',
      tickers: {
        binance: { bid: 70.4, ask: 70.5, updatedAt: now - 50 },
        kraken: { bid: 70.42, ask: 70.55, updatedAt: now - 50 },
      },
      minSpreadPercentage: 0.01,
      maxTickAgeMs,
      now,
    });

    expect(result.freshness.isFresh).toBe(true);
    expect(result.opportunity).toBeNull();
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.bestDirection.spreadPercentage).toBeLessThan(0);
  });

  it('respeita o limiar minSpreadPercentage (abaixo rejeita, exatamente igual aceita)', () => {
    const tickers = {
      binance: { bid: 99.5, ask: 100, updatedAt: now - 50 },
      kraken: { bid: 100.5, ask: 100.75, updatedAt: now - 50 },
    };

    // Spread exato em ponto flutuante: (100.5 - 100) / 100 * 100 = 0.5%
    const rejected = evaluateBidirectionalSpread({
      pair: 'SOLUSDT',
      tickers,
      minSpreadPercentage: 0.51,
      maxTickAgeMs,
      now,
    });
    expect(rejected.opportunity).toBeNull();

    const accepted = evaluateBidirectionalSpread({
      pair: 'SOLUSDT',
      tickers,
      minSpreadPercentage: 0.5,
      maxTickAgeMs,
      now,
    });
    expect(accepted.opportunity).not.toBeNull();
    expect(accepted.opportunity!.spreadPercentage).toBeCloseTo(0.5, 6);
  });

  it('rejeita empate exato (0%) mesmo quando minSpreadPercentage é 0', () => {
    const result = evaluateBidirectionalSpread({
      pair: 'SOLUSDT',
      tickers: {
        binance: { bid: 99, ask: 100, updatedAt: now },
        kraken: { bid: 100, ask: 101, updatedAt: now },
      },
      minSpreadPercentage: 0,
      maxTickAgeMs,
      now,
    });

    expect(result.opportunity).toBeNull();
  });

  it('bloqueia oportunidade quando alguma cotação está stale (Invariante 8)', () => {
    const result = evaluateBidirectionalSpread({
      pair: 'BTCUSDT',
      tickers: {
        binance: { bid: 60000, ask: 60000, updatedAt: now - 100 },
        kraken: { bid: 65000, ask: 65000, updatedAt: now - 6000 }, // stale!
      },
      minSpreadPercentage: 0.01,
      maxTickAgeMs,
      now,
    });

    expect(result.freshness.isFresh).toBe(false);
    expect(result.freshness.reason).toBe('stale_kraken');
    expect(result.opportunity).toBeNull();
    expect(result.snapshot).toBeNull();
  });

  it('descarta cálculos quando preços armazenados são inválidos (0, negativos ou bid > ask)', () => {
    expect(
      calculateBidirectionalSpreads('BTCUSDT', {
        binance: { bid: 0, ask: 60000, updatedAt: now },
        kraken: { bid: 61000, ask: 61010, updatedAt: now },
      }),
    ).toBeNull();

    expect(
      calculateBidirectionalSpreads('BTCUSDT', {
        binance: { bid: 60010, ask: 60000, updatedAt: now }, // bid > ask
        kraken: { bid: 61000, ask: 61010, updatedAt: now },
      }),
    ).toBeNull();
  });
});
