'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge between the renderer (mic + Deepgram + UI) and the
// trusted main process (files, InsForge, LLM understanding).
contextBridge.exposeInMainWorld('app', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  insforgeStatus: () => ipcRenderer.invoke('insforge:status'),
  openOutputDir: () => ipcRenderer.invoke('output:open'),

  startSession: (opts) => ipcRenderer.invoke('session:start', opts),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  sendFinalSegment: (seg) => ipcRenderer.invoke('segment:final', seg),

  onMemory: (cb) => ipcRenderer.on('memory:new', (_e, m) => cb(m)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onError: (cb) => ipcRenderer.on('error', (_e, err) => cb(err))
});
