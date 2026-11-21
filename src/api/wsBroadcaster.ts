import type { Server as HttpServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createLogger } from '../config/index.js';
import { calculateBidirectionalSpreads } from '../engine/index.js';

const log = createLogger('ws-server');
import { evaluatePairFreshness } from '../ingestion/index.js';
import type {
  ArbitrageOpportunity,
  ExchangeConnectionState,
  ExchangeHealthSnapshot,
  ExchangeName,
  PairTickers,
} from '../types/index.js';

export interface MarketPairSnapshot {
  pair: string;
  binance: { bid: number; ask: number; ageMs: number } | null;
  kraken: { bid: number; ask: number; ageMs: number } | null;
  isFresh: boolean;
  freshnessReason?: string;
  bestSpreadPercentage: number | null;
  bestDirection: { buyExchange: ExchangeName; sellExchange: ExchangeName } | null;
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

export interface OpportunityEventMessage {
  type: 'opportunity';
  timestamp: string;
  data: {
    timestamp: string;
    pair: string;
    buyExchange: ExchangeName;
    sellExchange: ExchangeName;
    buyPrice: number;
    sellPrice: number;
    spreadAbsolute: number;
    spreadPercentage: number;
  };
}

export interface WelcomeMessage {
  type: 'welcome';
  timestamp: string;
  monitoredPairs: readonly string[];
  minSpreadPercentage: number;
}

export interface BuildMarketSnapshotInput {
  pairs: readonly string[];
  getPairTickers: (pair: string) => Promise<PairTickers>;
  exchangesHealth: Record<ExchangeName, ExchangeHealthSnapshot>;
  maxTickAgeMs: number;
  now?: number;
}

/**
 * Monta o resumo atual de cotações e melhores spreads por par para enviar ao painel via WebSocket.
 */
export async function buildMarketSnapshotMessage(
  input: BuildMarketSnapshotInput,
): Promise<MarketSnapshotMessage> {
  const now = input.now ?? Date.now();

  const pairSnapshots = await Promise.all(
    input.pairs.map(async (pair): Promise<MarketPairSnapshot> => {
      const tickers = await input.getPairTickers(pair);
      const freshness = evaluatePairFreshness(tickers, input.maxTickAgeMs, now);
      const spreads = freshness.isFresh ? calculateBidirectionalSpreads(pair, tickers) : null;

      return {
        pair,
        binance:
          tickers.binance && freshness.binanceAgeMs !== null
            ? {
                bid: tickers.binance.bid,
                ask: tickers.binance.ask,
                ageMs: freshness.binanceAgeMs,
              }
            : null,
        kraken:
          tickers.kraken && freshness.krakenAgeMs !== null
            ? {
                bid: tickers.kraken.bid,
                ask: tickers.kraken.ask,
                ageMs: freshness.krakenAgeMs,
              }
            : null,
        isFresh: freshness.isFresh,
        ...(freshness.reason ? { freshnessReason: freshness.reason } : {}),
        bestSpreadPercentage: spreads ? spreads.bestDirection.spreadPercentage : null,
        bestDirection: spreads
          ? {
              buyExchange: spreads.bestDirection.buyExchange,
              sellExchange: spreads.bestDirection.sellExchange,
            }
          : null,
      };
    }),
  );

  return {
    type: 'market_snapshot',
    timestamp: new Date(now).toISOString(),
    exchanges: {
      binance: {
        state: input.exchangesHealth.binance.state,
        isStale: input.exchangesHealth.binance.isStale,
        reconnectAttempts: input.exchangesHealth.binance.reconnectAttempts,
      },
      kraken: {
        state: input.exchangesHealth.kraken.state,
        isStale: input.exchangesHealth.kraken.isStale,
        reconnectAttempts: input.exchangesHealth.kraken.reconnectAttempts,
      },
    },
    pairs: pairSnapshots,
  };
}

export interface WsBroadcasterOptions {
  server: HttpServer;
  path?: string;
  monitoredPairs: readonly string[];
  minSpreadPercentage: number;
}

/**
 * Servidor WebSocket responsável por transmitir oportunidades detectadas e snapshots de mercado
 * em tempo real para todos os clientes do painel conectados na mesma porta do Fastify.
 */
export class WsBroadcaster {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly monitoredPairs: readonly string[];
  private readonly minSpreadPercentage: number;

  constructor(options: WsBroadcasterOptions) {
    this.monitoredPairs = [...options.monitoredPairs];
    this.minSpreadPercentage = options.minSpreadPercentage;

    this.wss = new WebSocketServer({
      server: options.server,
      path: options.path ?? '/ws',
    });

    this.wss.on('error', (err: Error) => {
      log.error({ err: err.message }, 'Erro no servidor WebSocket.');
    });

    this.wss.on('connection', (client: WebSocket) => {
      this.clients.add(client);

      client.on('close', () => {
        this.clients.delete(client);
      });

      client.on('error', () => {
        this.clients.delete(client);
      });

      const welcome: WelcomeMessage = {
        type: 'welcome',
        timestamp: new Date().toISOString(),
        monitoredPairs: this.monitoredPairs,
        minSpreadPercentage: this.minSpreadPercentage,
      };

      this.safeSend(client, JSON.stringify(welcome));
    });
  }

  public broadcastOpportunity(opportunity: ArbitrageOpportunity): number {
    if (this.clients.size === 0) {
      return 0;
    }

    const message: OpportunityEventMessage = {
      type: 'opportunity',
      timestamp: new Date().toISOString(),
      data: {
        timestamp: opportunity.timestamp.toISOString(),
        pair: opportunity.pair,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
        buyPrice: opportunity.buyPrice,
        sellPrice: opportunity.sellPrice,
        spreadAbsolute: opportunity.spreadAbsolute,
        spreadPercentage: opportunity.spreadPercentage,
      },
    };

    return this.broadcastSerialized(JSON.stringify(message));
  }

  public broadcastMarketSnapshot(snapshot: MarketSnapshotMessage): number {
    if (this.clients.size === 0) {
      return 0;
    }

    return this.broadcastSerialized(JSON.stringify(snapshot));
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  public async close(): Promise<void> {
    for (const client of this.clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1001, 'server shutdown');
        } else if (client.readyState === WebSocket.CONNECTING) {
          client.terminate();
        }
      } catch {
        // Ignora erro ao encerrar socket de cliente durante shutdown
      }
    }
    this.clients.clear();

    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  private broadcastSerialized(serializedPayload: string): number {
    let sentCount = 0;
    for (const client of this.clients) {
      if (this.safeSend(client, serializedPayload)) {
        sentCount += 1;
      }
    }
    return sentCount;
  }

  private safeSend(client: WebSocket, payload: string): boolean {
    if (client.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      client.send(payload);
      return true;
    } catch {
      this.clients.delete(client);
      return false;
    }
  }
}
