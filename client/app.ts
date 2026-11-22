import {
  formatCoinName,
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
type ExchangeFilter = 'all' | ExchangeName;

interface CurvePathEntry {
  path: SVGPathElement;
  pulse: SVGCircleElement;
  active: boolean;
  length: number;
  offset: number;
  speed: number;
}

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
  activeExchangeFilter: ExchangeFilter;
  monitoredPairs: string[];
}

const DEFAULT_PAIRS: readonly string[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const SVG_NS = 'http://www.w3.org/2000/svg';

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
  activeExchangeFilter: 'all',
  monitoredPairs: [...DEFAULT_PAIRS],
};

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let activeAbortController: AbortController | null = null;
let renderedArcPairsKey = DEFAULT_PAIRS.join(',');
let curveEntries: CurvePathEntry[] = [];
let pulseLoopStarted = false;
let lastPulseTimestamp = 0;
const lastQuoteBids = new Map<string, number>();
const flashTimers = new Map<string, number>();

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
    setBadgeStatus(badge, 'bg-neutral-200', 'Painel WS: Ao vivo');
  } else if (state.wsState === 'reconnecting') {
    setBadgeStatus(
      badge,
      'bg-neutral-400 animate-pulse',
      `Painel WS: Reconectando (${state.reconnectAttempts})...`,
    );
  } else {
    setBadgeStatus(badge, 'bg-neutral-500', 'Painel WS: Conectando...');
  }
}

function getCrescentMarginClass(index: number, total: number): string {
  if (total <= 2) {
    return 'md:mr-0';
  }
  const half = (total - 1) / 2;
  const dist = Math.abs(index - half) / half;
  if (dist >= 0.72) {
    return 'md:mr-10 lg:mr-14';
  }
  if (dist >= 0.28) {
    return 'md:mr-4 lg:mr-5';
  }
  return 'md:mr-0';
}

function createArcNodeElement(
  exchange: ExchangeName,
  pair: string,
  marginClass: string,
): HTMLElement {
  const card = document.createElement('div');
  card.id = `arc-${exchange}-${pair}`;
  card.dataset.exchange = exchange;
  card.dataset.pair = pair;
  card.className = `market-arc-card flex h-[54px] w-full items-center justify-between gap-3 rounded-xl px-4 md:w-[264px] ${marginClass}`;

  const left = document.createElement('div');
  left.className = 'flex min-w-0 items-center gap-2.5';

  const dot = document.createElement('span');
  dot.dataset.port = 'dot';
  dot.className =
    'h-2 w-2 shrink-0 rounded-full bg-neutral-200 shadow-[0_0_8px_rgba(255,255,255,0.65)]';

  const labels = document.createElement('div');
  labels.className = 'truncate leading-tight';

  const nameEl = document.createElement('div');
  nameEl.className = 'text-sm font-semibold text-white';
  nameEl.textContent = formatCoinName(pair);

  const symbolEl = document.createElement('div');
  symbolEl.className = 'text-[11px] font-medium tracking-wide text-neutral-400';
  symbolEl.textContent = formatPairDisplay(pair);

  labels.append(nameEl, symbolEl);
  left.append(dot, labels);

  const right = document.createElement('div');
  right.className = 'shrink-0 text-right leading-tight';

  const priceEl = document.createElement('div');
  priceEl.dataset.price = '';
  priceEl.className = 'text-sm font-semibold tabular-nums text-neutral-100';
  priceEl.textContent = '--';

  const subpriceEl = document.createElement('div');
  subpriceEl.dataset.subprice = '';
  subpriceEl.className = 'text-xs tabular-nums text-neutral-400';
  subpriceEl.textContent = 'Aguardando...';

  right.append(priceEl, subpriceEl);
  card.append(left, right);
  return card;
}

function ensureMarketArcNodes(pairs: readonly string[]): void {
  const normalizedPairs = pairs.length > 0 ? pairs.map((p) => p.trim().toUpperCase()) : [...DEFAULT_PAIRS];
  const nextKey = normalizedPairs.join(',');
  if (nextKey === renderedArcPairsKey) {
    return;
  }

  state.monitoredPairs = normalizedPairs;
  renderedArcPairsKey = nextKey;

  const arcList = requireElement('market-arc-list');
  const entries: Array<{ exchange: ExchangeName; pair: string }> = [
    ...normalizedPairs.map((pair) => ({ exchange: 'binance' as const, pair })),
    ...normalizedPairs.map((pair) => ({ exchange: 'kraken' as const, pair })),
  ];

  const nodes = entries.map((entry, idx) =>
    createArcNodeElement(
      entry.exchange,
      entry.pair,
      getCrescentMarginClass(idx, entries.length),
    ),
  );
  arcList.replaceChildren(...nodes);
  applyExchangeFilter(state.activeExchangeFilter);
}

