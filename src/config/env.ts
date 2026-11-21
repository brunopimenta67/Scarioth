import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Converte string de variável de ambiente em número antes da validação Zod,
 * evitando que strings vazias ("") sejam coagidas silenciosamente para 0.
 */
function requiredNumber(schema: z.ZodNumber, defaultValue?: number) {
  return z.preprocess((value) => {
    if (value === undefined && defaultValue !== undefined) {
      return defaultValue;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') {
        return undefined;
      }
      return Number(trimmed);
    }
    return value;
  }, schema);
}

const wssUrlSchema = z
  .string({ error: 'URL WebSocket obrigatória' })
  .trim()
  .min(1, 'URL WebSocket obrigatória')
  .transform((val) => val.replace(/\/+$/, ''))
  .refine((val) => {
    try {
      const parsed = new URL(val);
      return parsed.protocol === 'wss:' && parsed.hostname.length > 0;
    } catch {
      return false;
    }
  }, 'Deve ser uma URL wss:// válida');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: requiredNumber(
    z.number({ error: 'PORT deve ser um número válido' }).int().min(1).max(65535),
    3000,
  ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_HOST: z.string({ error: 'REDIS_HOST é obrigatório' }).trim().min(1, 'REDIS_HOST não pode ser vazio'),
  REDIS_PORT: requiredNumber(
    z.number({ error: 'REDIS_PORT deve ser um número válido' }).int().min(1).max(65535),
  ),
  REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((val) => {
      const trimmed = val?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : undefined;
    }),
  MONGO_URI: z
    .string({ error: 'MONGO_URI é obrigatória' })
    .trim()
    .min(1, 'MONGO_URI não pode ser vazia')
    .refine((val) => {
      if (!val.startsWith('mongodb://') && !val.startsWith('mongodb+srv://')) {
        return false;
      }
      try {
        const parsed = new URL(val);
        return parsed.hostname.length > 0;
      } catch {
        return false;
      }
    }, 'MONGO_URI deve ser uma URI válida iniciando com mongodb:// ou mongodb+srv://'),
  MONGO_DB_NAME: z
    .string({ error: 'MONGO_DB_NAME é obrigatório' })
    .trim()
    .min(1, 'MONGO_DB_NAME não pode ser vazio'),
  BINANCE_WS_BASE_URL: wssUrlSchema,
  KRAKEN_WS_URL: wssUrlSchema,
  MONITORED_PAIRS: z
    .string({ error: 'MONITORED_PAIRS é obrigatório' })
    .trim()
    .min(1, 'MONITORED_PAIRS deve conter ao menos um par')
    .transform((val) =>
      Array.from(
        new Set(
          val
            .split(',')
            .map((item) => item.trim().toUpperCase())
            .filter((item) => item.length > 0),
        ),
      ),
    )
    .refine((pairs) => pairs.length > 0, 'MONITORED_PAIRS deve conter ao menos um par válido'),
  MIN_SPREAD_PERCENTAGE: requiredNumber(
    z.number({ error: 'MIN_SPREAD_PERCENTAGE deve ser um número válido' }).finite().min(0),
  ),
  ARBITRAGE_LOCK_TTL_SECONDS: requiredNumber(
    z.number({ error: 'ARBITRAGE_LOCK_TTL_SECONDS deve ser um número válido' }).int().positive(),
  ),
  MAX_TICK_AGE_MS: requiredNumber(
    z.number({ error: 'MAX_TICK_AGE_MS deve ser um número válido' }).int().positive(),
  ),
});

export type AppConfig = Readonly<
  Omit<z.infer<typeof envSchema>, 'MONITORED_PAIRS'> & {
    MONITORED_PAIRS: readonly string[];
  }
>;

/**
 * Valida um dicionário de variáveis de ambiente sem efeitos colaterais de I/O.
 * Lança erro detalhado apenas com os nomes dos campos inválidos (sem expor segredos).
 */
export function parseEnv(rawEnv: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const field = issue.path.length > 0 ? issue.path.join('.') : 'env';
        return `  - ${field}: ${issue.message}`;
      })
      .join('\n');

    throw new Error(`Falha na validação das variáveis de ambiente:\n${details}`);
  }

  return Object.freeze({
    ...result.data,
    MONITORED_PAIRS: Object.freeze(result.data.MONITORED_PAIRS),
  });
}

/**
 * Carrega o arquivo .env (sem sobrescrever variáveis já definidas no shell)
 * e aplica validação fail-fast, abortando o processo em caso de erro.
 */
export function loadEnv(): AppConfig {
  dotenv.config({ quiet: true });

  try {
    return parseEnv(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido ao validar ambiente.';
    console.error(`[CONFIG][FAIL-FAST] ${message}`);
    process.exit(1);
  }
}

let cachedEnv: AppConfig | null = null;

/**
 * Retorna a configuração validada sob demanda (lazy initialization),
 * evitando falha fail-fast durante imports estáticos que não acessam `env`.
 */
export function getEnv(): AppConfig {
  if (!cachedEnv) {
    cachedEnv = loadEnv();
  }
  return cachedEnv;
}

export const env: AppConfig = new Proxy({} as AppConfig, {
  get(_target, prop) {
    return Reflect.get(getEnv(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(getEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(getEnv(), prop);
  },
  has(_target, prop) {
    return Reflect.has(getEnv(), prop);
  },
});
