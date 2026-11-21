import { createLogger } from './config/index.js';

export interface ShutdownSteps {
  clearTimers: () => void;
  stopIngestion: () => void;
  closeApiServer: () => Promise<void>;
  flushColdPath: () => Promise<void>;
  disconnectRedis: () => Promise<void>;
  disconnectMongo: () => Promise<void>;
}

export interface GracefulShutdownOptions {
  steps: ShutdownSteps;
  timeoutMs?: number;
  onExit?: (exitCode: number) => void;
}

/**
 * Cria coordenador idempotente de Graceful Shutdown executando a sequência
 * ordenada de encerramento com isolamento de falhas por etapa e timeout de segurança.
 */
export function createGracefulShutdown(
  options: GracefulShutdownOptions,
): (reason: string, initialExitCode?: number) => Promise<number> {
  const log = createLogger('shutdown');
  const timeoutMs = options.timeoutMs ?? 10_000;
  let activeShutdown: Promise<number> | null = null;

  return function shutdown(reason: string, initialExitCode: number = 0): Promise<number> {
    if (activeShutdown) {
      log.warn({ reason }, 'Shutdown já está em andamento; ignorando chamada duplicada.');
      return activeShutdown;
    }

    activeShutdown = (async (): Promise<number> => {
      let exitCode = initialExitCode;
      let finished = false;
      let safetyTimer: NodeJS.Timeout | undefined;

      log.info({ reason, initialExitCode }, 'Iniciando Graceful Shutdown ordenado.');

      if (timeoutMs > 0) {
        safetyTimer = setTimeout(() => {
          if (!finished) {
            finished = true;
            log.error(
              { timeoutMs },
              'Timeout de segurança do Graceful Shutdown atingido; forçando encerramento.',
            );
            options.onExit?.(1);
          }
        }, timeoutMs);
        safetyTimer.unref();
      }

      const runStep = async (stepName: string, action: () => void | Promise<void>): Promise<void> => {
        try {
          await action();
          log.debug({ step: stepName }, 'Etapa de shutdown concluída.');
        } catch (error) {
          exitCode = 1;
          const msg = error instanceof Error ? error.message : String(error);
          log.error({ step: stepName, err: msg }, 'Falha durante etapa de Graceful Shutdown.');
        }
      };

      try {
        await runStep('clearTimers', options.steps.clearTimers);
        await runStep('stopIngestion', options.steps.stopIngestion);
        await runStep('closeApiServer', options.steps.closeApiServer);
        await runStep('flushColdPath', options.steps.flushColdPath);
        await runStep('disconnectRedis', options.steps.disconnectRedis);
        await runStep('disconnectMongo', options.steps.disconnectMongo);

        if (!finished) {
          finished = true;
          log.info({ exitCode }, 'Graceful Shutdown concluído com segurança.');
          options.onExit?.(exitCode);
        }

        return exitCode;
      } finally {
        if (safetyTimer) {
          clearTimeout(safetyTimer);
        }
      }
    })();

    return activeShutdown;
  };
}
