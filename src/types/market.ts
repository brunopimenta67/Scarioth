export type ExchangeName = 'binance' | 'kraken';

export const EXCHANGES: readonly ExchangeName[] = ['binance', 'kraken'] as const;

export interface NormalizedTick {
  exchange: ExchangeName;
  pair: string;
  ask: number;
  bid: number;
  updatedAt: number;
}

export interface StoredTicker {
  ask: number;
  bid: number;
  updatedAt: number;
}

export interface PairTickers {
  binance: StoredTicker | null;
  kraken: StoredTicker | null;
}

export type ExchangeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export interface ExchangeHealthSnapshot {
  exchange: ExchangeName;
  state: ExchangeConnectionState;
  connectedAt: number | null;
  lastMessageAt: number | null;
  lastTickAt: number | null;
  reconnectAttempts: number;
  lastError: string | null;
  subscribedPairs: readonly string[];
  isStale: boolean;
}

export interface ArbitrageOpportunity {
  timestamp: Date;
  pair: string;
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
  buyPrice: number;
  sellPrice: number;
  spreadAbsolute: number;
  spreadPercentage: number;
}
