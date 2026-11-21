import {
  formatLocalTime,
  formatPairDisplay,
  formatPrice,
  formatSpreadAbsolute,
  formatSpreadPercentage,
  mergeOpportunities,
} from './formatters.js';
import type {
  ExchangeConnectionState,
  ExchangeName,
  MarketPairSnapshot,
  MarketSnapshotMessage,
  OpportunitiesApiResponse,
  OpportunityRow,
  ServerWsMessage,
} from './types.js';

type PanelWsState = 'connecting' | 'connected' | 'reconnecting';

interface DashboardState {
  selectedPair: string;
  selectedLimit: number;
  opportunities: OpportunityRow[];
  liveSessionCount: number;
  minSpreadPercentage: number | null;
  isLoadingHistory: boolean;
  historyError: string | null;
  wsState: PanelWsState;
  reconnectAttempts: number;
}

const state: DashboardState = {
  selectedPair: '',
  selectedLimit: 50,
  opportunities: [],
  liveSessionCount: 0,
  minSpreadPercentage: null,
  isLoadingHistory: false,
  historyError: null,
  wsState: 'connecting',
  reconnectAttempts: 0,
};

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let activeAbortController: AbortController | null = null;

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Elemento obrigatório #${id} não encontrado no DOM.`);
  }
  return el as T;
}

function setBadgeStatus(badgeEl: HTMLElement, dotClass: string, labelText: string): void {
  const dot = badgeEl.querySelector('[data-dot]');
  const label = badgeEl.querySelector('[data-label]');
  if (dot) {
    dot.className = `h-2 w-2 rounded-full ${dotClass}`;
  }
  if (label) {
    label.textContent = labelText;
  }
}

function renderWsBadge(): void {
  const badge = requireElement('ws-status-badge');
  if (state.wsState === 'connected') {
    setBadgeStatus(badge, 'bg-emerald-400', 'Painel WS: Ao vivo');
  } else if (state.wsState === 'reconnecting') {
    setBadgeStatus(
      badge,
      'bg-amber-400 animate-pulse',
      `Painel WS: Reconectando (${state.reconnectAttempts})...`,
    );
  } else {
    setBadgeStatus(badge, 'bg-amber-400', 'Painel WS: Conectando...');
  }
}

function renderExchangeBadge(
  elementId: string,
  title: string,
  info: { state: ExchangeConnectionState; isStale: boolean },
): void {
  const badge = requireElement(elementId);
  if (info.state === 'connected' && !info.isStale) {
    setBadgeStatus(badge, 'bg-emerald-400', `${title}: Online`);
    return;
  }
  if (info.state === 'connected' && info.isStale) {
    setBadgeStatus(badge, 'bg-amber-400', `${title}: Stale`);
    return;
  }
  if (info.state === 'reconnecting' || info.state === 'connecting') {
    setBadgeStatus(badge, 'bg-amber-400 animate-pulse', `${title}: Reconectando`);
    return;
  }
  setBadgeStatus(badge, 'bg-rose-500', `${title}: Offline`);
}

function createExchangeQuoteRow(
  label: string,
  quote: { bid: number; ask: number; ageMs: number } | null,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'flex items-center justify-between rounded-lg bg-slate-950/70 px-3 py-2 text-xs';

  const left = document.createElement('div');
  const nameEl = document.createElement('span');
  nameEl.className = 'font-semibold text-slate-200';
  nameEl.textContent = label;

  const ageEl = document.createElement('span');
  ageEl.className = 'ml-2 text-[11px] text-slate-500';
  ageEl.textContent = quote ? `${quote.ageMs}ms` : 'sem dados';

  left.append(nameEl, ageEl);

  const right = document.createElement('div');
  right.className = 'font-mono text-right tabular-nums text-slate-300';
  right.textContent = quote
    ? `${formatPrice(quote.bid)} / ${formatPrice(quote.ask)}`
    : '-- / --';

  row.append(left, right);
  return row;
}

