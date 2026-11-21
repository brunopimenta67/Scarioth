import { describe, expect, it } from 'vitest';
import {
  formatLocalTime,
  formatPairDisplay,
  formatPrice,
  formatSpreadAbsolute,
  formatSpreadPercentage,
  getOpportunityDedupKey,
  mergeOpportunities,
} from '../client/formatters.js';
import type { OpportunityRow } from '../client/types.js';

describe('client/formatters', () => {
  it('formata pares para exibição legível', () => {
    expect(formatPairDisplay('BTCUSDT')).toBe('BTC/USDT');
    expect(formatPairDisplay('ethusdt')).toBe('ETH/USDT');
    expect(formatPairDisplay('SOLUSDT')).toBe('SOL/USDT');
    expect(formatPairDisplay('BTC/USDT')).toBe('BTC/USDT');
  });

  it('formata preços, spreads percentuais e spreads absolutos', () => {
    expect(formatPrice(60450)).toBe('$60,450.00');
    expect(formatPrice(70.425)).toBe('$70.425');
    expect(formatSpreadPercentage(0.01584)).toBe('+0.0158%');
    expect(formatSpreadPercentage(-0.00421)).toBe('-0.0042%');
    expect(formatSpreadAbsolute(9.54)).toBe('+$9.54');
    expect(formatSpreadAbsolute(0.01)).toBe('+$0.0100');
  });

  it('formata horário local com segurança contra datas inválidas', () => {
    expect(formatLocalTime('data-invalida')).toBe('--:--:--');
    expect(formatLocalTime('2026-11-21T20:00:00.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('deduplica oportunidades entre WebSocket ao vivo e histórico HTTP, mantendo ordem decrescente e limite', () => {
    const t1 = '2026-11-21T20:00:01.000Z';
    const t2 = '2026-11-21T20:00:05.000Z';
    const t3 = '2026-11-21T20:00:10.000Z';

    const liveRow: OpportunityRow = {
      timestamp: t2,
      pair: 'BTCUSDT',
      buyExchange: 'binance',
      sellExchange: 'kraken',
      buyPrice: 60000,
      sellPrice: 60015,
      spreadAbsolute: 15,
      spreadPercentage: 0.025,
      source: 'live',
      isNew: true,
    };

    const historyRowSameAsLive: OpportunityRow = {
      ...liveRow,
      id: 'mongo-id-2',
      source: 'history',
    };

    const olderRow: OpportunityRow = {
      ...liveRow,
      id: 'mongo-id-1',
      timestamp: t1,
      pair: 'ETHUSDT',
      source: 'history',
    };

    const newestRow: OpportunityRow = {
      ...liveRow,
      id: 'mongo-id-3',
      timestamp: t3,
      pair: 'SOLUSDT',
      source: 'history',
    };

    expect(getOpportunityDedupKey(liveRow)).toBe(getOpportunityDedupKey(historyRowSameAsLive));

    const merged = mergeOpportunities(
      [historyRowSameAsLive, olderRow, newestRow],
      [liveRow],
      2,
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]?.pair).toBe('SOLUSDT');
    expect(merged[1]?.pair).toBe('BTCUSDT');
    // Preserva marcação "live" e incorpora "id" vindo do histórico
    expect(merged[1]?.source).toBe('live');
    expect(merged[1]?.id).toBe('mongo-id-2');
  });
});
