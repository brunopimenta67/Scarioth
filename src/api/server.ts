import fs from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createLogger } from '../config/index.js';
import {
  DEFAULT_OPPORTUNITIES_LIMIT,
  MAX_OPPORTUNITIES_LIMIT,
  type FindOpportunitiesQuery,
  type StoredArbitrageOpportunity,
} from '../database/index.js';
import type { ArbitrageOpportunity } from '../types/index.js';
import type { HealthReport } from './health.js';
import { WsBroadcaster, type MarketSnapshotMessage } from './wsBroadcaster.js';

const log = createLogger('api');

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  return value;
}, z.string().optional());

export const OpportunitiesQuerySchema = z
  .object({
    pair: optionalNonEmptyString
      .transform((val) => (val !== undefined ? val.toUpperCase() : undefined))
      .refine(
        (val) => val === undefined || /^[A-Z0-9]{4,20}$/.test(val),
        'Parâmetro "pair" deve conter de 4 a 20 caracteres alfanuméricos',
      ),
    limit: optionalNonEmptyString
      .refine(
        (val) => val === undefined || /^\d+$/.test(val),
        'Parâmetro "limit" deve ser um número inteiro positivo',
      )
      .transform((val) => (val !== undefined ? Number(val) : undefined))
      .refine(
        (val) => val === undefined || (val >= 1 && val <= MAX_OPPORTUNITIES_LIMIT),
        `Parâmetro "limit" deve estar entre 1 e ${MAX_OPPORTUNITIES_LIMIT}`,
      ),
    from: optionalNonEmptyString
      .refine(
        (val) => val === undefined || !Number.isNaN(Date.parse(val)),
        'Parâmetro "from" deve ser uma data válida (ex.: ISO 8601)',
      )
      .transform((val) => (val !== undefined ? new Date(val) : undefined)),
    to: optionalNonEmptyString
      .refine(
        (val) => val === undefined || !Number.isNaN(Date.parse(val)),
        'Parâmetro "to" deve ser uma data válida (ex.: ISO 8601)',
      )
      .transform((val) => (val !== undefined ? new Date(val) : undefined)),
  })
  .refine((data) => !(data.from && data.to && data.from > data.to), {
    message: 'Parâmetro "from" não pode ser posterior a "to"',
    path: ['from'],
  });

export interface ScariothServerOptions {
  findOpportunities: (query: FindOpportunitiesQuery) => Promise<StoredArbitrageOpportunity[]>;
  getHealth: (wsClients: number) => Promise<{ report: HealthReport; httpStatusCode: 200 | 503 }>;
  monitoredPairs: readonly string[];
  minSpreadPercentage: number;
  publicDir?: string;
}

export interface ScariothServer {
  app: FastifyInstance;
  wsBroadcaster: WsBroadcaster;
  start: (port: number, host?: string) => Promise<{ url: string; wsUrl: string; port: number }>;
  close: () => Promise<void>;
  broadcastOpportunity: (opportunity: ArbitrageOpportunity) => number;
  broadcastMarketSnapshot: (snapshot: MarketSnapshotMessage) => number;
  getConnectedClientsCount: () => number;
}

/**
 * Cria o servidor HTTP (Fastify) integrado ao servidor WebSocket (`ws`) na mesma porta.
 */
export async function createScariothServer(
  options: ScariothServerOptions,
): Promise<ScariothServer> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  const publicDir = options.publicDir ?? path.resolve(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      wildcard: false,
    });
  }

  const wsBroadcaster = new WsBroadcaster({
    server: app.server,
    path: '/ws',
    monitoredPairs: options.monitoredPairs,
    minSpreadPercentage: options.minSpreadPercentage,
  });

  app.get('/api/opportunities', async (request, reply) => {
    const parsed = OpportunitiesQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'query',
        message: issue.message,
      }));
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Parâmetros de consulta inválidos.',
        details,
      });
    }

    const query: FindOpportunitiesQuery = {
      ...(parsed.data.pair !== undefined ? { pair: parsed.data.pair } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
      ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
    };

    try {
      const records = await options.findOpportunities(query);
      const data = records.map((item) => ({
        ...item,
        timestamp: item.timestamp.toISOString(),
      }));

      return reply.status(200).send({
        count: data.length,
        filters: {
          pair: parsed.data.pair ?? null,
          limit: parsed.data.limit ?? DEFAULT_OPPORTUNITIES_LIMIT,
          ...(parsed.data.from ? { from: parsed.data.from.toISOString() } : {}),
          ...(parsed.data.to ? { to: parsed.data.to.toISOString() } : {}),
        },
        data,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ err: msg }, 'Erro ao consultar oportunidades.');
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Falha ao consultar oportunidades.',
      });
    }
  });

  app.get('/health', async (_request, reply) => {
    try {
      const { report, httpStatusCode } = await options.getHealth(
        wsBroadcaster.getConnectedClientsCount(),
      );
      return reply.status(httpStatusCode).send(report);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ err: msg }, 'Erro ao gerar health check.');
      return reply.status(503).send({
        status: 'down',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return {
    app,
    wsBroadcaster,
    start: async (port: number, host: string = '0.0.0.0') => {
      await app.listen({ port, host });
      const address = app.server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return {
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        wsUrl: `ws://127.0.0.1:${actualPort}/ws`,
      };
    },
    close: async () => {
      await wsBroadcaster.close();
      await app.close();
    },
    broadcastOpportunity: (opportunity: ArbitrageOpportunity) =>
      wsBroadcaster.broadcastOpportunity(opportunity),
    broadcastMarketSnapshot: (snapshot: MarketSnapshotMessage) =>
      wsBroadcaster.broadcastMarketSnapshot(snapshot),
    getConnectedClientsCount: () => wsBroadcaster.getConnectedClientsCount(),
  };
}
