import pino, { type Logger } from 'pino';

export type { Logger };

const VALID_LOG_LEVELS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

function resolveInitialLevel(): string {
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    return 'silent';
  }

  const rawLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (rawLevel && VALID_LOG_LEVELS.has(rawLevel)) {
    return rawLevel;
  }

  return 'info';
}

const isTestEnvironment =
  process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

const usePrettyTransport =
  !isTestEnvironment &&
  process.env.NODE_ENV !== 'production' &&
  process.env.LOG_FORMAT !== 'json';

export const logger: Logger = pino({
  level: resolveInitialLevel(),
  base: { service: 'scarioth' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(usePrettyTransport
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,service',
          },
        },
      }
    : {}),
});

/**
 * Cria um logger filho contextualizado por componente (ex.: "ingestion", "engine", "api").
 */
export function createLogger(
  component: string,
  extra?: Record<string, unknown>,
): Logger {
  return logger.child({ component, ...extra });
}
