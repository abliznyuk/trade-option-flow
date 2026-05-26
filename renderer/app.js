// option-flow / renderer / app.js
// Renderer process. Talks to main via window.mt5 (exposed from preload.js).

'use strict';

// ---- state -----------------------------------------------------------------
const state = {
  connected: false,
  chain: null,         // { expiries, byExpiry }
  expiry: null,
  underlying: 'SPY',
  windowMs: 5 * 60 * 1000,
  atm: null,           // current ATM price (mid of underlying bid/ask)
  strikes: [],         // selected strikes (ascending)
  symbols: {},         // strike -> { call: 'SYM', put: 'SYM' }
  buffers: new Map(),  // symbol -> ring buffer of ticks
  charts: new Map(),   // symbol -> { canvas, ctx, cell }
  // dynamic ATM tracking
  centerStrike: null,  // closest strike at last rebuild
  lastRebuildAt: 0,    // ms, wall-clock; cooldown for re-pick
  rebuilding: false,
  // session totals — accumulated from first tick onward, survives ATM-shift
  // rebuilds and contract resubscriptions. Both metrics tracked simultaneously,
  // mode toggle just changes the display.
  // strike -> { call: {buy:{premium,contracts}, sell:{premium,contracts}},
  //             put:  {buy:{...},               sell:{...}} }
  totals: new Map(),
  totalsStartedAt: null,
  totalsMode: 'premium',  // 'premium' = $ paid, 'contracts' = # contracts
  symbolMeta: new Map(), // symbol -> { strike, side: 'call'|'put' }
  totalsRows: new Map(), // strike -> { callCell, putCell, strikeCell }
  activeTab: 'grid',
};

const REBUILD_COOLDOWN_MS = 5000; // min time between ATM-driven regrids
const CONTRACT_MULTIPLIER = 100;  // US equity options: 1 contract = 100 shares

// ---- DOM -------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  filesDir: $('files-dir'),
  connect:  $('connect-btn'),
  mqlBtn:   $('mql-btn'),
  modal:    $('modal'),
  modalCancel: $('modal-cancel'),
  root:     $('root'),
  expiry:   $('expiry'),
  underlying: $('underlying'),
  strikesSide: $('strikes-side'),
  windowMin: $('window-min'),
  go:       $('go-btn'),
  status:   $('status'),
  atmDisplay: $('atm-display'),
  grid:     $('grid'),
  totals:   $('totals'),
  totalsSince: $('totals-since'),
  totalsModeToggle: $('totals-mode-toggle'),
  messages: $('messages'),
};

// ---- modal -----------------------------------------------------------------
function openModal() {
  els.modal.hidden = false;
  // focus the input on next frame so the modal is rendered
  requestAnimationFrame(() => els.filesDir.focus());
}
function closeModal() { els.modal.hidden = true; }

els.mqlBtn.addEventListener('click', openModal);
els.modalCancel.addEventListener('click', closeModal);

// dismiss on backdrop click (clicks on the panel itself bubble but are not the overlay)
els.modal.addEventListener('click', (e) => {
  if (e.target === els.modal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.modal.hidden) closeModal();
});
// Enter inside the input = Connect
els.filesDir.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.connect.click();
});

function setFilesDirDisplay(dir) {
  els.mqlBtn.classList.toggle('connected', !!dir && state.connected);
  els.mqlBtn.textContent = dir ? 'MQL Files ✓' : 'MQL Files…';
  els.mqlBtn.title = dir || '';   // full path visible on hover
}

// ---- tabs ------------------------------------------------------------------
document.querySelectorAll('.toggle .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    state.activeTab = tab;
    document.querySelectorAll('.toggle .tab').forEach(b => b.classList.toggle('active', b === btn));
    els.grid.hidden   = tab !== 'grid';
    els.totals.hidden = tab !== 'totals';
    els.totalsModeToggle.hidden = tab !== 'totals';
  });
});