function renderMarketCards(pairs: readonly MarketPairSnapshot[]): void {
  const container = requireElement('market-cards');
  container.replaceChildren();

  if (pairs.length === 0) {
    const emptyCard = document.createElement('div');
    emptyCard.className =
      'rounded-xl border border-slate-800 bg-slate-900/70 p-5 text-sm text-slate-400';
    emptyCard.textContent = 'Nenhum par monitorado disponível no momento.';
    container.append(emptyCard);
    return;
  }

  for (const item of pairs) {
    const card = document.createElement('article');
    card.className =
      'flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/75 p-5 shadow-sm';

    // Topo do card: Nome do par + selo Fresco/Stale
    const top = document.createElement('div');
    top.className = 'flex items-center justify-between';

    const title = document.createElement('h3');
    title.className = 'text-base font-bold tracking-tight text-white';
    title.textContent = formatPairDisplay(item.pair);

    const freshnessBadge = document.createElement('span');
    freshnessBadge.className = item.isFresh
      ? 'rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300'
      : 'rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300';
    freshnessBadge.textContent = item.isFresh
      ? 'Fresco'
      : `Aguardando (${item.freshnessReason ?? 'stale'})`;

    top.append(title, freshnessBadge);

    // Linhas Binance e Kraken
    const quotesBox = document.createElement('div');
    quotesBox.className = 'flex flex-col gap-2';
    quotesBox.append(
      createExchangeQuoteRow('Binance', item.binance),
      createExchangeQuoteRow('Kraken', item.kraken),
    );

    // Rodapé do card: Melhor spread e direção
    const footer = document.createElement('div');
    footer.className = 'flex items-center justify-between border-t border-slate-800 pt-3 text-xs';

    const dirLabel = document.createElement('span');
    dirLabel.className = 'text-slate-400';
    dirLabel.textContent = item.bestDirection
      ? `${item.bestDirection.buyExchange.toUpperCase()} -> ${item.bestDirection.sellExchange.toUpperCase()}`
      : 'Melhor direção: --';

    const spreadEl = document.createElement('span');
    const spreadValue = item.bestSpreadPercentage;
    const isPositive = spreadValue !== null && spreadValue > 0;
    spreadEl.className = isPositive
      ? 'font-mono text-sm font-bold tabular-nums text-emerald-400'
      : 'font-mono text-sm font-semibold tabular-nums text-slate-300';
    spreadEl.textContent =
      spreadValue !== null ? formatSpreadPercentage(spreadValue) : '--';

    footer.append(dirLabel, spreadEl);

    card.append(top, quotesBox, footer);
    container.append(card);
  }
}

function renderKpis(): void {
  requireElement('kpi-live-count').textContent = String(state.liveSessionCount);
  requireElement('kpi-history-count').textContent = String(state.opportunities.length);

  const bestSpreadEl = requireElement('kpi-best-spread');
  if (state.opportunities.length === 0) {
    bestSpreadEl.textContent = '--';
  } else {
    const maxSpread = Math.max(...state.opportunities.map((o) => o.spreadPercentage));
    bestSpreadEl.textContent = formatSpreadPercentage(maxSpread);
  }

  const minSpreadEl = requireElement('kpi-min-spread');
  minSpreadEl.textContent =
    state.minSpreadPercentage !== null
      ? `${state.minSpreadPercentage.toFixed(2)}%`
      : '--';
}

function formatExchangeLabel(exchange: ExchangeName): string {
  return exchange === 'binance' ? 'Binance' : 'Kraken';
}

