export {
  OPPORTUNITIES_COLLECTION,
  OPPORTUNITIES_GRANULARITY,
  OPPORTUNITIES_META_FIELD,
  OPPORTUNITIES_TIME_FIELD,
  connectMongo,
  disconnectMongo,
  ensureOpportunitiesTimeSeriesCollection,
  pingMongo,
} from './mongo.js';
export type { MongoConnection, TimeSeriesCollectionStatus } from './mongo.js';
