import { describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown } from '../src/shutdown.js';

describe('createGracefulShutdown', () => {
  it('executa todas as etapas na ordem estrita e retorna exitCode 0', async () => {
    const order: string[] = [];
    const onExit = vi.fn();

    const shutdown = createGracefulShutdown({
      steps: {
        clearTimers: () => {
          order.push('clearTimers');
        },
        stopIngestion: () => {
          order.push('stopIngestion');
        },
        closeApiServer: async () => {
          order.push('closeApiServer');
        },
        flushColdPath: async () => {
          order.push('flushColdPath');
        },
        disconnectRedis: async () => {
          order.push('disconnectRedis');
        },
        disconnectMongo: async () => {
          order.push('disconnectMongo');
        },
      },
      onExit,
    });

    const code = await shutdown('SIGINT');

    expect(code).toBe(0);
    expect(order).toEqual([
      'clearTimers',
      'stopIngestion',
      'closeApiServer',
      'flushColdPath',
      'disconnectRedis',
      'disconnectMongo',
    ]);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('é idempotente quando chamado múltiplas vezes simultaneamente', async () => {
    const stopIngestion = vi.fn();
    const disconnectRedis = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    );
    const onExit = vi.fn();

    const shutdown = createGracefulShutdown({
      steps: {
        clearTimers: vi.fn(),
        stopIngestion,
        closeApiServer: vi.fn().mockResolvedValue(undefined),
        flushColdPath: vi.fn().mockResolvedValue(undefined),
        disconnectRedis,
        disconnectMongo: vi.fn().mockResolvedValue(undefined),
      },
      onExit,
    });

    const [code1, code2] = await Promise.all([shutdown('SIGINT'), shutdown('SIGTERM')]);

    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(stopIngestion).toHaveBeenCalledTimes(1);
    expect(disconnectRedis).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('continua fechando as demais dependências mesmo se uma etapa falhar e retorna exitCode 1', async () => {
    const flushColdPath = vi.fn().mockResolvedValue(undefined);
    const disconnectRedis = vi.fn().mockResolvedValue(undefined);
    const disconnectMongo = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();

    const shutdown = createGracefulShutdown({
      steps: {
        clearTimers: vi.fn(),
        stopIngestion: vi.fn(),
        closeApiServer: vi.fn().mockRejectedValue(new Error('erro simulado ao fechar servidor')),
        flushColdPath,
        disconnectRedis,
        disconnectMongo,
      },
      onExit,
    });

    const code = await shutdown('SIGTERM');

    expect(code).toBe(1);
    expect(flushColdPath).toHaveBeenCalledTimes(1);
    expect(disconnectRedis).toHaveBeenCalledTimes(1);
    expect(disconnectMongo).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
