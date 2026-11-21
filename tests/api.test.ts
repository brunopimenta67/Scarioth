import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  buildHealthReport,
  createScariothServer,
  type ScariothServer,
} from '../src/api/index.js';
import type { StoredArbitrageOpportunity } from '../src/database/index.js';
import type { ExchangeHealthSnapshot } from '../src/types/index.js';

function makeExchangeHealth(
  exchange: 'binance' | 'kraken',
  overrides: Partial<ExchangeHealthSnapshot> = {},
): ExchangeHealthSnapshot {
  return {
    exchange,
    state: 'connected',
    connectedAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_005_000,
    lastTickAt: 1_700_000_005_000,
    reconnectAttempts: 0,
    lastError: null,
    subscribedPairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    isStale: false,
    ...overrides,
  };
}

function makeStoredOpportunity(
  overrides: Partial<StoredArbitrageOpportunity> = {},
): StoredArbitrageOpportunity {
  return {
    id: '670000000000000000000001',
    timestamp: new Date('2026-11-21T20:00:00.000Z'),
    pair: 'BTCUSDT',
    buyExchange: 'binance',
    sellExchange: 'kraken',
    buyPrice: 60000,
    sellPrice: 60050,
    spreadAbsolute: 50,
    spreadPercentage: (50 / 60000) * 100,
    ...overrides,
  };
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout aguardando mensagem WS')), 3000);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('Scarioth HTTP API e WebSocket Broadcaster', () => {
  const serversToClose: ScariothServer[] = [];

  afterEach(async () => {
    while (serversToClose.length > 0) {
      const server = serversToClose.pop();
      if (server) {
        await server.close();
      }
    }
  });

  describe('GET /api/opportunities', () => {
    it('retorna 200 com oportunidades e normaliza pair + limit', async () => {
      const findOpportunitiesMock = vi
        .fn()
        .mockResolvedValue([makeStoredOpportunity({ pair: 'BTCUSDT' })]);

      const server = await createScariothServer({
        findOpportunities: findOpportunitiesMock,
        getHealth: async (wsClients) =>
          buildHealthReport({
            pingRedis: async () => true,
            pingMongo: async () => true,
            getExchangesHealth: () => ({
              binance: makeExchangeHealth('binance'),
              kraken: makeExchangeHealth('kraken'),
            }),
            wsClients,
          }),
        monitoredPairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        minSpreadPercentage: 0.01,
      });
      serversToClose.push(server);

      const res = await server.app.inject({
        method: 'GET',
        url: '/api/opportunities?pair=btcusdt&limit=10',
      });

      expect(res.statusCode).toBe(200);
      expect(findOpportunitiesMock).toHaveBeenCalledWith({
        pair: 'BTCUSDT',
        limit: 10,
      });

      const body = res.json() as {
        count: number;
        filters: { pair: string | null; limit: number };
        data: Array<{ id: string; timestamp: string; pair: string }>;
      };
      expect(body.count).toBe(1);
      expect(body.filters).toEqual({ pair: 'BTCUSDT', limit: 10 });
      expect(body.data[0]?.timestamp).toBe('2026-11-21T20:00:00.000Z');
    });

    it('rejeita parâmetros inválidos com status 400', async () => {
      const findOpportunitiesMock = vi.fn().mockResolvedValue([]);
      const server = await createScariothServer({
        findOpportunities: findOpportunitiesMock,
        getHealth: async () => ({ report: {} as never, httpStatusCode: 200 }),
        monitoredPairs: ['BTCUSDT'],
        minSpreadPercentage: 0.01,
      });
      serversToClose.push(server);

      const invalidUrls = [
        '/api/opportunities?limit=-5',
        '/api/opportunities?limit=abc',
        '/api/opportunities?limit=999',
        '/api/opportunities?pair=AB',
        '/api/opportunities?from=invalido',
        '/api/opportunities?from=2026-11-22T00:00:00Z&to=2026-11-21T00:00:00Z',
      ];

      for (const url of invalidUrls) {
        const res = await server.app.inject({ method: 'GET', url });
        expect(res.statusCode, `Esperado 400 para ${url}`).toBe(400);
      }

      expect(findOpportunitiesMock).not.toHaveBeenCalled();
    });

    it('retorna 500 genérico quando repositório falha, sem vazar detalhes internos', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const server = await createScariothServer({
        findOpportunities: async () => {
          throw new Error('MongoNetworkError internal-secret-cluster-uri');
        },
        getHealth: async () => ({ report: {} as never, httpStatusCode: 200 }),
        monitoredPairs: ['BTCUSDT'],
        minSpreadPercentage: 0.01,
      });
      serversToClose.push(server);

      const res = await server.app.inject({
        method: 'GET',
        url: '/api/opportunities',
      });

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('MongoNetworkError');
      expect(res.body).not.toContain('internal-secret-cluster-uri');
      errSpy.mockRestore();
    });
  });

  describe('GET /health', () => {
    it('retorna 200 (ok), 200 (degraded) e 503 (down) conforme dependências e exchanges', async () => {
      let redisOk = true;
      let mongoOk = true;
      let krakenState: ExchangeHealthSnapshot['state'] = 'connected';
      let krakenStale = false;

      const server = await createScariothServer({
        findOpportunities: async () => [],
        getHealth: async (wsClients) =>
          buildHealthReport({
            pingRedis: async () => redisOk,
            pingMongo: async () => mongoOk,
            getExchangesHealth: () => ({
              binance: makeExchangeHealth('binance'),
              kraken: makeExchangeHealth('kraken', {
                state: krakenState,
                isStale: krakenStale,
              }),
            }),
            wsClients,
          }),
        monitoredPairs: ['BTCUSDT'],
        minSpreadPercentage: 0.01,
      });
      serversToClose.push(server);

      const okRes = await server.app.inject({ method: 'GET', url: '/health' });
      expect(okRes.statusCode).toBe(200);
      expect((okRes.json() as { status: string }).status).toBe('ok');

      krakenState = 'reconnecting';
      krakenStale = true;
      const degradedRes = await server.app.inject({ method: 'GET', url: '/health' });
      expect(degradedRes.statusCode).toBe(200);
      expect((degradedRes.json() as { status: string }).status).toBe('degraded');

      redisOk = false;
      const downRes = await server.app.inject({ method: 'GET', url: '/health' });
      expect(downRes.statusCode).toBe(503);
      expect((downRes.json() as { status: string }).status).toBe('down');
    });
  });

  describe('WsBroadcaster (/ws)', () => {
    it('envia welcome, transmite opportunity e market_snapshot e limpa cliente ao desconectar', async () => {
      const server = await createScariothServer({
        findOpportunities: async () => [],
        getHealth: async (wsClients) =>
          buildHealthReport({
            pingRedis: async () => true,
            pingMongo: async () => true,
            getExchangesHealth: () => ({
              binance: makeExchangeHealth('binance'),
              kraken: makeExchangeHealth('kraken'),
            }),
            wsClients,
          }),
        monitoredPairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        minSpreadPercentage: 0.01,
      });
      serversToClose.push(server);

      const { wsUrl } = await server.start(0, '127.0.0.1');
      const client = new WebSocket(wsUrl);

      const welcomePromise = waitForMessage(client);
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });

      const welcomeMsg = await welcomePromise;
      expect(welcomeMsg.type).toBe('welcome');
      expect(welcomeMsg.monitoredPairs).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
      expect(server.getConnectedClientsCount()).toBe(1);

      const oppPromise = waitForMessage(client);
      const sentOppCount = server.broadcastOpportunity(makeStoredOpportunity());
      expect(sentOppCount).toBe(1);

      const oppMsg = await oppPromise;
      expect(oppMsg.type).toBe('opportunity');
      expect((oppMsg.data as { pair: string }).pair).toBe('BTCUSDT');

      const snapshotPromise = waitForMessage(client);
      const sentSnapCount = server.broadcastMarketSnapshot({
        type: 'market_snapshot',
        timestamp: new Date().toISOString(),
        exchanges: {
          binance: { state: 'connected', isStale: false, reconnectAttempts: 0 },
          kraken: { state: 'connected', isStale: false, reconnectAttempts: 0 },
        },
        pairs: [
          {
            pair: 'BTCUSDT',
            binance: { bid: 60000, ask: 60001, ageMs: 50 },
            kraken: { bid: 60010, ask: 60015, ageMs: 80 },
            isFresh: true,
            bestSpreadPercentage: 0.015,
            bestDirection: { buyExchange: 'binance', sellExchange: 'kraken' },
          },
        ],
      });
      expect(sentSnapCount).toBe(1);

      const snapMsg = await snapshotPromise;
      expect(snapMsg.type).toBe('market_snapshot');

      client.close();
      await new Promise<void>((resolve) => {
        client.once('close', () => setTimeout(resolve, 30));
      });

      expect(server.getConnectedClientsCount()).toBe(0);
    });
  });
});
