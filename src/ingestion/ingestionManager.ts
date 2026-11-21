import { createLogger } from '../config/index.js';
import { getTickerTtlSeconds, saveTicker, type Redis } from '../redis/index.js';

const log = createLogger('ingestion');
import type { ExchangeHealthSnapshot, ExchangeName, NormalizedTick } from '../types/index.js';
import { BinanceConnector } from './binanceConnector.js';
import { KrakenConnector } from './krakenConnector.js';

export interface IngestionManagerOptions {
  redis: Redis;
  pairs: readonly string[];
  maxTickAgeMs: number;
  binanceWsBaseUrl: string;
  krakenWsUrl: string;
  onTick?: (tick: NormalizedTick) => void | Promise<void>;
}

export type ExchangeConnector = BinanceConnector | KrakenConnector;

/**
 * Coordena os conectores da Binance e da Kraken, gravando cada tick normalizado
 * no Redis (Hot Path) antes de notificar consumidores downstream (como a Engine).
 */
export class IngestionManager {
  private readonly redis: Redis;
  private readonly maxTickAgeMs: number;
  private readonly tickerTtlSeconds: number;
  private readonly onTick?: (tick: NormalizedTick) => void | Promise<void>;

  private readonly binance: BinanceConnector;
  private readonly kraken: KrakenConnector;

  constructor(options: IngestionManagerOptions) {
    this.redis = options.redis;
    this.maxTickAgeMs = options.maxTickAgeMs;
    this.tickerTtlSeconds = getTickerTtlSeconds(options.maxTickAgeMs);
    this.onTick = options.onTick;

    const handleTick = async (tick: NormalizedTick): Promise<void> => {
      await this.persistAndDispatch(tick);
    };

    this.binance = new BinanceConnector({
      baseUrl: options.binanceWsBaseUrl,
      pairs: options.pairs,
      onTick: handleTick,
    });

    this.kraken = new KrakenConnector({
      url: options.krakenWsUrl,
      pairs: options.pairs,
      onTick: handleTick,
    });
  }

  public start(): void {
    this.binance.start();
    this.kraken.start();
  }

  public stop(): void {
    this.binance.stop();
    this.kraken.stop();
  }

  public getConnector(exchange: ExchangeName): ExchangeConnector {
    return exchange === 'binance' ? this.binance : this.kraken;
  }

  public getHealthSnapshots(): Record<ExchangeName, ExchangeHealthSnapshot> {
    return {
      binance: this.binance.getHealthSnapshot(this.maxTickAgeMs),
      kraken: this.kraken.getHealthSnapshot(this.maxTickAgeMs),
    };
  }

  private async persistAndDispatch(tick: NormalizedTick): Promise<void> {
    try {
      await saveTicker(this.redis, tick, this.tickerTtlSeconds);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ exchange: tick.exchange, pair: tick.pair, err: msg }, 'Falha ao gravar tick no Redis.');
      return;
    }

    if (this.onTick) {
      try {
        await this.onTick(tick);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ exchange: tick.exchange, pair: tick.pair, err: msg }, 'Erro no listener onTick.');
      }
    }
  }
}
