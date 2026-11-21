import { Db, MongoClient } from 'mongodb';
import { env } from '../config/index.js';
import { ensureOpportunitiesIndexes } from './opportunityRepository.js';

export const OPPORTUNITIES_COLLECTION = 'arbitrage_opportunities';
export const OPPORTUNITIES_TIME_FIELD = 'timestamp';
export const OPPORTUNITIES_META_FIELD = 'pair';
export const OPPORTUNITIES_GRANULARITY = 'seconds' as const;

export interface TimeSeriesCollectionStatus {
  name: string;
  created: boolean;
  type: 'timeseries';
  timeField: string;
  metaField: string;
  granularity?: string;
}

export interface MongoConnection {
  client: MongoClient;
  db: Db;
  opportunitiesCollection: TimeSeriesCollectionStatus;
}

interface RawCollectionInfo {
  name?: string;
  type?: string;
  options?: {
    timeseries?: {
      timeField?: string;
      metaField?: string;
      granularity?: string;
    };
  };
}

function validateTimeSeriesInfo(
  info: RawCollectionInfo,
  created: boolean,
): TimeSeriesCollectionStatus {
  if (info.type !== 'timeseries') {
    throw new Error(
      `[MONGODB] A coleção "${OPPORTUNITIES_COLLECTION}" já existe com tipo "${info.type ?? 'desconhecido'}" e não pode ser convertida em Time-Series. Remova a coleção comum e recrie-a nativamente como Time-Series.`,
    );
  }

  const tsOptions = info.options?.timeseries;
  if (
    !tsOptions ||
    tsOptions.timeField !== OPPORTUNITIES_TIME_FIELD ||
    tsOptions.metaField !== OPPORTUNITIES_META_FIELD
  ) {
    throw new Error(
      `[MONGODB] A coleção Time-Series "${OPPORTUNITIES_COLLECTION}" possui configuração incompatível (esperado timeField="${OPPORTUNITIES_TIME_FIELD}" e metaField="${OPPORTUNITIES_META_FIELD}").`,
    );
  }

  return {
    name: OPPORTUNITIES_COLLECTION,
    created,
    type: 'timeseries',
    timeField: tsOptions.timeField,
    metaField: tsOptions.metaField,
    ...(tsOptions.granularity ? { granularity: tsOptions.granularity } : {}),
  };
}

/**
 * Garante de forma idempotente que a coleção "arbitrage_opportunities" exista
 * nativamente como Time-Series (Invariante 5), falhando rápido caso exista como coleção comum.
 */
export async function ensureOpportunitiesTimeSeriesCollection(
  db: Db,
): Promise<TimeSeriesCollectionStatus> {
  const existing = (await db
    .listCollections({ name: OPPORTUNITIES_COLLECTION })
    .toArray()) as RawCollectionInfo[];

  if (existing.length > 0 && existing[0]) {
    return validateTimeSeriesInfo(existing[0], false);
  }

  await db.createCollection(OPPORTUNITIES_COLLECTION, {
    timeseries: {
      timeField: OPPORTUNITIES_TIME_FIELD,
      metaField: OPPORTUNITIES_META_FIELD,
      granularity: OPPORTUNITIES_GRANULARITY,
    },
  });

  const createdList = (await db
    .listCollections({ name: OPPORTUNITIES_COLLECTION })
    .toArray()) as RawCollectionInfo[];

  if (!createdList[0]) {
    throw new Error(
      `[MONGODB] Coleção "${OPPORTUNITIES_COLLECTION}" não foi encontrada após criação.`,
    );
  }

  return validateTimeSeriesInfo(createdList[0], true);
}

/**
 * Conecta ao MongoDB, valida conectividade via ping e garante a criação
 * nativa da coleção Time-Series antes de liberar a conexão.
 */
export async function connectMongo(): Promise<MongoConnection> {
  const client = new MongoClient(env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });

  try {
    await client.connect();
    const db = client.db(env.MONGO_DB_NAME);

    const pingResult = await db.admin().command({ ping: 1 });
    if (pingResult?.ok !== 1) {
      throw new Error('[MONGODB] Falha no comando ping do MongoDB.');
    }

    const opportunitiesCollection = await ensureOpportunitiesTimeSeriesCollection(db);
    await ensureOpportunitiesIndexes(db);

    return {
      client,
      db,
      opportunitiesCollection,
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Verifica se o MongoDB está respondendo ao comando ping.
 */
export async function pingMongo(db: Db): Promise<boolean> {
  try {
    const res = await db.admin().command({ ping: 1 });
    return res?.ok === 1;
  } catch {
    return false;
  }
}

/**
 * Encerra a conexão do cliente MongoDB.
 */
export async function disconnectMongo(client: MongoClient): Promise<void> {
  await client.close();
}
