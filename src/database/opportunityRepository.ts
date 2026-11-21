import type { Db, Filter, WithId } from 'mongodb';
import { createLogger } from '../config/index.js';
import type { ArbitrageOpportunity, ExchangeName } from '../types/index.js';

const log = createLogger('cold-path');
import {
  OPPORTUNITIES_COLLECTION,
  OPPORTUNITIES_META_FIELD,
  OPPORTUNITIES_TIME_FIELD,
} from './mongo.js';

export const DEFAULT_OPPORTUNITIES_LIMIT = 50;
export const MAX_OPPORTUNITIES_LIMIT = 200;
export const DEFAULT_MAX_PENDING_WRITES = 100;

export interface OpportunityDocument {
  timestamp: Date;
  pair: string;
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
  buyPrice: number;
  sellPrice: number;
  spreadAbsolute: number;
  spreadPercentage: number;
}

export interface StoredArbitrageOpportunity extends ArbitrageOpportunity {
  id: string;
}

export interface FindOpportunitiesQuery {
  pair?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface OpportunityWriterStats {
  persistedCount: number;
  failedCount: number;
  droppedCount: number;
  inFlightCount: number;
  lastError: string | null;
}

export interface AsyncOpportunityWriterOptions {
  insert: (opportunity: ArbitrageOpportunity) => Promise<void>;
  maxPending?: number;
  onError?: (error: Error, opportunity: ArbitrageOpportunity) => void;
}

/**
 * Normaliza e aplica limites seguros à quantidade de registros retornados nas consultas.
 */
export function normalizeOpportunitiesLimit(rawLimit?: number): number {
  if (rawLimit === undefined || !Number.isFinite(rawLimit)) {
    return DEFAULT_OPPORTUNITIES_LIMIT;
  }

  const truncated = Math.trunc(rawLimit);
  if (truncated < 1) {
    return 1;
  }
  if (truncated > MAX_OPPORTUNITIES_LIMIT) {
    return MAX_OPPORTUNITIES_LIMIT;
  }
  return truncated;
}

/**
 * Garante de forma idempotente os índices secundários da coleção Time-Series
 * para consultas rápidas por período e filtro por par.
 */
export async function ensureOpportunitiesIndexes(db: Db): Promise<void> {
  const collection = db.collection<OpportunityDocument>(OPPORTUNITIES_COLLECTION);

  await collection.createIndex(
    { [OPPORTUNITIES_META_FIELD]: 1, [OPPORTUNITIES_TIME_FIELD]: -1 },
    { name: 'idx_pair_timestamp_desc' },
  );

  await collection.createIndex(
    { [OPPORTUNITIES_TIME_FIELD]: -1 },
    { name: 'idx_timestamp_desc' },
  );
}

/**
 * Grava uma oportunidade na coleção Time-Series garantindo timestamp como Date válido.
 */
export async function insertOpportunity(
  db: Db,
  opportunity: ArbitrageOpportunity,
): Promise<void> {
  if (!(opportunity.timestamp instanceof Date) || Number.isNaN(opportunity.timestamp.getTime())) {
    throw new Error('[MONGODB] O campo timestamp deve ser uma instância Date válida.');
  }

  const collection = db.collection<OpportunityDocument>(OPPORTUNITIES_COLLECTION);
  await collection.insertOne({
    timestamp: opportunity.timestamp,
    pair: opportunity.pair,
    buyExchange: opportunity.buyExchange,
    sellExchange: opportunity.sellExchange,
    buyPrice: opportunity.buyPrice,
    sellPrice: opportunity.sellPrice,
    spreadAbsolute: opportunity.spreadAbsolute,
    spreadPercentage: opportunity.spreadPercentage,
  });
}

function isValidDate(value: Date | undefined): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Consulta histórico de oportunidades em ordem decrescente (mais recentes primeiro).
 */
export async function findOpportunities(
  db: Db,
  query: FindOpportunitiesQuery = {},
): Promise<StoredArbitrageOpportunity[]> {
  const filter: Filter<OpportunityDocument> = {};

  if (query.pair && query.pair.trim().length > 0) {
    filter.pair = query.pair.trim().toUpperCase();
  }

  const hasFrom = isValidDate(query.from);
  const hasTo = isValidDate(query.to);
  if (hasFrom || hasTo) {
    filter.timestamp = {
      ...(hasFrom ? { $gte: query.from } : {}),
      ...(hasTo ? { $lte: query.to } : {}),
    };
  }

  const limit = normalizeOpportunitiesLimit(query.limit);
  const collection = db.collection<OpportunityDocument>(OPPORTUNITIES_COLLECTION);

  const docs = (await collection
    .find(filter)
    .sort({ [OPPORTUNITIES_TIME_FIELD]: -1 })
    .limit(limit)
    .toArray()) as WithId<OpportunityDocument>[];

  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    timestamp: doc.timestamp,
    pair: doc.pair,
    buyExchange: doc.buyExchange,
    sellExchange: doc.sellExchange,
    buyPrice: doc.buyPrice,
    sellPrice: doc.sellPrice,
    spreadAbsolute: doc.spreadAbsolute,
    spreadPercentage: doc.spreadPercentage,
  }));
}