// ---- totals mode (premium / contracts) -------------------------------------
document.querySelectorAll('#totals-mode-toggle .mode').forEach(btn => {
  btn.addEventListener('click', () => {
    state.totalsMode = btn.dataset.mode;
    document.querySelectorAll('#totals-mode-toggle .mode').forEach(b => b.classList.toggle('active', b === btn));
    renderTotals();
  });
});

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = cls || '';
}
function logMsg(text, cls = 'info') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  els.messages.prepend(div);
  while (els.messages.childElementCount > 100) els.messages.removeChild(els.messages.lastChild);
}

// ---- connect ---------------------------------------------------------------
els.connect.addEventListener('click', async () => {
  const dir = els.filesDir.value.trim();
  if (!dir) { logMsg('files dir is required', 'err'); return; }
  try {
    setStatus('connecting…');
    await window.mt5.connect(dir);
    state.connected = true;
    setStatus('connected', 'connected');
    setFilesDirDisplay(dir);
    closeModal();
    await loadExpiries();
  } catch (e) {
    setStatus('error', 'error');
    logMsg(`connect failed: ${e.message}`, 'err');
  }
});

window.mt5.onAutoFilesDir(async (dir) => {
  els.filesDir.value = dir;
  els.connect.click();
});

// Open the modal automatically on first launch if no path was pre-filled
// from the command line / env (mt5:auto-files-dir fires shortly after load).
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (!state.connected && !els.filesDir.value.trim()) openModal();
  }, 150);
});

window.mt5.onMessage((msg) => {
  if (msg?.type === 'ERROR') logMsg(`[MQL] ${msg.error_type}: ${msg.description}`, 'err');
  else if (msg?.type === 'INFO') logMsg(`[MQL] ${msg.message}`, 'info');
});

// ---- chain discovery -------------------------------------------------------
async function loadExpiries() {
  const root = els.root.value.trim();
  if (!root) return;
  setStatus('fetching chain…');
  try {
    const chain = await window.mt5.buildChain({ rootFilter: root });
    state.chain = chain;
    els.expiry.innerHTML = '';
    for (const exp of chain.expiries) {
      const opt = document.createElement('option');
      opt.value = exp;
      opt.textContent = `${exp}  (${chain.byExpiry[exp].strikes.length} strikes)`;
      els.expiry.appendChild(opt);
    }
    if (chain.expiries.length === 0) {
      logMsg(`no option symbols found for root "${root}"`, 'err');
      setStatus('no chain', 'error');
    } else {
      // prefer 0DTE if today is an expiry, else nearest future
      const today = new Date().toISOString().slice(0, 10);
      const future = chain.expiries.filter(e => e >= today);
      els.expiry.value = future[0] || chain.expiries[0];
      setStatus('chain loaded', 'connected');
      els.go.disabled = false;
    }
  } catch (e) {
    logMsg(`chain load failed: ${e.message}`, 'err');
    setStatus('error', 'error');
  }
}

els.root.addEventListener('change', () => { if (state.connected) loadExpiries(); });

// ---- ATM (underlying quote) ------------------------------------------------
window.mt5.onQuote(({ symbol, bid, ask }) => {
  if (symbol !== state.underlying) return;
  const mid = (Number(bid) + Number(ask)) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return;
  state.atm = mid;
  els.atmDisplay.textContent = `ATM: ${mid.toFixed(2)}`;
  maybeReshiftATM();
});

// Re-pick strikes around the new ATM when the closest strike has shifted.
// Cooldown prevents thrash on jittery underlyings. Buffers for surviving
// contracts are preserved across the rebuild.
function maybeReshiftATM() {
  if (!state.strikes.length || state.rebuilding) return;
  if (Date.now() - state.lastRebuildAt < REBUILD_COOLDOWN_MS) return;
  const newCenter = closestStrike(state.strikes, state.atm);
  if (newCenter === state.centerStrike) return;
  // shifted — pull a fresh window from the full chain
  rebuildGrid().catch(e => logMsg(`ATM reshift failed: ${e.message}`, 'err'));
}

function closestStrike(arr, target) {
  return arr.reduce((b, s) => Math.abs(s - target) < Math.abs(b - target) ? s : b, arr[0]);
}