function getAnchorPoint(
  el: HTMLElement,
  side: 'left' | 'right' | 'dot',
  baseRect: DOMRect,
): { x: number; y: number } {
  const target =
    side === 'dot' ? (el.querySelector<HTMLElement>('[data-port="dot"]') ?? el) : el;
  const r = target.getBoundingClientRect();

  if (side === 'right') {
    return { x: r.right - baseRect.left, y: r.top + r.height / 2 - baseRect.top };
  }
  if (side === 'dot') {
    return { x: r.left + r.width / 2 - baseRect.left, y: r.top + r.height / 2 - baseRect.top };
  }
  return { x: r.left - baseRect.left, y: r.top + r.height / 2 - baseRect.top };
}

function buildMarketCurves(): void {
  const canvas = document.getElementById('market-canvas');
  const svg = document.getElementById('market-graph-svg');
  const edgesGroup = document.getElementById('market-svg-edges');
  const pulsesGroup = document.getElementById('market-svg-pulses');
  const hubNode = document.getElementById('hub-node');
  const binanceCard = document.getElementById('ex-binance');
  const krakenCard = document.getElementById('ex-kraken');
  const arcList = document.getElementById('market-arc-list');

  if (
    !canvas ||
    !svg ||
    !edgesGroup ||
    !pulsesGroup ||
    !hubNode ||
    !binanceCard ||
    !krakenCard ||
    !arcList
  ) {
    return;
  }

  const canvasRect = canvas.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  if (canvasRect.width === 0 || canvasRect.height === 0 || svgRect.width === 0) {
    edgesGroup.replaceChildren();
    pulsesGroup.replaceChildren();
    curveEntries = [];
    return;
  }

  edgesGroup.replaceChildren();
  pulsesGroup.replaceChildren();
  curveEntries = [];

  const arcCards = Array.from(arcList.querySelectorAll<HTMLElement>('.market-arc-card'));
  const connections: Array<{
    from: HTMLElement;
    to: HTMLElement;
    branch: ExchangeName;
    toSide: 'left' | 'dot';
  }> = [
    { from: hubNode, to: binanceCard, branch: 'binance', toSide: 'left' },
    { from: hubNode, to: krakenCard, branch: 'kraken', toSide: 'left' },
  ];

  for (const arcCard of arcCards) {
    const branch = arcCard.dataset.exchange === 'kraken' ? 'kraken' : 'binance';
    connections.push({
      from: branch === 'binance' ? binanceCard : krakenCard,
      to: arcCard,
      branch,
      toSide: 'dot',
    });
  }

  connections.forEach((conn, idx) => {
    const p1 = getAnchorPoint(conn.from, 'right', canvasRect);
    const p2 = getAnchorPoint(conn.to, conn.toSide, canvasRect);
    const dx = Math.max(24, (p2.x - p1.x) * 0.56);
    const d = `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${(p1.x + dx).toFixed(1)} ${p1.y.toFixed(1)}, ${(p2.x - dx).toFixed(1)} ${p2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    const isActive = state.activeExchangeFilter === 'all' || state.activeExchangeFilter === conn.branch;

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute(
      'stroke',
      isActive ? 'url(#scarioth-edge-grad)' : 'url(#scarioth-edge-grad-soft)',
    );
    path.setAttribute('stroke-width', isActive ? '1.65' : '1.05');
    if (isActive) {
      path.setAttribute('filter', 'url(#scarioth-glow-line)');
    }
    edgesGroup.appendChild(path);

    const pulse = document.createElementNS(SVG_NS, 'circle');
    pulse.setAttribute('r', isActive ? '2.6' : '0');
    pulse.setAttribute('fill', '#ffffff');
    pulse.setAttribute('opacity', isActive ? '0.9' : '0');
    pulsesGroup.appendChild(pulse);

    curveEntries.push({
      path,
      pulse,
      active: isActive,
      length: path.getTotalLength(),
      offset: (idx * 0.17) % 1,
      speed: conn.from === hubNode ? 0.28 : 0.23,
    });
  });
}

function animateMarketPulses(now: number): void {
  const dt = lastPulseTimestamp > 0 ? Math.min(0.05, (now - lastPulseTimestamp) / 1000) : 0.016;
  lastPulseTimestamp = now;

  for (const item of curveEntries) {
    if (!item.active || item.length <= 0) {
      continue;
    }
    item.offset = (item.offset + dt * item.speed) % 1;
    const pt = item.path.getPointAtLength(item.offset * item.length);
    item.pulse.setAttribute('cx', pt.x.toFixed(1));
    item.pulse.setAttribute('cy', pt.y.toFixed(1));
  }

  window.requestAnimationFrame(animateMarketPulses);
}

function applyExchangeFilter(filter: ExchangeFilter): void {
  state.activeExchangeFilter = filter;

  const filterButtons = document.querySelectorAll<HTMLButtonElement>('[data-market-filter]');
  for (const btn of filterButtons) {
    const val = btn.dataset.marketFilter;
    btn.classList.toggle('active', val === filter);
  }

  for (const ex of ['binance', 'kraken'] as const) {
    const card = document.getElementById(`ex-${ex}`);
    if (!card) {
      continue;
    }
    card.classList.toggle('is-focused', filter === ex);
    card.classList.toggle('is-dimmed', filter !== 'all' && filter !== ex);
  }

  const arcCards = document.querySelectorAll<HTMLElement>('#market-arc-list .market-arc-card');
  for (const arcCard of arcCards) {
    const isDimmed = filter !== 'all' && arcCard.dataset.exchange !== filter;
    arcCard.classList.toggle('is-dimmed', isDimmed);
  }

  buildMarketCurves();
}

function renderExchangeCard(
  exchange: ExchangeName,
  info: { state: ExchangeConnectionState; isStale: boolean },
  pairs: readonly MarketPairSnapshot[],
): void {
  const statusEl = document.getElementById(`status-${exchange}`);
  const latEl = document.getElementById(`lat-${exchange}`);

  if (statusEl) {
    if (info.state === 'connected' && !info.isStale) {
      statusEl.textContent = 'WS Online';
    } else if (info.state === 'connected' && info.isStale) {
      statusEl.textContent = 'WS Stale';
    } else if (info.state === 'reconnecting' || info.state === 'connecting') {
      statusEl.textContent = 'Reconectando...';
    } else {
      statusEl.textContent = 'Offline';
    }
  }

  let minAgeMs: number | null = null;
  for (const pairItem of pairs) {
    const quote = pairItem[exchange];
    if (quote && (minAgeMs === null || quote.ageMs < minAgeMs)) {
      minAgeMs = quote.ageMs;
    }
  }

  if (latEl) {
    latEl.textContent = minAgeMs !== null ? `${minAgeMs} ms` : '-- ms';
  }
}

function triggerArcFlash(card: HTMLElement, key: string, direction: 'up' | 'down'): void {
  const existingTimer = flashTimers.get(key);
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer);
  }

  card.classList.remove('flash-tick-up', 'flash-tick-down');
  void card.offsetWidth;
  card.classList.add(direction === 'up' ? 'flash-tick-up' : 'flash-tick-down');

  const timerId = window.setTimeout(() => {
    card.classList.remove('flash-tick-up', 'flash-tick-down');
    flashTimers.delete(key);
  }, 520);
  flashTimers.set(key, timerId);
}

function renderMarketGraph(msg: MarketSnapshotMessage): void {
  ensureMarketArcNodes(msg.pairs.map((p) => p.pair));
  renderExchangeCard('binance', msg.exchanges.binance, msg.pairs);
  renderExchangeCard('kraken', msg.exchanges.kraken, msg.pairs);
  requireElement('last-snapshot-time').textContent =
    `Atualizado às ${formatLocalTime(msg.timestamp)}`;

  for (const item of msg.pairs) {
    for (const exchange of ['binance', 'kraken'] as const) {
      const card = document.getElementById(`arc-${exchange}-${item.pair}`);
      if (!card) {
        continue;
      }

      const priceEl = card.querySelector<HTMLElement>('[data-price]');
      const subpriceEl = card.querySelector<HTMLElement>('[data-subprice]');
      const quote = item[exchange];

      if (priceEl) {
        priceEl.textContent = quote ? formatPrice(quote.bid) : '--';
      }
      if (subpriceEl) {
        subpriceEl.textContent = quote ? `Ask ${formatPrice(quote.ask)}` : 'Sem cotação';
      }

      if (quote) {
        const key = `${exchange}:${item.pair}`;
        const prevBid = lastQuoteBids.get(key);
        if (prevBid !== undefined && quote.bid !== prevBid) {
          triggerArcFlash(card, key, quote.bid > prevBid ? 'up' : 'down');
        }
        lastQuoteBids.set(key, quote.bid);
      }
    }
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
    tr.className = row.isNew ? 'animate-row-flash' : 'hover:bg-white/5 transition-colors';

    const tdTime = document.createElement('td');
    tdTime.className = 'whitespace-nowrap py-3 pr-4 font-mono text-xs text-neutral-400';
    tdTime.textContent = formatLocalTime(row.timestamp);

    const tdPair = document.createElement('td');
    tdPair.className = 'whitespace-nowrap py-3 pr-4 font-semibold text-white';
    tdPair.textContent = formatPairDisplay(row.pair);

    const tdRoute = document.createElement('td');
    tdRoute.className = 'whitespace-nowrap py-3 pr-4 text-xs text-neutral-300';
    tdRoute.textContent = `${formatExchangeLabel(row.buyExchange)} -> ${formatExchangeLabel(row.sellExchange)}`;

    const tdBuy = document.createElement('td');
    tdBuy.className = 'whitespace-nowrap py-3 pr-4 text-right font-mono text-xs tabular-nums text-neutral-300';
    tdBuy.textContent = formatPrice(row.buyPrice);

    const tdSell = document.createElement('td');
    tdSell.className = 'whitespace-nowrap py-3 pr-4 text-right font-mono text-xs tabular-nums text-neutral-300';
    tdSell.textContent = formatPrice(row.sellPrice);

    const tdAbs = document.createElement('td');
    tdAbs.className = 'whitespace-nowrap py-3 pr-4 text-right font-mono text-xs tabular-nums text-neutral-200';
    tdAbs.textContent = formatSpreadAbsolute(row.spreadAbsolute);

    const tdPct = document.createElement('td');
    tdPct.className =
      'whitespace-nowrap py-3 pr-4 text-right font-mono text-xs font-bold tabular-nums text-white';
    tdPct.textContent = formatSpreadPercentage(row.spreadPercentage);

    const tdSource = document.createElement('td');
    tdSource.className = 'whitespace-nowrap py-3';
    const badge = document.createElement('span');
    badge.className =
      row.source === 'live'
        ? 'rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-semibold text-white'
        : 'rounded-full bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-neutral-300';
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
      ? 'rounded-md bg-white/15 px-3 py-1.5 text-xs font-semibold text-white transition'
      : 'rounded-md px-3 py-1.5 text-xs font-medium text-neutral-400 hover:text-white transition';
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
  renderMarketGraph(msg);
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
    ensureMarketArcNodes(message.monitoredPairs);
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
  const exchangeFilters = document.getElementById('exchange-filters');
  if (exchangeFilters) {
    exchangeFilters.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest<HTMLButtonElement>('button[data-market-filter]');
      if (!button) {
        return;
      }
      const val = button.dataset.marketFilter;
      const nextFilter: ExchangeFilter =
        val === 'binance' || val === 'kraken' ? val : 'all';
      applyExchangeFilter(nextFilter);
    });
  }

  for (const ex of ['binance', 'kraken'] as const) {
    const card = document.getElementById(`ex-${ex}`);
    if (!card) {
      continue;
    }
    card.addEventListener('click', () => {
      applyExchangeFilter(state.activeExchangeFilter === ex ? 'all' : ex);
    });
  }

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

function setupMarketGraphObserver(): void {
  const canvas = document.getElementById('market-canvas');
  if (!canvas) {
    return;
  }

  const ro = new ResizeObserver(() => {
    buildMarketCurves();
  });
  ro.observe(canvas);

  window.addEventListener('load', buildMarketCurves);
  window.requestAnimationFrame(() => {
    buildMarketCurves();
    if (!pulseLoopStarted) {
      pulseLoopStarted = true;
      window.requestAnimationFrame(animateMarketPulses);
    }
  });
}

function init(): void {
  bindUiEvents();
  updateFilterButtonsStyle();
  renderWsBadge();
  setupMarketGraphObserver();
  void loadHistory(true);
  connectWebSocket();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