function renderOpportunitiesTable(): void {
  const tbody = requireElement('opportunities-tbody');
  const emptyState = requireElement('empty-state');
  const loadingEl = requireElement('loading-indicator');
  const errorBanner = requireElement('error-banner');

  loadingEl.classList.toggle('hidden', !state.isLoadingHistory);

  if (state.historyError) {
    errorBanner.textContent = state.historyError;
    errorBanner.classList.remove('hidden');
  } else {
    errorBanner.classList.add('hidden');
  }

  tbody.replaceChildren();

  if (state.opportunities.length === 0) {
    emptyState.classList.toggle('hidden', state.isLoadingHistory);
    renderKpis();
    return;
  }

  emptyState.classList.add('hidden');

  for (const row of state.opportunities) {
    const tr = document.createElement('tr');
    tr.className = row.isNew ? 'animate-row-flash' : 'hover:bg-slate-800/40 transition-colors';

    const tdTime = document.createElement('td');
    tdTime.className = 'whitespace-nowrap py-3 pr-4 font-mono text-xs text-slate-400';
    tdTime.textContent = formatLocalTime(row.timestamp);

    const tdPair = document.createElement('td');
    tdPair.className = 'whitespace-nowrap py-3 pr-4 font-semibold text-white';
    tdPair.textContent = formatPairDisplay(row.pair);

    const tdRoute = document.createElement('td');
    tdRoute.className = 'whitespace-nowrap py-3 pr-4 text-xs text-slate-300';
    tdRoute.textContent = `${formatExchangeLabel(row.buyExchange)} -> ${formatExchangeLabel(row.sellExchange)}`;

    const tdBuy = document.createElement('td');
    tdBuy.className = 'whitespace-nowrap py-3 pr-4 text-right font-mono text-xs tabular-nums text-slate-300';
    tdBuy.textContent = formatPrice(row.buyPrice);

    const tdSell = document.createElement('td');
    tdSell.className = 'whitespace-nowrap py-3 pr-4 text-right font-mono text-xs tabular-nums text-slate-300';
    tdSell.textContent = formatPrice(row.sellPrice);

    const tdAbs = document.createElement('td');
    tdAbs.className = 'whitespace-nowrap py-3 pr-4 text-right font-mono text-xs tabular-nums text-emerald-300';
    tdAbs.textContent = formatSpreadAbsolute(row.spreadAbsolute);

    const tdPct = document.createElement('td');
    tdPct.className =
      'whitespace-nowrap py-3 pr-4 text-right font-mono text-xs font-bold tabular-nums text-emerald-400';
    tdPct.textContent = formatSpreadPercentage(row.spreadPercentage);

    const tdSource = document.createElement('td');
    tdSource.className = 'whitespace-nowrap py-3';
    const badge = document.createElement('span');
    badge.className =
      row.source === 'live'
        ? 'rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300'
        : 'rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] font-medium text-slate-300';
    badge.textContent = row.source === 'live' ? 'Ao vivo' : 'Histórico';
    tdSource.append(badge);

    tr.append(tdTime, tdPair, tdRoute, tdBuy, tdSell, tdAbs, tdPct, tdSource);
    tbody.append(tr);
  }

  renderKpis();
}

function updateFilterButtonsStyle(): void {
  const container = requireElement('pair-filters');
  const buttons = container.querySelectorAll<HTMLButtonElement>('button[data-pair]');

  for (const btn of buttons) {
    const pair = btn.dataset.pair ?? '';
    const isActive = pair === state.selectedPair;
    btn.className = isActive
      ? 'rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition'
      : 'rounded-md px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white transition';
  }
}