// ---- Go: build the grid ----------------------------------------------------
els.go.addEventListener('click', async () => {
  state.expiry = els.expiry.value;
  state.underlying = els.underlying.value.trim().toUpperCase();
  state.windowMs = Math.max(60_000, parseInt(els.windowMin.value, 10) * 60_000);

  if (!state.expiry) { logMsg('pick an expiry first', 'err'); return; }
  if (!state.chain) { logMsg('chain not loaded yet', 'err'); return; }

  // subscribe to underlying quote (mid -> ATM)
  try { await window.mt5.subscribeQuote(state.underlying); }
  catch (e) { logMsg(`subscribeQuote(${state.underlying}) failed: ${e.message}`, 'err'); }

  // wait briefly for first ATM tick (up to 3s)
  const atm = await waitForATM(3000);
  if (atm == null) {
    logMsg(`no quote for underlying ${state.underlying} after 3s — using midpoint of available strikes`, 'err');
    const strikes = state.chain.byExpiry[state.expiry].strikes;
    state.atm = strikes[Math.floor(strikes.length / 2)];
    els.atmDisplay.textContent = `ATM: ${state.atm.toFixed(2)} (est)`;
  }

  await rebuildGrid();
});

function waitForATM(timeoutMs) {
  return new Promise((resolve) => {
    if (state.atm != null) return resolve(state.atm);
    const start = Date.now();
    const id = setInterval(() => {
      if (state.atm != null) { clearInterval(id); resolve(state.atm); }
      else if (Date.now() - start > timeoutMs) { clearInterval(id); resolve(null); }
    }, 50);
  });
}

async function rebuildGrid() {
  state.rebuilding = true;
  try {
    const allStrikes = state.chain.byExpiry[state.expiry].strikes;
    const side = Math.max(1, parseInt(els.strikesSide.value, 10) || 5);
    const strikes = await window.mt5.pickStrikes({ strikes: allStrikes, atm: state.atm, side });
    state.strikes = strikes;
    state.symbols = {};
    const newSymSet = new Set();
    for (const s of strikes) {
      const pair = state.chain.byExpiry[state.expiry].byStrike[s] || {};
      state.symbols[s] = pair;
      if (pair.call) {
        newSymSet.add(pair.call);
        state.symbolMeta.set(pair.call, { strike: s, side: 'call' });
      }
      if (pair.put) {
        newSymSet.add(pair.put);
        state.symbolMeta.set(pair.put, { strike: s, side: 'put' });
      }
    }
    // preserve buffers for symbols still in the visible window
    for (const sym of [...state.buffers.keys()]) {
      if (!newSymSet.has(sym)) state.buffers.delete(sym);
    }
    for (const sym of newSymSet) {
      if (!state.buffers.has(sym)) state.buffers.set(sym, []);
    }

    state.centerStrike = closestStrike(strikes, state.atm);
    state.lastRebuildAt = Date.now();
    if (state.totalsStartedAt == null) {
      state.totalsStartedAt = Date.now();
    }

    buildGridDOM();
    buildTotalsDOM();
    await subscribeAllTicks();
    startRenderLoop();
  } finally {
    state.rebuilding = false;
  }
}

function buildGridDOM() {
  els.grid.innerHTML = '';
  state.charts.clear();  // canvases re-created below; buffers are preserved

  // strikes descending (highest at top, lowest at bottom — standard ladder layout)
  const ordered = [...state.strikes].sort((a, b) => b - a);
  const nearestStrike = ordered.reduce(
    (best, s) => Math.abs(s - state.atm) < Math.abs(best - state.atm) ? s : best,
    ordered[0]
  );

  for (const strike of ordered) {
    const isATM = strike === nearestStrike;
    const callSym = state.symbols[strike]?.call || null;
    const putSym  = state.symbols[strike]?.put  || null;

    const callCell = makeChartCell('call', callSym, strike);
    const strikeCell = document.createElement('div');
    strikeCell.className = 'cell strike' + (isATM ? ' atm' : '');
    strikeCell.textContent = formatStrike(strike);
    const putCell = makeChartCell('put', putSym, strike);

    els.grid.appendChild(callCell);
    els.grid.appendChild(strikeCell);
    els.grid.appendChild(putCell);
  }
}

