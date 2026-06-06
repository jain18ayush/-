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
  sendInterim: (text) => ipcRenderer.invoke('segment:interim', text),

  // Replicas agent spin-up
  replicasStatus: () => ipcRenderer.invoke('replicas:status'),
  spinUpReplica: (command) => ipcRenderer.invoke('replicas:spinUp', command),

  onMemory: (cb) => ipcRenderer.on('memory:new', (_e, m) => cb(m)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onError: (cb) => ipcRenderer.on('error', (_e, err) => cb(err)),
  onCommandDetected: (cb) => ipcRenderer.on('command:detected', (_e, c) => cb(c)),
  onCommandResolved: (cb) => ipcRenderer.on('command:resolved', (_e, r) => cb(r)),
  onReplicaUpdate: (cb) => ipcRenderer.on('replica:update', (_e, u) => cb(u))
});
