export { BinanceConnector } from './binanceConnector.js';
export type { BinanceConnectorOptions } from './binanceConnector.js';
export { IngestionManager } from './ingestionManager.js';
export type { ExchangeConnector, IngestionManagerOptions } from './ingestionManager.js';
export { KrakenConnector } from './krakenConnector.js';
export type { KrakenConnectorOptions } from './krakenConnector.js';
export {
  normalizeTick,
  parsePositivePrice,
  toBinanceStreamSymbol,
  toCanonicalPair,
  toKrakenV2Symbol,
} from './normalizer.js';
export type { NormalizeTickInput } from './normalizer.js';
export { ReconnectingWebSocket, rawDataToString } from './reconnectingSocket.js';
export type {
  ReconnectingSocketMetrics,
  ReconnectingSocketOptions,
} from './reconnectingSocket.js';
export { evaluatePairFreshness, getTickAgeMs, isTickStale } from './staleCheck.js';
export type { PairFreshnessReason, PairFreshnessResult } from './staleCheck.js';