function makeChartCell(side, symbol, strike) {
  const cell = document.createElement('div');
  cell.className = `cell chart ${side}`;
  const canvas = document.createElement('canvas');
  cell.appendChild(canvas);
  if (symbol) {
    const lbl = document.createElement('div');
    lbl.className = 'label';
    lbl.textContent = symbol;
    cell.appendChild(lbl);
    state.charts.set(symbol, { canvas, ctx: canvas.getContext('2d'), cell, side });
    if (!state.buffers.has(symbol)) state.buffers.set(symbol, []);
  } else {
    cell.style.opacity = '0.3';
  }
  return cell;
}

function formatStrike(s) {
  // show integer if it is integer, else 3 decimals
  return Number.isInteger(s) ? String(s) : s.toFixed(3).replace(/\.?0+$/, '');
}

async function subscribeAllTicks() {
  const specs = [];
  for (const strike of state.strikes) {
    const pair = state.symbols[strike];
    if (pair.call) specs.push({ symbol: pair.call, lookback_sec: Math.ceil(state.windowMs / 1000) });
    if (pair.put)  specs.push({ symbol: pair.put,  lookback_sec: Math.ceil(state.windowMs / 1000) });
  }
  try {
    await window.mt5.subscribeTicks(specs);
    logMsg(`subscribed to ${specs.length} contracts`);
  } catch (e) {
    logMsg(`subscribeTicks failed: ${e.message}`, 'err');
  }
}

// ---- tick ingestion --------------------------------------------------------
window.mt5.onTicks(({ symbol, ticks }) => {
  const buf = state.buffers.get(symbol);
  const meta = state.symbolMeta.get(symbol);
  for (const t of ticks) {
    if (buf) buf.push(t);
    // session totals: accumulate $ premium per (strike, side, direction).
    // Premium = price × volume × 100 (US equity options contract multiplier).
    // Only flagged buy/sell trades count — neutral ticks are ignored.
    if (meta && t.is_trade && (t.is_buy || t.is_sell) && t.p > 0 && t.v > 0) {
      let tot = state.totals.get(meta.strike);
      if (!tot) {
        tot = {
          call: { buy: { premium: 0, contracts: 0 }, sell: { premium: 0, contracts: 0 } },
          put:  { buy: { premium: 0, contracts: 0 }, sell: { premium: 0, contracts: 0 } },
        };
        state.totals.set(meta.strike, tot);
      }
      const premium = t.p * t.v * CONTRACT_MULTIPLIER;
      const bin = tot[meta.side][t.is_buy ? 'buy' : 'sell'];
      bin.premium   += premium;
      bin.contracts += t.v;
    }
  }
  // hard cap by count to avoid unbounded growth — time-window trim happens at render
  // time using the global "tick clock" (max t across buffers), so we don't depend
  // on Date.now() vs broker-server-time offset.
  if (buf) {
    const MAX_PER_SYMBOL = 6000;
    if (buf.length > MAX_PER_SYMBOL) buf.splice(0, buf.length - MAX_PER_SYMBOL);
  }
});

// ---- totals pane -----------------------------------------------------------
function buildTotalsDOM() {
  els.totals.innerHTML = '';
  state.totalsRows.clear();
  const ordered = [...state.strikes].sort((a, b) => b - a);
  const nearest = closestStrike(ordered, state.atm);
  for (const strike of ordered) {
    const callCell = document.createElement('div');
    callCell.className = 'tcell call';
    callCell.innerHTML = '<div class="bars"><div class="bar-row"><div class="bar-track"><div class="bar buy"></div></div><span class="bar-label"></span></div><div class="bar-row"><div class="bar-track"><div class="bar sell"></div></div><span class="bar-label"></span></div></div>';

    const strikeCell = document.createElement('div');
    strikeCell.className = 'tcell strike' + (strike === nearest ? ' atm' : '');
    strikeCell.textContent = formatStrike(strike);

    const putCell = document.createElement('div');
    putCell.className = 'tcell put';
    putCell.innerHTML = '<div class="bars"><div class="bar-row"><div class="bar-track"><div class="bar buy"></div></div><span class="bar-label"></span></div><div class="bar-row"><div class="bar-track"><div class="bar sell"></div></div><span class="bar-label"></span></div></div>';

    els.totals.appendChild(callCell);
    els.totals.appendChild(strikeCell);
    els.totals.appendChild(putCell);
    state.totalsRows.set(strike, { callCell, putCell, strikeCell });
  }
}

