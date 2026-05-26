// option-flow / main.js
// Electron main process. Owns the dwx_client connection, brokers all DWX traffic
// for the renderer via IPC.

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, ipcMain } = require('electron');

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

// --- config -----------------------------------------------------------------
// User can override via cli arg --files-dir=... or env MT5_FILES_DIR.
function resolveFilesDir() {
  const argv = process.argv.slice(2);
  for (const a of argv) {
    if (a.startsWith('--files-dir=')) return a.slice('--files-dir='.length);
  }
  if (process.env.MT5_FILES_DIR) return process.env.MT5_FILES_DIR;
  return null; // will be set via settings UI in renderer
}

// --- IPC --------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('mt5:connect', async (_evt, filesDir) => {
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
    if (!client) throw new Error('not connected');
    // Brokers with a huge symbol catalogue (full options chains) can take
    // a long time on the first call as the terminal lazy-loads them.
    const data = await client.get_symbols(filter || '', 60_000);
    return data;
  });

  ipcMain.handle('mt5:build-chain', async (_evt, { rootFilter, expiry }) => {
    if (!client) throw new Error('not connected');
    const filter = expiry
      ? `${rootFilter}` // we filter further on the JS side after parsing
      : rootFilter;
    const data = await client.get_symbols(filter || '', 60_000);
    const chain = buildChain(data.symbols);
    return chain;
  });

  ipcMain.handle('mt5:subscribe-quote', async (_evt, symbol) => {
    if (!client) throw new Error('not connected');
    await client.subscribe_symbols([symbol]); // single symbol for ATM tracking
    return { ok: true };
  });

  ipcMain.handle('mt5:subscribe-ticks', async (_evt, specs) => {
    if (!client) throw new Error('not connected');
    // specs: [{symbol, lookback_sec}, ...]
    await client.subscribe_ticks(specs);
    return { ok: true };
  });

  ipcMain.handle('mt5:unsubscribe-ticks-all', async () => {
    if (!client) return { ok: true };
    await client.subscribe_ticks([]);
    return { ok: true };
  });

  ipcMain.handle('mt5:pick-strikes', async (_evt, { strikes, atm, side }) => {
    return pickStrikesAroundATM(strikes, atm, side ?? 10);
  });
}

function send(channel, payload) {
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

  // auto-connect if files dir came from cli / env
  const filesDir = resolveFilesDir();
  if (filesDir) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('mt5:auto-files-dir', filesDir);
    });
  }
}

app.whenReady().then(() => {
  setupIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  try { client && (client.ACTIVE = false); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
