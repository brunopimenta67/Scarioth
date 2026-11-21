import { Redis } from 'ioredis';
import { env } from '../config/index.js';

const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Cria uma instância configurada do cliente Redis com tratamento obrigatório
 * de eventos de erro para evitar quedas por Unhandled 'error' event.
 */
export function createRedisClient(): Redis {
  const client = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 3,
    retryStrategy(times: number): number | null {
      if (times > MAX_RECONNECT_ATTEMPTS) {
        console.error('[REDIS] Limite de tentativas de reconexão atingido.');
        return null;
      }
      return Math.min(times * 200, 2000);
    },
  });

  client.on('error', (err: Error) => {
    console.error(`[REDIS] Erro de conexão: ${err.message}`);
  });

  return client;
}

/**
 * Abre conexão com o Redis e valida com PING antes de liberar o cliente.
 */
export async function connectRedis(): Promise<Redis> {
  const client = createRedisClient();

  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') {
      throw new Error(`Resposta inesperada ao PING do Redis: "${pong}"`);
    }
    return client;
  } catch (error) {
    client.disconnect();
    throw error;
  }
}

/**
 * Verifica se o cliente Redis está respondendo a PING.
 */
export async function pingRedis(client: Redis): Promise<boolean> {
  try {
    const result = await client.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Encerra a conexão Redis de forma ordenada, com fallback para desconexão imediata.
 */
export async function disconnectRedis(client: Redis): Promise<void> {
  if (client.status === 'end') {
    return;
  }

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