function fmtMoney(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  if (v > 0)    return `$${v.toFixed(0)}`;
  return '$0';
}

function fmtContracts(v) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return v > 0 ? String(Math.round(v)) : '0';
}

const EMPTY_BIN = { premium: 0, contracts: 0 };
const EMPTY_SIDE = { buy: EMPTY_BIN, sell: EMPTY_BIN };

function renderTotals() {
  if (!state.totalsRows.size) return;
  const key = state.totalsMode === 'contracts' ? 'contracts' : 'premium';
  const fmt = key === 'contracts' ? fmtContracts : fmtMoney;

  // global max for shared scale (so cross-strike comparison is honest)
  let maxV = 0;
  for (const tot of state.totals.values()) {
    if (tot.call.buy[key]  > maxV) maxV = tot.call.buy[key];
    if (tot.call.sell[key] > maxV) maxV = tot.call.sell[key];
    if (tot.put.buy[key]   > maxV) maxV = tot.put.buy[key];
    if (tot.put.sell[key]  > maxV) maxV = tot.put.sell[key];
  }
  if (maxV === 0) maxV = 1;

  for (const [strike, row] of state.totalsRows) {
    const tot = state.totals.get(strike) || { call: EMPTY_SIDE, put: EMPTY_SIDE };
    updateBarRow(row.callCell, tot.call, maxV, key, fmt);
    updateBarRow(row.putCell,  tot.put,  maxV, key, fmt);
  }

  if (state.totalsStartedAt) {
    const sec = Math.floor((Date.now() - state.totalsStartedAt) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    els.totalsSince.textContent = `since session start · ${mm}:${ss}`;
  }
}

function updateBarRow(cell, side, maxV, key, fmt) {
  const rows = cell.querySelectorAll('.bar-row');
  // rows[0] = buy (blue), rows[1] = sell (pink)
  const buyBar  = rows[0].querySelector('.bar');
  const buyLbl  = rows[0].querySelector('.bar-label');
  const sellBar = rows[1].querySelector('.bar');
  const sellLbl = rows[1].querySelector('.bar-label');
  const buyV  = side.buy[key];
  const sellV = side.sell[key];
  const buyPct  = (buyV  / maxV) * 100;
  const sellPct = (sellV / maxV) * 100;
  buyBar.style.width  = `${Math.max(buyPct,  buyV  > 0 ? 0.5 : 0)}%`;
  sellBar.style.width = `${Math.max(sellPct, sellV > 0 ? 0.5 : 0)}%`;
  buyLbl.textContent  = fmt(buyV);
  sellLbl.textContent = fmt(sellV);
}

// ---- render loop -----------------------------------------------------------
let rafHandle = null;
let lastTotalsRenderAt = 0;
function startRenderLoop() {
  if (rafHandle != null) return;
  const loop = () => {
    // global "tick clock" — newest tick time across all buffers. Used as the
    // right edge of every chart so we never compare server-time ticks against
    // wall-clock Date.now() (broker server time is usually offset from UTC).
    let tickNow = 0;
    for (const buf of state.buffers.values()) {
      if (buf.length > 0) {
        const last = buf[buf.length - 1].t;
        if (last > tickNow) tickNow = last;
      }
    }
    if (tickNow === 0) tickNow = Date.now();
    // grid: render only when visible (canvas redraws are expensive)
    if (state.activeTab === 'grid') {
      for (const [sym, chart] of state.charts) renderChart(sym, chart, tickNow);
    }
    // totals: DOM bars, throttle to ~4 Hz, render always so timer keeps ticking
    const now = Date.now();
    if (now - lastTotalsRenderAt >= 250) {
      lastTotalsRenderAt = now;
      renderTotals();
    }
    rafHandle = requestAnimationFrame(loop);
  };
  rafHandle = requestAnimationFrame(loop);
}

function renderChart(symbol, { canvas, ctx, cell, side }, tickNow) {
  const buf = state.buffers.get(symbol);
  // resize canvas to its container (DPI-aware)
  const dpr = window.devicePixelRatio || 1;
  const w = cell.clientWidth;
  const h = cell.clientHeight;
  if (w === 0 || h === 0) return;  // cell not yet laid out
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  ctx.clearRect(0, 0, w, h);

  if (!buf || buf.length === 0) {
    ctx.fillStyle = '#3a414b';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('no data', w / 2, h / 2);
    return;
  }

  // x-domain = [tickNow-windowMs, tickNow] using server-time clock, so we are
  // immune to broker-vs-UTC offsets and DST nonsense.
  const tMax = tickNow;
  const tMin = tickNow - state.windowMs;

  // visible ticks = those in window
  let yMin = Infinity, yMax = -Infinity;
  let maxVol = 0;
  let visibleCount = 0;
  for (const t of buf) {
    if (t.t < tMin || t.t > tMax) continue;
    visibleCount++;
    if (t.b > 0) { if (t.b < yMin) yMin = t.b; if (t.b > yMax) yMax = t.b; }
    if (t.a > 0) { if (t.a < yMin) yMin = t.a; if (t.a > yMax) yMax = t.a; }
    if (t.is_trade) {
      if (t.p > 0) { if (t.p < yMin) yMin = t.p; if (t.p > yMax) yMax = t.p; }
      if (t.v > maxVol) maxVol = t.v;
    }
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return; // nothing in window
  if (yMin === yMax) { yMin -= 0.01; yMax += 0.01; }
  else {
    const pad = (yMax - yMin) * 0.1;
    yMin -= pad;
    yMax += pad;
  }

  // Time axis radiates outward from the strike column in the middle of the screen:
  //   - PUT  (right column): newest at LEFT edge (next to strike), oldest at RIGHT edge.
  //   - CALL (left column):  newest at RIGHT edge (next to strike), oldest at LEFT edge.
  // i.e. recent activity is always next to the strike, history fans out to the outside.
  const x = side === 'put'
    ? (t) => w - ((t - tMin) / (tMax - tMin)) * w
    : (t) =>      ((t - tMin) / (tMax - tMin)) * w;
  const y = (p) => h - ((p - yMin) / (yMax - yMin)) * h;

  // --- bid line (blue) and ask line (pink) ---
  drawLine(ctx, buf, tMin, tMax, x, y, 'b', '#58a6ff');
  drawLine(ctx, buf, tMin, tMax, x, y, 'a', '#f78ba8');

  // --- trade bubbles ---
  const rMax = Math.min(12, h / 3);
  const rMin = 1.5;
  for (const t of buf) {
    if (t.t < tMin || t.t > tMax) continue;
    if (!t.is_trade) continue;
    if (!(t.p > 0)) continue;
    const norm = maxVol > 0 ? Math.sqrt(t.v / maxVol) : 0;
    const r = rMin + (rMax - rMin) * norm;
    const cx = x(t.t);
    const cy = y(t.p);
    const color = t.is_buy ? 'rgba(88, 166, 255, 0.85)'   // blue (buy)
                : t.is_sell ? 'rgba(247, 139, 168, 0.85)' // pink (sell)
                : 'rgba(100, 220, 120, 0.85)';            // green (neutral)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLine(ctx, buf, tMin, tMax, x, y, key, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (const t of buf) {
    if (t.t < tMin || t.t > tMax) continue;
    const v = t[key];
    if (!(v > 0)) continue;
    const xx = x(t.t);
    const yy = y(v);
    if (!started) { ctx.moveTo(xx, yy); started = true; }
    else ctx.lineTo(xx, yy);
  }
  ctx.stroke();
}

// ---- cleanup ---------------------------------------------------------------
window.addEventListener('beforeunload', () => {
  try { window.mt5.unsubscribeTicksAll(); } catch {}
});
