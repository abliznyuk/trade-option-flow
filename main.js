// option-flow / main.js
// Electron main process. Owns the dwx_client connection, brokers all DWX traffic
// for the renderer via IPC.

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');

// Hide the native File/Edit/View/Window/Help menu — this is a single-purpose
// dashboard, not a document editor, so the default menu is just visual noise.
// Standard shortcuts (Ctrl+R reload, Ctrl+Shift+I DevTools, Ctrl+W close)
// still work via Electron's default accelerators.
Menu.setApplicationMenu(null);

// Electron sandbox + GPU process can't launch from mapped/network drives on
// Windows (typical: "GPU process launch failed: error_code=18"). The root
// cause is Chromium's sandbox refusing to spawn helper processes from a path
// the OS treats as non-local. Three things together reliably fix it:
//   1. disable HW acceleration  (so Chromium doesn't try to run GPU at all)
//   2. --no-sandbox             (lets helpers spawn from Y:\ etc.)
//   3. --in-process-gpu         (runs GPU in main process — no helper spawn)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
app.commandLine.appendSwitch('disable-software-rasterizer');

const { dwx_client } = require('./lib/dwx_client');
const { buildChain, pickStrikesAroundATM } = require('./lib/occ');

let win = null;
let client = null;

// --- cli --------------------------------------------------------------------
const ARGV = process.argv.slice(2);
function argVal(name) {
  const hit = ARGV.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
function argFlag(name) {
  return ARGV.includes(`--${name}`);
}

// --- config -----------------------------------------------------------------
// User-level persistent settings live in userData/config.json. CLI / env can
// still override the MQL files path for a single launch (not persisted).
const CONFIG_DEFAULTS = {
  filesDir: '',
  strikesSide: 5,
  windowMin: 5,
  showBlocks: false,
  totalsMode: 'premium',
};
let CONFIG_PATH = null;
function getConfigPath() {
  if (!CONFIG_PATH) CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
  return CONFIG_PATH;
}
function loadConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    return { ...CONFIG_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}
function saveConfig(cfg) {
  try {
    const merged = { ...CONFIG_DEFAULTS, ...cfg };
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2));
    return merged;
  } catch (e) {
    console.error('config save failed', e);
    return null;
  }
}
function resolveFilesDirOverride() {
  const v = argVal('files-dir');
  if (v) return v;
  if (process.env.MT5_FILES_DIR) return process.env.MT5_FILES_DIR;
  return null;
}

// --- record / replay --------------------------------------------------------
// Record mode: `npm start -- --record` (auto path under ./recordings) or
// `--record=/some/path.jsonl`. Captures every event we send to the renderer,
// plus the result of get-symbols / build-chain so chains can be rebuilt on
// replay. Output is JSONL, one JSON object per line:
//   {kind:"meta", startedAt, version}
//   {t:<ms>, kind:"event", ch, p}
//   {t:<ms>, kind:"rpc",   name, args, result}
//
// Replay mode: `npm start -- --replay=path [--replay-speed=N]`. Skips DWX,
// schedules every event from the file via setTimeout relative to the moment
// the renderer calls mt5:connect. get-symbols / build-chain serve recorded
// results in FIFO order. Subscribe calls become no-ops.
const recordPathArg = (() => {
  const v = argVal('record');
  if (v) return v;
  if (argFlag('record')) {
    const dir = path.join(__dirname, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `flow-${stamp}.jsonl`);
  }
  return null;
})();
const replayPath = argVal('replay');
const replaySpeed = Math.max(0.01, parseFloat(argVal('replay-speed') || '1') || 1);

let recStream = null;
let recStart = 0;
if (recordPathArg && !replayPath) {
  fs.mkdirSync(path.dirname(recordPathArg), { recursive: true });
  recStream = fs.createWriteStream(recordPathArg, { flags: 'a' });
  recStart = Date.now();
  recStream.write(JSON.stringify({ kind: 'meta', startedAt: recStart, version: 1 }) + '\n');
  console.log('[record] →', recordPathArg);
}
function recordEvent(ch, payload) {
  if (!recStream) return;
  recStream.write(JSON.stringify({ t: Date.now() - recStart, kind: 'event', ch, p: payload }) + '\n');
}
function recordRpc(name, args, result) {
  if (!recStream) return;
  recStream.write(JSON.stringify({ t: Date.now() - recStart, kind: 'rpc', name, args, result }) + '\n');
}

let replay = null;
function loadReplay() {
  const raw = fs.readFileSync(replayPath, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const ln of raw) { try { entries.push(JSON.parse(ln)); } catch {} }
  const events = entries.filter(e => e.kind === 'event');
  const rpcQ = new Map();
  for (const e of entries) {
    if (e.kind !== 'rpc') continue;
    if (!rpcQ.has(e.name)) rpcQ.set(e.name, []);
    rpcQ.get(e.name).push(e.result);
  }
  console.log(`[replay] ${entries.length} entries (${events.length} events), speed ×${replaySpeed} ←`, replayPath);
  return {
    events,
    popRpc(name) {
      const arr = rpcQ.get(name);
      return arr && arr.length ? arr.shift() : null;
    },
    peekRpc(name) {
      const arr = rpcQ.get(name);
      return arr && arr.length ? arr[0] : null;
    },
  };
}
function startReplayStream() {
  if (!replay) return;
  const t0 = Date.now();
  for (const e of replay.events) {
    const due = e.t / replaySpeed;
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.send(e.ch, e.p);
    }, due);
  }
  const last = replay.events.length ? replay.events[replay.events.length - 1].t : 0;
  console.log(`[replay] scheduled, total span ${(last / 1000).toFixed(1)}s wall → ${(last / replaySpeed / 1000).toFixed(1)}s playback`);
}

