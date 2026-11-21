import type { RawData } from 'ws';
import { createLogger } from '../config/index.js';
import type { ExchangeHealthSnapshot, NormalizedTick } from '../types/index.js';
import { normalizeTick, toCanonicalPair, toKrakenV2Symbol } from './normalizer.js';
import { ReconnectingWebSocket, rawDataToString } from './reconnectingSocket.js';
import { isTickStale } from './staleCheck.js';

const log = createLogger('ingestion', { exchange: 'kraken' });

const KRAKEN_INACTIVITY_TIMEOUT_MS = 25_000;
const KRAKEN_SILENT_PING_THRESHOLD_MS = 10_000;

export interface KrakenConnectorOptions {
  url: string;
  pairs: readonly string[];
  onTick: (tick: NormalizedTick) => void | Promise<void>;
}

interface KrakenTickerItem {
  symbol?: unknown;
  bid?: unknown;
  ask?: unknown;
}

interface KrakenMessage {
  channel?: unknown;
  type?: unknown;
  method?: unknown;
  success?: unknown;
  error?: unknown;
  result?: {
    channel?: unknown;
    symbol?: unknown;
  };
  data?: unknown;
}

/**
 * Conector WebSocket público da Kraken API v2 (`ticker` com `event_trigger: "bbo"`).
 */
export class KrakenConnector {
  private readonly pairs: readonly string[];
  private readonly allowedPairs: ReadonlySet<string>;
  private readonly krakenSymbols: readonly string[];
  private readonly onTick: (tick: NormalizedTick) => void | Promise<void>;
  private readonly socket: ReconnectingWebSocket;

  private readonly confirmedPairs = new Set<string>();
  private lastTickAt: number | null = null;
  private lastLoggedStatus: string | null = null;

  constructor(options: KrakenConnectorOptions) {
    this.pairs = [...options.pairs];
    this.allowedPairs = new Set(this.pairs);
    this.krakenSymbols = this.pairs.map(toKrakenV2Symbol);
    this.onTick = options.onTick;

    this.socket = new ReconnectingWebSocket({
      name: 'kraken',
      url: options.url,
      inactivityTimeoutMs: KRAKEN_INACTIVITY_TIMEOUT_MS,
      onOpen: () => {
        this.confirmedPairs.clear();
        this.lastLoggedStatus = null;
        log.info({ symbols: this.krakenSymbols }, 'WebSocket Kraken conectado. Assinando canal ticker BBO.');
        this.socket.sendJson({
          method: 'subscribe',
          params: {
            channel: 'ticker',
            symbol: this.krakenSymbols,
            event_trigger: 'bbo',
            snapshot: true,
          },
          req_id: 1,
        });
      },
      onHeartbeatCheck: (_ws, silentMs) => {
        if (silentMs >= KRAKEN_SILENT_PING_THRESHOLD_MS) {
          this.socket.sendJson({ method: 'ping' });
        }
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

  public getConfirmedPairs(): readonly string[] {
    return Array.from(this.confirmedPairs);
  }

  public getHealthSnapshot(maxTickAgeMs: number): ExchangeHealthSnapshot {
    const metrics = this.socket.getMetrics();
    return {
      exchange: 'kraken',
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
    let msg: KrakenMessage;
    try {
      msg = JSON.parse(rawDataToString(raw)) as KrakenMessage;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error({ err: errMsg }, 'Falha ao interpretar JSON da Kraken.');
      return;
    }

    if (msg.channel === 'heartbeat' || msg.method === 'pong') {
      return;
    }

    if (msg.channel === 'status') {
      const statusItems = Array.isArray(msg.data) ? msg.data : [];
      const first = statusItems[0] as { system?: unknown; api_version?: unknown } | undefined;
      if (first?.system) {
        const statusSummary = `system=${String(first.system)} v=${String(first.api_version ?? '?')}`;
        if (statusSummary !== this.lastLoggedStatus) {
          this.lastLoggedStatus = statusSummary;
          log.info(
            { system: String(first.system), apiVersion: String(first.api_version ?? '?') },
            'Status da API Kraken.',
          );
        }
      }
      return;
    }

    if (msg.method === 'subscribe') {
      const symbolRaw = msg.result?.symbol;
      if (msg.success === true) {
        if (typeof symbolRaw === 'string') {
          const canonical = toCanonicalPair(symbolRaw);
          if (canonical) {
            this.confirmedPairs.add(canonical);
          }
        }
        log.info({ symbol: String(symbolRaw ?? 'ok') }, 'Assinatura Kraken confirmada.');
      } else {
        log.error(
          { symbol: String(symbolRaw ?? 'desconhecido'), err: String(msg.error ?? 'erro desconhecido') },
          'Falha na assinatura Kraken.',
        );
      }
      return;
    }

    if (
      msg.channel === 'ticker' &&
      (msg.type === 'snapshot' || msg.type === 'update') &&
      Array.isArray(msg.data)
    ) {
      const receivedAt = Date.now();
      for (const rawItem of msg.data) {
        const item = rawItem as KrakenTickerItem;
        const tick = normalizeTick({
          exchange: 'kraken',
          rawSymbol: item.symbol,
          rawAsk: item.ask,
          rawBid: item.bid,
          receivedAt,
          allowedPairs: this.allowedPairs,
        });

        if (!tick) {
          continue;
        }

        this.lastTickAt = receivedAt;
        Promise.resolve(this.onTick(tick)).catch((error: unknown) => {
          const errMsg = error instanceof Error ? error.message : String(error);
          log.error({ pair: tick.pair, err: errMsg }, 'Erro no consumidor de tick.');
        });
      }
    }
  }
}
