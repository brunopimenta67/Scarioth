import { describe, expect, it, vi } from 'vitest';
import { ArbitrageEngine } from '../src/engine/index.js';
import type { ArbitrageOpportunity, PairTickers } from '../src/types/index.js';

describe('ArbitrageEngine', () => {
  const now = 1_700_000_100_000;

  const profitableTickers: PairTickers = {
    binance: { bid: 60000, ask: 60010, updatedAt: now - 100 },
    kraken: { bid: 60100, ask: 60120, updatedAt: now - 150 },
  };

  it('detecta oportunidade, adquire trava e notifica onOpportunity', async () => {
    const acquireLock = vi.fn().mockResolvedValue(true);
    const onOpportunity = vi.fn();

    const engine = new ArbitrageEngine({
      getPairTickers: vi.fn().mockResolvedValue(profitableTickers),
      acquireLock,
      minSpreadPercentage: 0.05,
      lockTtlSeconds: 3,
      maxTickAgeMs: 5000,
      now: () => now,
      onOpportunity,
    });

    const outcome = await engine.evaluatePair('BTCUSDT');

    expect(outcome.status).toBe('detected');
    expect(outcome.opportunity).not.toBeNull();
    expect(acquireLock).toHaveBeenCalledTimes(1);
    expect(acquireLock).toHaveBeenCalledWith('BTCUSDT', 'binance', 'kraken', 3);
    expect(onOpportunity).toHaveBeenCalledTimes(1);
    expect(engine.getStats()).toMatchObject({
      evaluationsCount: 1,
      detectedCount: 1,
      lockedOutCount: 0,
      staleSkippedCount: 0,
    });
  });

  it('bloqueia duplicata quando a trava retorna false e não chama onOpportunity', async () => {
    const acquireLock = vi.fn().mockResolvedValue(false);
    const onOpportunity = vi.fn();

    const engine = new ArbitrageEngine({
      getPairTickers: vi.fn().mockResolvedValue(profitableTickers),
      acquireLock,
      minSpreadPercentage: 0.05,
      lockTtlSeconds: 3,
      maxTickAgeMs: 5000,
      now: () => now,
      onOpportunity,
    });

    const outcome = await engine.evaluatePair('BTCUSDT');

    expect(outcome.status).toBe('locked');
    expect(outcome.opportunity).toBeNull();
    expect(onOpportunity).not.toHaveBeenCalled();
    expect(engine.getStats()).toMatchObject({
      evaluationsCount: 1,
      detectedCount: 0,
      lockedOutCount: 1,
    });
  });

  it('repassa par e direção corretos para garantir independência bidirecional da trava', async () => {
    const acquireLock = vi.fn().mockResolvedValue(true);

    const krakenCheaperTickers: PairTickers = {
      binance: { bid: 2020, ask: 2025, updatedAt: now - 50 },
      kraken: { bid: 1995, ask: 2000, updatedAt: now - 50 },
    };

    const engine = new ArbitrageEngine({
      getPairTickers: vi.fn().mockResolvedValue(krakenCheaperTickers),
      acquireLock,
      minSpreadPercentage: 0.05,
      lockTtlSeconds: 3,
      maxTickAgeMs: 5000,
      now: () => now,
    });

    const outcome = await engine.evaluatePair('ETHUSDT');

    expect(outcome.status).toBe('detected');
    expect(acquireLock).toHaveBeenCalledWith('ETHUSDT', 'kraken', 'binance', 3);
  });

  it('não tenta adquirir trava quando dados estão stale ou sem spread suficiente', async () => {
    const acquireLock = vi.fn().mockResolvedValue(true);

    const staleEngine = new ArbitrageEngine({
      getPairTickers: vi.fn().mockResolvedValue({
        binance: { bid: 60000, ask: 60000, updatedAt: now - 100 },
        kraken: { bid: 62000, ask: 62010, updatedAt: now - 8000 },
      }),
      acquireLock,
      minSpreadPercentage: 0.01,
      lockTtlSeconds: 3,
      maxTickAgeMs: 5000,
      now: () => now,
    });

    const staleOutcome = await staleEngine.evaluatePair('BTCUSDT');
    expect(staleOutcome.status).toBe('stale_or_missing');
    expect(acquireLock).not.toHaveBeenCalled();
    expect(staleEngine.getStats().staleSkippedCount).toBe(1);

    const noOppEngine = new ArbitrageEngine({
      getPairTickers: vi.fn().mockResolvedValue({
        binance: { bid: 100, ask: 101, updatedAt: now },
        kraken: { bid: 100, ask: 101, updatedAt: now },
      }),
      acquireLock,
      minSpreadPercentage: 0.01,
      lockTtlSeconds: 3,
      maxTickAgeMs: 5000,
      now: () => now,
    });

    const noOppOutcome = await noOppEngine.evaluatePair('SOLUSDT');
    expect(noOppOutcome.status).toBe('no_opportunity');
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it('captura falha dentro de onOpportunity sem derrubar evaluatePair', async () => {
    const engine = new ArbitrageEngine({
      getPairTickers: vi.fn().mockResolvedValue(profitableTickers),
      acquireLock: vi.fn().mockResolvedValue(true),
      minSpreadPercentage: 0.05,
      lockTtlSeconds: 3,
      maxTickAgeMs: 5000,
      now: () => now,
      onOpportunity: async (_opp: ArbitrageOpportunity) => {
        throw new Error('falha simulada no consumidor');
      },
    });

    const outcome = await engine.evaluatePair('BTCUSDT');

    expect(outcome.status).toBe('detected');
    expect(outcome.opportunity).not.toBeNull();
    expect(engine.getStats().detectedCount).toBe(1);
  });
});