async function loadHistory(replaceExisting: boolean): Promise<void> {
  if (activeAbortController) {
    activeAbortController.abort();
  }

  const controller = new AbortController();
  activeAbortController = controller;

  state.isLoadingHistory = true;
  state.historyError = null;
  if (replaceExisting) {
    state.opportunities = [];
  }
  renderOpportunitiesTable();

  const params = new URLSearchParams({
    limit: String(state.selectedLimit),
  });
  if (state.selectedPair) {
    params.set('pair', state.selectedPair);
  }

  try {
    const response = await fetch(`/api/opportunities?${params.toString()}`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Servidor retornou status ${response.status}`);
    }

    const body = (await response.json()) as OpportunitiesApiResponse;
    const historyRows: OpportunityRow[] = body.data.map((item) => ({
      ...item,
      source: 'history',
    }));

    state.opportunities = mergeOpportunities(
      historyRows,
      replaceExisting ? [] : state.opportunities,
      state.selectedLimit,
    );
    state.historyError = null;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return;
    }
    state.historyError =
      'Não foi possível carregar o histórico do MongoDB. Verifique se o backend está online e tente novamente.';
  } finally {
    if (activeAbortController === controller) {
      activeAbortController = null;
      state.isLoadingHistory = false;
      renderOpportunitiesTable();
    }
  }
}

function handleMarketSnapshot(msg: MarketSnapshotMessage): void {
  renderExchangeBadge('binance-status-badge', 'Binance', msg.exchanges.binance);
  renderExchangeBadge('kraken-status-badge', 'Kraken', msg.exchanges.kraken);
  requireElement('last-snapshot-time').textContent =
    `Atualizado às ${formatLocalTime(msg.timestamp)}`;
  renderMarketCards(msg.pairs);
}

function handleWsMessage(rawData: string): void {
  let message: ServerWsMessage;
  try {
    message = JSON.parse(rawData) as ServerWsMessage;
  } catch {
    return;
  }

  if (message.type === 'welcome') {
    state.minSpreadPercentage = message.minSpreadPercentage;
    renderKpis();
    return;
  }

  if (message.type === 'market_snapshot') {
    handleMarketSnapshot(message);
    return;
  }

  if (message.type === 'opportunity') {
    state.liveSessionCount += 1;

    const matchesFilter =
      !state.selectedPair || message.data.pair === state.selectedPair;

    if (matchesFilter) {
      const liveRow: OpportunityRow = {
        ...message.data,
        source: 'live',
        isNew: true,
      };
      // Remove marcação isNew de linhas antigas antes de inserir a nova
      const existingWithoutFlash = state.opportunities.map((row) =>
        row.isNew ? { ...row, isNew: false } : row,
      );
      state.opportunities = mergeOpportunities(
        [liveRow],
        existingWithoutFlash,
        state.selectedLimit,
      );
      renderOpportunitiesTable();
    } else {
      renderKpis();
    }
  }
}

function scheduleWsReconnect(): void {
  if (reconnectTimer !== null) {
    return;
  }

  const delayMs = Math.min(1000 * 2 ** state.reconnectAttempts, 15_000);
  state.reconnectAttempts += 1;
  state.wsState = 'reconnecting';
  renderWsBadge();

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delayMs);
}

function connectWebSocket(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  state.wsState = state.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
  renderWsBadge();

  const socket = new WebSocket(wsUrl);
  ws = socket;

  socket.addEventListener('open', () => {
    if (ws !== socket) {
      return;
    }
    const wasReconnecting = state.reconnectAttempts > 0;
    state.reconnectAttempts = 0;
    state.wsState = 'connected';
    renderWsBadge();

    if (wasReconnecting) {
      void loadHistory(false);
    }
  });

  socket.addEventListener('message', (event: MessageEvent<string>) => {
    if (ws !== socket || typeof event.data !== 'string') {
      return;
    }
    handleWsMessage(event.data);
  });

  socket.addEventListener('close', () => {
    if (ws !== socket) {
      return;
    }
    ws = null;
    scheduleWsReconnect();
  });

  socket.addEventListener('error', () => {
    // O evento close subsequente dispara a reconexão com backoff
  });
}

function bindUiEvents(): void {
  const filtersContainer = requireElement('pair-filters');
  filtersContainer.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest<HTMLButtonElement>('button[data-pair]');
    if (!button) {
      return;
    }

    const nextPair = button.dataset.pair ?? '';
    if (nextPair === state.selectedPair) {
      return;
    }

    state.selectedPair = nextPair;
    updateFilterButtonsStyle();
    void loadHistory(true);
  });

  const limitSelect = requireElement<HTMLSelectElement>('limit-select');
  limitSelect.addEventListener('change', () => {
    const nextLimit = Number(limitSelect.value);
    if (Number.isFinite(nextLimit) && nextLimit > 0) {
      state.selectedLimit = nextLimit;
      void loadHistory(true);
    }
  });

  const refreshBtn = requireElement<HTMLButtonElement>('refresh-btn');
  refreshBtn.addEventListener('click', () => {
    void loadHistory(false);
  });
}

function init(): void {
  bindUiEvents();
  updateFilterButtonsStyle();
  renderWsBadge();
  void loadHistory(true);
  connectWebSocket();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
