import WebSocket, { type RawData } from 'ws';
import { createLogger, type Logger } from '../config/index.js';
import type { ExchangeConnectionState } from '../types/index.js';

/**
 * Converte payload bruto do `ws` (Buffer, ArrayBuffer ou Buffer[]) para string UTF-8.
 */
export function rawDataToString(raw: RawData): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  return Buffer.from(raw).toString('utf8');
}

export interface ReconnectingSocketOptions {
  name: string;
  url: string;
  inactivityTimeoutMs: number;
  maxConnectionLifetimeMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  watchdogIntervalMs?: number;
  onOpen?: (ws: WebSocket) => void;
  onMessage: (raw: RawData, ws: WebSocket) => void;
  onStateChange?: (state: ExchangeConnectionState) => void;
  onHeartbeatCheck?: (ws: WebSocket, silentMs: number) => void;
  onError?: (err: Error) => void;
}

export interface ReconnectingSocketMetrics {
  state: ExchangeConnectionState;
  connectedAt: number | null;
  lastMessageAt: number | null;
  reconnectAttempts: number;
  lastError: string | null;
}

/**
 * Wrapper resiliente sobre `ws` garantindo no máximo um socket ativo por conector,
 * detecção de conexões mudas (watchdog), reciclagem preventiva e reconexão com backoff exponencial + jitter.
 */
export class ReconnectingWebSocket {
  private readonly options: ReconnectingSocketOptions;
  private readonly log: Logger;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly watchdogIntervalMs: number;

  private ws: WebSocket | null = null;
  private state: ExchangeConnectionState = 'disconnected';
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;

  private backoffStep = 0;
  private reconnectAttempts = 0;
  private connectedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private lastError: string | null = null;

  constructor(options: ReconnectingSocketOptions) {
    this.options = options;
    this.log = createLogger('ws-client', { exchange: options.name });
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? 5000;
  }

  public start(): void {
    if (this.ws || this.state === 'connecting' || this.state === 'connected') {
      return;
    }

    this.stopped = false;
    this.startWatchdog();
    this.openConnection();
  }

  public stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearWatchdogTimer();

    if (this.ws) {
      const socketToClose = this.ws;
      this.ws = null;
      socketToClose.removeAllListeners();
      // Mantém listener mudo após remoção para evitar erro assíncrono durante fechamento forçado
      socketToClose.on('error', () => undefined);
      if (socketToClose.readyState === WebSocket.CONNECTING) {
        socketToClose.terminate();
      } else if (socketToClose.readyState === WebSocket.OPEN) {
        socketToClose.close(1000, 'client shutdown');
      }
    }

    this.setState('disconnected');
  }

  public forceReconnect(reason: string): void {
    if (this.stopped) {
      return;
    }

    this.log.warn({ reason }, 'Reconexão WebSocket acionada.');
    this.lastError = reason;
    this.clearReconnectTimer();

    if (this.ws) {
      const oldSocket = this.ws;
      this.ws = null;
      oldSocket.removeAllListeners();
      oldSocket.on('error', () => undefined);
      oldSocket.terminate();
    }

    this.scheduleReconnect();
  }

  public sendJson(payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  public getState(): ExchangeConnectionState {
    return this.state;
  }

  public getMetrics(): ReconnectingSocketMetrics {
    return {
      state: this.state,
      connectedAt: this.connectedAt,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    };
  }

  private openConnection(): void {
    if (this.stopped) {
      return;
    }

    this.clearReconnectTimer();
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const socket = new WebSocket(this.options.url);
    this.ws = socket;

    socket.on('open', () => {
      if (this.ws !== socket || this.stopped) {
        socket.terminate();
        return;
      }

      const now = Date.now();
      this.backoffStep = 0;
      this.connectedAt = now;
      this.lastMessageAt = now;
      this.lastError = null;
      this.setState('connected');

      try {
        this.options.onOpen?.(socket);
      } catch (error) {
        this.handleError(error);
      }
    });

    socket.on('message', (data: RawData) => {
      if (this.ws !== socket || this.stopped) {
        return;
      }

      this.lastMessageAt = Date.now();

      try {
        this.options.onMessage(data, socket);
      } catch (error) {
        this.handleError(error);
      }
    });

    socket.on('ping', () => {
      if (this.ws === socket) {
        this.lastMessageAt = Date.now();
      }
    });

    socket.on('pong', () => {
      if (this.ws === socket) {
        this.lastMessageAt = Date.now();
      }
    });

    socket.on('error', (err: Error) => {
      if (this.ws !== socket) {
        return;
      }
      this.handleError(err);
    });

    socket.on('close', (code: number, reasonBuf: Buffer) => {
      if (this.ws !== socket) {
        return;
      }

      socket.removeAllListeners();
      this.ws = null;

      if (this.stopped) {
        this.setState('disconnected');
        return;
      }

      const reason = reasonBuf.length > 0 ? reasonBuf.toString('utf8') : `code=${code}`;
      this.log.warn({ reason }, 'Conexão WebSocket fechada. Agendando reconexão.');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const exponentialDelay = Math.min(
      this.baseBackoffMs * 2 ** this.backoffStep,
      this.maxBackoffMs,
    );
    const jitterFactor = 0.75 + Math.random() * 0.5;
    const delayMs = Math.round(exponentialDelay * jitterFactor);

    this.backoffStep += 1;
    this.reconnectAttempts += 1;
    this.setState('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openConnection();
    }, delayMs);
  }

  private startWatchdog(): void {
    this.clearWatchdogTimer();
    this.watchdogTimer = setInterval(() => {
      if (this.stopped || this.state !== 'connected' || !this.ws || this.lastMessageAt === null) {
        return;
      }

      const now = Date.now();
      const silentMs = now - this.lastMessageAt;

      if (silentMs > this.options.inactivityTimeoutMs) {
        this.forceReconnect(`inatividade acima de ${this.options.inactivityTimeoutMs}ms`);
        return;
      }

      if (
        this.options.maxConnectionLifetimeMs &&
        this.connectedAt !== null &&
        now - this.connectedAt >= this.options.maxConnectionLifetimeMs
      ) {
        this.forceReconnect('reciclagem preventiva de ciclo máximo');
        return;
      }

      this.options.onHeartbeatCheck?.(this.ws, silentMs);
    }, this.watchdogIntervalMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearWatchdogTimer(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private handleError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.lastError = err.message;
    if (this.options.onError) {
      this.options.onError(err);
    } else {
      this.log.error({ err: err.message }, 'Erro no cliente WebSocket.');
    }
  }

  private setState(next: ExchangeConnectionState): void {
    if (this.state !== next) {
      this.state = next;
      this.options.onStateChange?.(next);
    }
  }
}
