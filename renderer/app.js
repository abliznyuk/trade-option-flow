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
};

// ---- DOM -------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  filesDir: $('files-dir'),
  connect:  $('connect-btn'),
  root:     $('root'),
  expiry:   $('expiry'),
  underlying: $('underlying'),
  strikesSide: $('strikes-side'),
  windowMin: $('window-min'),
  go:       $('go-btn'),
  status:   $('status'),
  atmDisplay: $('atm-display'),
  grid:     $('grid'),
  messages: $('messages'),
};

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
});

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
  const allStrikes = state.chain.byExpiry[state.expiry].strikes;
  const side = Math.max(1, parseInt(els.strikesSide.value, 10) || 5);
  const strikes = await window.mt5.pickStrikes({ strikes: allStrikes, atm: state.atm, side });
  state.strikes = strikes;
  state.symbols = {};
  for (const s of strikes) {
    state.symbols[s] = state.chain.byExpiry[state.expiry].byStrike[s];
  }

  buildGridDOM();
  await subscribeAllTicks();
  startRenderLoop();
}

function buildGridDOM() {
  els.grid.innerHTML = '';
  state.buffers.clear();
  state.charts.clear();

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
    state.buffers.set(symbol, []);
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
  if (!buf) return;
  for (const t of ticks) buf.push(t);
  // hard cap by count to avoid unbounded growth — time-window trim happens at render
  // time using the global "tick clock" (max t across buffers), so we don't depend
  // on Date.now() vs broker-server-time offset.
  const MAX_PER_SYMBOL = 6000;
  if (buf.length > MAX_PER_SYMBOL) buf.splice(0, buf.length - MAX_PER_SYMBOL);
});

// ---- render loop -----------------------------------------------------------
let rafHandle = null;
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
    for (const [sym, chart] of state.charts) renderChart(sym, chart, tickNow);
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