/**
 * Escritor assíncrono não-bloqueante para o Cold Path: enfileira gravações sem travar o Hot Path,
 * captura falhas sem derrubar o processo e limita pendências simultâneas (backpressure).
 */
export class AsyncOpportunityWriter {
  private readonly insert: (opportunity: ArbitrageOpportunity) => Promise<void>;
  private readonly maxPending: number;
  private readonly onError?: (error: Error, opportunity: ArbitrageOpportunity) => void;
  private readonly inFlight = new Set<Promise<void>>();

  private persistedCount = 0;
  private failedCount = 0;
  private droppedCount = 0;
  private lastError: string | null = null;

  constructor(options: AsyncOpportunityWriterOptions) {
    this.insert = options.insert;
    this.maxPending =
      options.maxPending && options.maxPending > 0
        ? Math.trunc(options.maxPending)
        : DEFAULT_MAX_PENDING_WRITES;
    this.onError = options.onError;
  }

  public enqueue(opportunity: ArbitrageOpportunity): boolean {
    if (this.inFlight.size >= this.maxPending) {
      this.droppedCount += 1;
      log.warn(
        { pair: opportunity.pair, inFlight: this.inFlight.size, maxPending: this.maxPending },
        'Fila de gravação cheia. Oportunidade descartada para proteger o Hot Path.',
      );
      return false;
    }

    const writeTask: Promise<void> = Promise.resolve()
      .then(() => this.insert(opportunity))
      .then(() => {
        this.persistedCount += 1;
      })
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.failedCount += 1;
        this.lastError = err.message;

        if (this.onError) {
          try {
            this.onError(err, opportunity);
          } catch (hookError) {
            const hookMsg = hookError instanceof Error ? hookError.message : String(hookError);
            log.error({ pair: opportunity.pair, err: hookMsg }, 'Erro no callback onError.');
          }
        } else {
          log.error({ pair: opportunity.pair, err: err.message }, 'Falha ao persistir oportunidade no MongoDB.');
        }
      })
      .finally(() => {
        this.inFlight.delete(writeTask);
      });

    this.inFlight.add(writeTask);
    return true;
  }

  public async flush(timeoutMs: number = 5000): Promise<void> {
    if (this.inFlight.size === 0) {
      return;
    }

    const pending = Promise.allSettled(Array.from(this.inFlight)).then(() => undefined);
    if (timeoutMs <= 0) {
      await pending;
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn(
          { timeoutMs, pendingWrites: this.inFlight.size },
          'Timeout de flush atingido com gravações ainda pendentes.',
        );
        resolve();
      }, timeoutMs);
    });

    try {
      await Promise.race([pending, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  public getStats(): OpportunityWriterStats {
    return {
      persistedCount: this.persistedCount,
      failedCount: this.failedCount,
      droppedCount: this.droppedCount,
      inFlightCount: this.inFlight.size,
      lastError: this.lastError,
    };
  }
}

/**
 * Cria o escritor assíncrono do Cold Path conectado diretamente ao MongoDB.
 */
export function createMongoOpportunityWriter(
  db: Db,
  maxPending?: number,
): AsyncOpportunityWriter {
  return new AsyncOpportunityWriter({
    insert: (opportunity) => insertOpportunity(db, opportunity),
    ...(maxPending !== undefined ? { maxPending } : {}),
  });
}
