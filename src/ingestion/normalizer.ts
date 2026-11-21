import type { ExchangeName, NormalizedTick } from '../types/index.js';

const KNOWN_QUOTE_ASSETS = ['USDT', 'USDC', 'USD', 'EUR', 'BTC', 'ETH'] as const;

/**
 * Converte símbolos de diferentes corretoras (ex.: "btcusdt", "BTC/USDT", "XBT/USDT")
 * para o formato canônico interno (ex.: "BTCUSDT").
 */
export function toCanonicalPair(rawSymbol: string): string | null {
  const trimmed = rawSymbol.trim().toUpperCase();
  if (!trimmed) {
    return null;
  }

  let canonical: string;

  if (trimmed.includes('/') || trimmed.includes('-')) {
    const parts = trimmed.split(/[/-]/);
    if (parts.length !== 2) {
      return null;
    }

    const rawBase = parts[0]?.trim() ?? '';
    const rawQuote = parts[1]?.trim() ?? '';
    if (!rawBase || !rawQuote) {
      return null;
    }

    const base = rawBase === 'XBT' ? 'BTC' : rawBase;
    const quote = rawQuote === 'XBT' ? 'BTC' : rawQuote;
    canonical = `${base}${quote}`;
  } else {
    const cleaned = trimmed.replace(/[^A-Z0-9]/g, '');
    canonical = cleaned.startsWith('XBT') ? `BTC${cleaned.slice(3)}` : cleaned;
  }

  if (!/^[A-Z0-9]{4,20}$/.test(canonical)) {
    return null;
  }

  return canonical;
}

/**
 * Converte par canônico interno (ex.: "BTCUSDT") para o formato de stream da Binance ("btcusdt").
 */
export function toBinanceStreamSymbol(canonicalPair: string): string {
  return canonicalPair.trim().toLowerCase();
}

/**
 * Converte par canônico interno (ex.: "BTCUSDT") para o formato da Kraken WebSocket v2 ("BTC/USDT").
 */
export function toKrakenV2Symbol(canonicalPair: string): string {
  const normalized = canonicalPair.trim().toUpperCase();

  if (normalized.includes('/')) {
    const parts = normalized.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      const base = parts[0] === 'XBT' ? 'BTC' : parts[0];
      const quote = parts[1] === 'XBT' ? 'BTC' : parts[1];
      return `${base}/${quote}`;
    }
  }

  const clean = normalized.startsWith('XBT') ? `BTC${normalized.slice(3)}` : normalized;

  for (const quote of KNOWN_QUOTE_ASSETS) {
    if (clean.endsWith(quote) && clean.length > quote.length) {
      const base = clean.slice(0, -quote.length);
      return `${base}/${quote}`;
    }
  }

  throw new Error(
    `Não foi possível converter o par "${canonicalPair}" para o formato Kraken WebSocket v2.`,
  );
}

/**
 * Converte um valor bruto de preço (string ou number) garantindo número finito estritamente positivo.
 */
export function parsePositivePrice(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

export interface NormalizeTickInput {
  exchange: ExchangeName;
  rawSymbol: unknown;
  rawAsk: unknown;
  rawBid: unknown;
  receivedAt?: number;
  allowedPairs?: ReadonlySet<string>;
}

/**
 * Normaliza e valida um evento de topo de livro vindo de qualquer exchange.
 * Descarta símbolos fora da lista monitorada, preços inválidos ou livros invertidos (bid > ask).
 */
export function normalizeTick(input: NormalizeTickInput): NormalizedTick | null {
  if (typeof input.rawSymbol !== 'string') {
    return null;
  }

  const pair = toCanonicalPair(input.rawSymbol);
  if (!pair) {
    return null;
  }

  if (input.allowedPairs && !input.allowedPairs.has(pair)) {
    return null;
  }

  const ask = parsePositivePrice(input.rawAsk);
  const bid = parsePositivePrice(input.rawBid);

  if (ask === null || bid === null || bid > ask) {
    return null;
  }

  return {
    exchange: input.exchange,
    pair,
    ask,
    bid,
    updatedAt: input.receivedAt ?? Date.now(),
  };
}
