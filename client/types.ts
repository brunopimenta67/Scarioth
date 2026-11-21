export type ExchangeName = 'binance' | 'kraken';

export type ExchangeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export interface WelcomeMessage {
  type: 'welcome';
  timestamp: string;
  monitoredPairs: readonly string[];
  minSpreadPercentage: number;
}

export interface ExchangeMarketQuote {
  bid: number;
  ask: number;
  ageMs: number;
}

export interface MarketPairSnapshot {
  pair: string;
  binance: ExchangeMarketQuote | null;
  kraken: ExchangeMarketQuote | null;
  isFresh: boolean;
  freshnessReason?: string;
  bestSpreadPercentage: number | null;
  bestDirection: {
    buyExchange: ExchangeName;
    sellExchange: ExchangeName;
  } | null;
}

export interface MarketSnapshotMessage {
  type: 'market_snapshot';
  timestamp: string;
  exchanges: Record<
    ExchangeName,
    {
      state: ExchangeConnectionState;
      isStale: boolean;
      reconnectAttempts: number;
    }
  >;
  pairs: MarketPairSnapshot[];
}

export interface OpportunityPayload {
  id?: string;
  timestamp: string;
  pair: string;
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
  buyPrice: number;
  sellPrice: number;
  spreadAbsolute: number;
  spreadPercentage: number;
}

export interface OpportunityEventMessage {
  type: 'opportunity';
  timestamp: string;
  data: OpportunityPayload;
}

export type ServerWsMessage =
  | WelcomeMessage
  | MarketSnapshotMessage
  | OpportunityEventMessage;

export interface OpportunitiesApiResponse {
  count: number;
  filters: {
    pair: string | null;
    limit: number;
  };
  data: OpportunityPayload[];
}

export interface OpportunityRow extends OpportunityPayload {
  source: 'live' | 'history';
  isNew?: boolean;
}
