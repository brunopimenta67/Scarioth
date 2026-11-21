import type { OpportunityRow } from './types.js';

const KNOWN_QUOTES = ['USDT', 'USDC', 'USD', 'EUR', 'BTC', 'ETH'] as const;

/**
 * Formata o par canônico interno (ex.: "BTCUSDT") para exibição legível ("BTC/USDT").
 */
export function formatPairDisplay(pair: string): string {
  const normalized = pair.trim().toUpperCase();
  if (normalized.includes('/')) {
    return normalized;
  }

  for (const quote of KNOWN_QUOTES) {
    if (normalized.endsWith(quote) && normalized.length > quote.length) {
      const base = normalized.slice(0, -quote.length);
      return `${base}/${quote}`;
    }
  }

  return normalized;
}

/**
 * Formata valores monetários com 2 casas para preços maiores ou até 4 casas para ativos menores.
 */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) {
    return '--';
  }

  const abs = Math.abs(value);
  const maxDecimals = abs >= 100 ? 2 : 4;

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDecimals,
  }).format(value);
}

/**
 * Formata o spread percentual com sinal explícito e 4 casas decimais.
 */
export function formatSpreadPercentage(value: number): string {
  if (!Number.isFinite(value)) {
    return '--';
  }
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(4)}%`;
}

/**
 * Formata o spread absoluto em dólar com sinal explícito.
 */
export function formatSpreadAbsolute(value: number): string {
  if (!Number.isFinite(value)) {
    return '--';
  }
  const sign = value >= 0 ? '+' : '-';
  const abs = Math.abs(value);
  const decimals = abs >= 1 ? 2 : 4;

  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(abs);

  return `${sign}${formatted}`;
}

/**
 * Converte timestamp ISO para hora local legível (HH:mm:ss).
 */
export function formatLocalTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }

  return date.toLocaleTimeString('pt-BR', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Gera chave determinística para evitar duplicatas entre histórico HTTP e eventos WebSocket.
 */
export function getOpportunityDedupKey(
  item: Pick<OpportunityRow, 'id' | 'timestamp' | 'pair' | 'buyExchange' | 'sellExchange'>,
): string {
  return `${item.timestamp}|${item.pair}|${item.buyExchange}|${item.sellExchange}`;
}

/**
 * Mescla oportunidades novas com existentes sem duplicar, ordenando das mais recentes
 * às mais antigas e respeitando o limite máximo de linhas na tela.
 */
export function mergeOpportunities(
  incoming: readonly OpportunityRow[],
  existing: readonly OpportunityRow[],
  maxItems: number,
): OpportunityRow[] {
  const byKey = new Map<string, OpportunityRow>();

  for (const item of existing) {
    byKey.set(getOpportunityDedupKey(item), item);
  }

  for (const item of incoming) {
    const key = getOpportunityDedupKey(item);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, item);
      continue;
    }

    byKey.set(key, {
      ...previous,
      ...item,
      id: item.id ?? previous.id,
      source: previous.source === 'live' || item.source === 'live' ? 'live' : 'history',
      isNew: item.isNew ?? previous.isNew,
    });
  }

  return Array.from(byKey.values())
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, Math.max(0, maxItems));
}