// --- IPC --------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('mt5:connect', async (_evt, filesDir) => {
    if (replay) {
      // Replay mode: skip DWX, schedule recorded events relative to now.
      startReplayStream();
      return { ok: true, replay: true };
    }
    if (!filesDir || !fs.existsSync(filesDir)) {
      throw new Error(`files dir not found: ${filesDir}`);
    }
    if (client) {
      try { client.ACTIVE = false; } catch {}
      client = null;
    }
    client = new dwx_client({
      metatrader_dir_path: filesDir,
      verbose: false,
      event_handler: {
        on_message(msg) { send('mt5:message', msg); },
        on_tick(symbol, bid, ask) { send('mt5:quote', { symbol, bid, ask }); },
        on_ticks(symbol, ticks) { send('mt5:ticks', { symbol, ticks }); },
        on_order_event() { /* not used here */ },
      },
    });
    client.start();
    return { ok: true };
  });

  ipcMain.handle('mt5:get-symbols', async (_evt, filter) => {
    if (replay) {
      const r = replay.popRpc('get-symbols') || replay.peekRpc('build-chain');
      if (!r) throw new Error('replay: no recorded get-symbols result');
      return r;
    }
    if (!client) throw new Error('not connected');
    // Brokers with a huge symbol catalogue (full options chains) can take
    // a long time on the first call as the terminal lazy-loads them.
    const data = await client.get_symbols(filter || '', 60_000);
    recordRpc('get-symbols', [filter], data);
    return data;
  });

  ipcMain.handle('mt5:build-chain', async (_evt, { rootFilter, expiry }) => {
    if (replay) {
      const r = replay.popRpc('build-chain');
      if (r) return r;
      // fall back: rebuild from a recorded get-symbols payload
      const sy = replay.peekRpc('get-symbols');
      if (sy) return buildChain(sy.symbols);
      throw new Error('replay: no recorded chain');
    }
    if (!client) throw new Error('not connected');
    const filter = expiry
      ? `${rootFilter}` // we filter further on the JS side after parsing
      : rootFilter;
    const data = await client.get_symbols(filter || '', 60_000);
    const chain = buildChain(data.symbols);
    recordRpc('build-chain', [{ rootFilter, expiry }], chain);
    return chain;
  });

  ipcMain.handle('mt5:subscribe-quote', async (_evt, symbol) => {
    if (replay) return { ok: true };
    if (!client) throw new Error('not connected');
    await client.subscribe_symbols([symbol]); // single symbol for ATM tracking
    return { ok: true };
  });

  ipcMain.handle('mt5:subscribe-ticks', async (_evt, specs) => {
    if (replay) return { ok: true };
    if (!client) throw new Error('not connected');
    // specs: [{symbol, lookback_sec}, ...]
    await client.subscribe_ticks(specs);
    return { ok: true };
  });

  ipcMain.handle('mt5:unsubscribe-ticks-all', async () => {
    if (replay) return { ok: true };
    if (!client) return { ok: true };
    await client.subscribe_ticks([]);
    return { ok: true };
  });

  ipcMain.handle('mt5:pick-strikes', async (_evt, { strikes, atm, side }) => {
    return pickStrikesAroundATM(strikes, atm, side ?? 10);
  });

  ipcMain.handle('config:get', () => loadConfig());
  ipcMain.handle('config:set', (_evt, cfg) => {
    const merged = saveConfig(cfg);
    return merged ? { ok: true, config: merged } : { ok: false };
  });

  ipcMain.handle('dialog:pick-files-dir', async (_evt, current) => {
    const opts = {
      title: 'Select MT5 MQL5\\Files folder',
      properties: ['openDirectory'],
    };
    if (current && typeof current === 'string') {
      try { if (fs.existsSync(current)) opts.defaultPath = current; } catch {}
    }
    const r = await dialog.showOpenDialog(win, opts);
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
}

function send(channel, payload) {
  recordEvent(channel, payload);
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// --- window -----------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Push persisted config + any CLI/env files-dir override to the renderer
  // once the document is ready. Renderer decides what to apply / auto-connect.
  win.webContents.once('did-finish-load', () => {
    const cfg = loadConfig();
    const override = resolveFilesDirOverride();
    if (override) cfg.filesDir = override;
    win.webContents.send('config:init', cfg);
  });
}

app.whenReady().then(() => {
  if (replayPath) replay = loadReplay();
  setupIpc();
  createWindow();
  // In replay mode there's no real files dir — auto-trigger connect so the
  // renderer doesn't sit waiting for the user to fill the input.
  if (replay) {
    const tryAuto = () => win && win.webContents.send('config:init', { ...CONFIG_DEFAULTS, filesDir: '__REPLAY__' });
    if (win) win.webContents.once('did-finish-load', tryAuto);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  try { client && (client.ACTIVE = false); } catch {}
  try { recStream && recStream.end(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
