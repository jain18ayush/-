'use strict';

const path = require('path');
// Load OPENROUTER_API_KEY (and anything else) from .env.local for the
// server-side understanding layer.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const settings = require('./settings');
const insforge = require('./insforge');
const { buildSinkManager } = require('./sinks');
const { extractMemories } = require('./understanding');

let mainWindow = null;

// ---- Live session state -----------------------------------------------------
const session = {
  id: null,
  active: false,
  sinks: null,
  // Buffer of finalized text not yet handed to the understanding layer.
  pendingText: '',
  pendingWordCount: 0,
  lastRunAt: 0,
  understandingTimer: null,
  // A short rolling tail kept as context for each extraction call.
  recentContext: ''
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Always Listening',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---- Understanding scheduling -----------------------------------------------
function maybeScheduleUnderstanding() {
  const cfg = settings.get('understanding') || {};
  if (!cfg.enabled) return;
  if (session.pendingWordCount >= (cfg.everyWords || 120)) {
    runUnderstanding('word-threshold');
  }
}

async function runUnderstanding(reason) {
  const cfg = settings.get('understanding') || {};
  if (!cfg.enabled || !session.active) return;
  const text = session.pendingText.trim();
  if (text.length < 20) return;

  // Reset the buffer up-front so new audio accumulates while we call the LLM.
  const excerpt = (session.recentContext + '\n' + text).trim().slice(-6000);
  session.pendingText = '';
  session.pendingWordCount = 0;
  session.lastRunAt = Date.now();

  send('status', { understanding: 'running', reason });
  const { memories, error } = await extractMemories(excerpt, cfg.model);
  send('status', { understanding: 'idle' });

  if (error) {
    send('error', { scope: 'understanding', message: error });
    return;
  }
  for (const mem of memories) {
    if (session.sinks) await session.sinks.memory(mem);
    send('memory:new', { ...mem, at: new Date().toISOString() });
  }
  // Keep a little context for continuity across windows.
  session.recentContext = text.slice(-1500);
}

// ---- IPC --------------------------------------------------------------------
ipcMain.handle('settings:get', () => settings.getAll());
ipcMain.handle('settings:set', (_e, partial) => settings.set(partial));

ipcMain.handle('insforge:status', () => {
  const cfg = insforge.loadProjectConfig();
  return { linked: Boolean(cfg.baseUrl && cfg.apiKey), baseUrl: cfg.baseUrl || null };
});

ipcMain.handle('output:open', () => {
  const dir = settings.get('outputDir');
  shell.openPath(dir);
  return dir;
});

ipcMain.handle('session:start', async (_e, opts) => {
  if (session.active) return { id: session.id };
  const all = settings.getAll();
  const startedAt = new Date().toISOString();

  let id = null;
  if (all.sinks?.insforge) {
    id = await insforge.createSession((opts && opts.title) || `Session ${startedAt}`);
  }
  session.id = id || `local-${Date.now()}`;
  session.active = true;
  session.pendingText = '';
  session.pendingWordCount = 0;
  session.recentContext = '';
  session.lastRunAt = Date.now();
  session.sinks = buildSinkManager(all);

  await session.sinks.sessionStart({
    id: session.id,
    title: (opts && opts.title) || null,
    startedAt
  });

  // Time-based understanding trigger.
  const cfg = all.understanding || {};
  if (cfg.enabled) {
    session.understandingTimer = setInterval(() => {
      if (Date.now() - session.lastRunAt >= (cfg.everySeconds || 45) * 1000) {
        runUnderstanding('time-interval');
      }
    }, 5000);
  }

  send('status', { session: 'active', sessionId: session.id });
  return { id: session.id };
});

// A finalized transcript segment arriving from the renderer (Deepgram).
ipcMain.handle('segment:final', async (_e, seg) => {
  if (!session.active || !seg || !seg.text) return;
  const clean = { text: String(seg.text).trim(), speaker: seg.speaker || null, startMs: seg.startMs, endMs: seg.endMs };
  if (!clean.text) return;
  if (session.sinks) await session.sinks.segment(clean);
  session.pendingText += (session.pendingText ? ' ' : '') + clean.text;
  session.pendingWordCount += clean.text.split(/\s+/).filter(Boolean).length;
  maybeScheduleUnderstanding();
});

ipcMain.handle('session:stop', async () => {
  if (!session.active) return;
  session.active = false;
  if (session.understandingTimer) {
    clearInterval(session.understandingTimer);
    session.understandingTimer = null;
  }
  // Final flush of any buffered text.
  await runUnderstanding('session-end');
  if (session.sinks) await session.sinks.sessionEnd({ id: session.id });
  send('status', { session: 'stopped' });
  const id = session.id;
  session.id = null;
  session.sinks = null;
  return { id };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
