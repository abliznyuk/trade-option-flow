// option-flow / preload.js
// Exposes a minimal, typed API to the renderer.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mt5', {
  connect(filesDir)       { return ipcRenderer.invoke('mt5:connect', filesDir); },
  getSymbols(filter)      { return ipcRenderer.invoke('mt5:get-symbols', filter); },
  buildChain(opts)        { return ipcRenderer.invoke('mt5:build-chain', opts); },
  subscribeQuote(symbol)  { return ipcRenderer.invoke('mt5:subscribe-quote', symbol); },
  subscribeTicks(specs)   { return ipcRenderer.invoke('mt5:subscribe-ticks', specs); },
  unsubscribeTicksAll()   { return ipcRenderer.invoke('mt5:unsubscribe-ticks-all'); },
  pickStrikes(opts)       { return ipcRenderer.invoke('mt5:pick-strikes', opts); },

  onMessage(cb)        { ipcRenderer.on('mt5:message', (_e, p) => cb(p)); },
  onQuote(cb)          { ipcRenderer.on('mt5:quote',   (_e, p) => cb(p)); },
  onTicks(cb)          { ipcRenderer.on('mt5:ticks',   (_e, p) => cb(p)); },
  onAutoFilesDir(cb)   { ipcRenderer.on('mt5:auto-files-dir', (_e, p) => cb(p)); },
});
