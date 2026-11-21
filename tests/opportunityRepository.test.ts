import { describe, expect, it, vi } from 'vitest';
import {
  AsyncOpportunityWriter,
  DEFAULT_OPPORTUNITIES_LIMIT,
  MAX_OPPORTUNITIES_LIMIT,
  normalizeOpportunitiesLimit,
} from '../src/database/index.js';
import type { ArbitrageOpportunity } from '../src/types/index.js';

function makeSampleOpportunity(pair: string = 'BTCUSDT'): ArbitrageOpportunity {
  return {
    timestamp: new Date('2026-11-21T20:00:00.000Z'),
    pair,
    buyExchange: 'binance',
    sellExchange: 'kraken',
    buyPrice: 60000,
    sellPrice: 60100,
    spreadAbsolute: 100,
    spreadPercentage: (100 / 60000) * 100,
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('opportunityRepository', () => {
  describe('normalizeOpportunitiesLimit', () => {
    it('aplica padrão, truncamento e limites mínimo/máximo seguros', () => {
      expect(normalizeOpportunitiesLimit()).toBe(DEFAULT_OPPORTUNITIES_LIMIT);
      expect(normalizeOpportunitiesLimit(Number.NaN)).toBe(DEFAULT_OPPORTUNITIES_LIMIT);
      expect(normalizeOpportunitiesLimit(0)).toBe(1);
      expect(normalizeOpportunitiesLimit(-10)).toBe(1);
      expect(normalizeOpportunitiesLimit(12.8)).toBe(12);
      expect(normalizeOpportunitiesLimit(999)).toBe(MAX_OPPORTUNITIES_LIMIT);
    });
  });

  describe('AsyncOpportunityWriter', () => {
    it('enfileira de forma síncrona e não-bloqueante e atualiza contadores após flush', async () => {
      const deferred = createDeferred();
      const insert = vi.fn().mockImplementation(() => deferred.promise);
      const writer = new AsyncOpportunityWriter({ insert });

      const accepted = writer.enqueue(makeSampleOpportunity('BTCUSDT'));

      expect(accepted).toBe(true);
      expect(writer.getStats()).toMatchObject({
        persistedCount: 0,
        failedCount: 0,
        droppedCount: 0,
        inFlightCount: 1,
      });

      deferred.resolve();
      await writer.flush();

      expect(insert).toHaveBeenCalledTimes(1);
      expect(writer.getStats()).toEqual({
        persistedCount: 1,
        failedCount: 0,
        droppedCount: 0,
        inFlightCount: 0,
        lastError: null,
      });
    });

    it('captura erros do banco sem derrubar o processo e continua aceitando gravações', async () => {
      const onError = vi.fn();
      const insert = vi
        .fn()
        .mockRejectedValueOnce(new Error('MongoDB temporariamente indisponível'))
        .mockResolvedValueOnce(undefined);

      const writer = new AsyncOpportunityWriter({ insert, onError });

      expect(writer.enqueue(makeSampleOpportunity('BTCUSDT'))).toBe(true);
      await writer.flush();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(writer.getStats()).toMatchObject({
        persistedCount: 0,
        failedCount: 1,
        inFlightCount: 0,
        lastError: 'MongoDB temporariamente indisponível',
      });

      expect(writer.enqueue(makeSampleOpportunity('ETHUSDT'))).toBe(true);
      await writer.flush();

      expect(writer.getStats()).toMatchObject({
        persistedCount: 1,
        failedCount: 1,
        inFlightCount: 0,
      });
    });

    it('descarta novas gravações com backpressure quando atinge maxPending', async () => {
      const d1 = createDeferred();
      const d2 = createDeferred();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const insert = vi
        .fn()
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);

      const writer = new AsyncOpportunityWriter({ insert, maxPending: 2 });

      expect(writer.enqueue(makeSampleOpportunity('BTCUSDT'))).toBe(true);
      expect(writer.enqueue(makeSampleOpportunity('ETHUSDT'))).toBe(true);
      expect(writer.enqueue(makeSampleOpportunity('SOLUSDT'))).toBe(false);

      expect(writer.getStats()).toMatchObject({
        inFlightCount: 2,
        droppedCount: 1,
      });

      d1.resolve();
      d2.resolve();
      await writer.flush();

      expect(writer.getStats()).toMatchObject({
        persistedCount: 2,
        droppedCount: 1,
        inFlightCount: 0,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });
});
