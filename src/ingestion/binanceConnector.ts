import type { RawData } from 'ws';
import type { ExchangeHealthSnapshot, NormalizedTick } from '../types/index.js';
import { normalizeTick, toBinanceStreamSymbol } from './normalizer.js';
import { ReconnectingWebSocket, rawDataToString } from './reconnectingSocket.js';
import { isTickStale } from './staleCheck.js';

const BINANCE_INACTIVITY_TIMEOUT_MS = 45_000;
const BINANCE_MAX_LIFETIME_MS = 23 * 60 * 60 * 1000 + 50 * 60 * 1000;

export interface BinanceConnectorOptions {
  baseUrl: string;
  pairs: readonly string[];
  onTick: (tick: NormalizedTick) => void | Promise<void>;
}

interface BinanceBookTickerPayload {
  u?: unknown;
  s?: unknown;
  b?: unknown;
  a?: unknown;
  event?: unknown;
}

interface BinanceCombinedMessage {
  stream?: unknown;
  data?: BinanceBookTickerPayload;
  event?: unknown;
  s?: unknown;
  b?: unknown;
  a?: unknown;
}

/**
 * Conector WebSocket público da Binance (stream combinado `<symbol>@bookTicker`).
 */
export class BinanceConnector {
  private readonly pairs: readonly string[];
  private readonly allowedPairs: ReadonlySet<string>;
  private readonly onTick: (tick: NormalizedTick) => void | Promise<void>;
  private readonly socket: ReconnectingWebSocket;

  private lastTickAt: number | null = null;

  constructor(options: BinanceConnectorOptions) {
    this.pairs = [...options.pairs];
    this.allowedPairs = new Set(this.pairs);
    this.onTick = options.onTick;

    const streams = this.pairs.map((pair) => `${toBinanceStreamSymbol(pair)}@bookTicker`).join('/');
    const url = `${options.baseUrl.replace(/\/+$/, '')}/stream?streams=${streams}`;

    this.socket = new ReconnectingWebSocket({
      name: 'binance',
      url,
      inactivityTimeoutMs: BINANCE_INACTIVITY_TIMEOUT_MS,
      maxConnectionLifetimeMs: BINANCE_MAX_LIFETIME_MS,
      onOpen: () => {
        console.log(`[WS:binance] Conectado (${this.pairs.join(', ')})`);
      },
      onMessage: (raw) => this.handleMessage(raw),
    });
  }

  public start(): void {
    this.socket.start();
  }

  public stop(): void {
    this.socket.stop();
  }

  public forceReconnect(reason: string): void {
    this.socket.forceReconnect(reason);
  }

  public getHealthSnapshot(maxTickAgeMs: number): ExchangeHealthSnapshot {
    const metrics = this.socket.getMetrics();
    return {
      exchange: 'binance',
      state: metrics.state,
      connectedAt: metrics.connectedAt,
      lastMessageAt: metrics.lastMessageAt,
      lastTickAt: this.lastTickAt,
      reconnectAttempts: metrics.reconnectAttempts,
      lastError: metrics.lastError,
      subscribedPairs: this.pairs,
      isStale: this.lastTickAt === null || isTickStale(this.lastTickAt, maxTickAgeMs),
    };
  }

  private handleMessage(raw: RawData): void {
    let parsed: BinanceCombinedMessage;
    try {
      parsed = JSON.parse(rawDataToString(raw)) as BinanceCombinedMessage;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[WS:binance] Falha ao interpretar JSON: ${msg}`);
      return;
    }

    if (parsed.event === 'serverShutdown' || parsed.data?.event === 'serverShutdown') {
      this.socket.forceReconnect('aviso serverShutdown da Binance');
      return;
    }

    const payload: BinanceBookTickerPayload | undefined = parsed.data ?? parsed;
    if (!payload) {
      return;
    }

    const receivedAt = Date.now();
    const tick = normalizeTick({
      exchange: 'binance',
      rawSymbol: payload.s,
      rawAsk: payload.a,
      rawBid: payload.b,
      receivedAt,
      allowedPairs: this.allowedPairs,
    });

    if (!tick) {
      return;
    }

    this.lastTickAt = receivedAt;
    Promise.resolve(this.onTick(tick)).catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[WS:binance] Erro no consumidor de tick: ${msg}`);
    });
  }
}
