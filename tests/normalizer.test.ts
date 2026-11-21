import { describe, expect, it } from 'vitest';
import {
  normalizeTick,
  parsePositivePrice,
  toBinanceStreamSymbol,
  toCanonicalPair,
  toKrakenV2Symbol,
} from '../src/ingestion/index.js';

describe('normalizer', () => {
  describe('toCanonicalPair', () => {
    it('normaliza símbolos de Binance, Kraken v2 e legado XBT para formato canônico', () => {
      expect(toCanonicalPair('btcusdt')).toBe('BTCUSDT');
      expect(toCanonicalPair('BTC/USDT')).toBe('BTCUSDT');
      expect(toCanonicalPair('XBT/USDT')).toBe('BTCUSDT');
      expect(toCanonicalPair('xbt-usdt')).toBe('BTCUSDT');
      expect(toCanonicalPair('XBTUSDT')).toBe('BTCUSDT');
      expect(toCanonicalPair(' eth/usdt ')).toBe('ETHUSDT');
      expect(toCanonicalPair('SOL/USDT')).toBe('SOLUSDT');
    });

    it('rejeita símbolos vazios ou malformados', () => {
      expect(toCanonicalPair('')).toBeNull();
      expect(toCanonicalPair('   ')).toBeNull();
      expect(toCanonicalPair('BTC/USD/EUR')).toBeNull();
      expect(toCanonicalPair('/USDT')).toBeNull();
      expect(toCanonicalPair('AB')).toBeNull();
    });
  });

  describe('conversores por exchange', () => {
    it('converte para stream da Binance em minúsculas', () => {
      expect(toBinanceStreamSymbol('BTCUSDT')).toBe('btcusdt');
      expect(toBinanceStreamSymbol('SOLUSDT')).toBe('solusdt');
    });

    it('converte para símbolo Kraken v2 com barra', () => {
      expect(toKrakenV2Symbol('BTCUSDT')).toBe('BTC/USDT');
      expect(toKrakenV2Symbol('ETHUSDT')).toBe('ETH/USDT');
      expect(toKrakenV2Symbol('SOLUSDT')).toBe('SOL/USDT');
      expect(toKrakenV2Symbol('XBT/USDT')).toBe('BTC/USDT');
    });

    it('lança erro quando não reconhece o ativo de cotação para Kraken v2', () => {
      expect(() => toKrakenV2Symbol('UNKNOWNPAIR')).toThrow();
    });
  });

  describe('parsePositivePrice', () => {
    it('aceita números e strings numéricas positivas', () => {
      expect(parsePositivePrice(60450.25)).toBe(60450.25);
      expect(parsePositivePrice('60449.99')).toBe(60449.99);
      expect(parsePositivePrice(' 70.42 ')).toBe(70.42);
    });

    it('rejeita valores inválidos, zero ou negativos', () => {
      expect(parsePositivePrice(0)).toBeNull();
      expect(parsePositivePrice('0')).toBeNull();
      expect(parsePositivePrice(-10)).toBeNull();
      expect(parsePositivePrice('-5.5')).toBeNull();
      expect(parsePositivePrice('')).toBeNull();
      expect(parsePositivePrice('   ')).toBeNull();
      expect(parsePositivePrice('abc')).toBeNull();
      expect(parsePositivePrice(Number.NaN)).toBeNull();
      expect(parsePositivePrice(Number.POSITIVE_INFINITY)).toBeNull();
      expect(parsePositivePrice(null)).toBeNull();
      expect(parsePositivePrice(true)).toBeNull();
    });
  });

  describe('normalizeTick', () => {
    it('normaliza tick com preços em string (Binance) e number (Kraken)', () => {
      const binanceTick = normalizeTick({
        exchange: 'binance',
        rawSymbol: 'BTCUSDT',
        rawAsk: '60450.00',
        rawBid: '60449.99',
        receivedAt: 1700000000000,
      });

      expect(binanceTick).toEqual({
        exchange: 'binance',
        pair: 'BTCUSDT',
        ask: 60450,
        bid: 60449.99,
        updatedAt: 1700000000000,
      });

      const krakenTick = normalizeTick({
        exchange: 'kraken',
        rawSymbol: 'BTC/USDT',
        rawAsk: 60457.4,
        rawBid: 60454.4,
        receivedAt: 1700000000100,
      });

      expect(krakenTick).toEqual({
        exchange: 'kraken',
        pair: 'BTCUSDT',
        ask: 60457.4,
        bid: 60454.4,
        updatedAt: 1700000000100,
      });
    });

    it('descarta livro invertido (bid > ask), preços inválidos e pares fora de allowedPairs', () => {
      const allowed = new Set(['BTCUSDT']);

      expect(
        normalizeTick({
          exchange: 'binance',
          rawSymbol: 'ETHUSDT',
          rawAsk: '1700',
          rawBid: '1699',
          allowedPairs: allowed,
        }),
      ).toBeNull();

      expect(
        normalizeTick({
          exchange: 'kraken',
          rawSymbol: 'BTC/USDT',
          rawAsk: 60000,
          rawBid: 60001, // bid > ask inválido
          allowedPairs: allowed,
        }),
      ).toBeNull();

      expect(
        normalizeTick({
          exchange: 'binance',
          rawSymbol: 'BTCUSDT',
          rawAsk: '0',
          rawBid: '60000',
        }),
      ).toBeNull();
    });
  });
});
