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
const { looksLikeCommand, detectCommand } = require('./commands');
const replicas = require('./replicas');

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
  recentContext: '',
  // Rolling window of recent finalized text used for command detection.
  commandWindow: [],
  segmentSignatures: new Set(),
  // Command-detection state machine: we "arm" instantly off interim speech
  // (provisional card), then extract the instruction when the phrase completes.
  cmd: { armed: false, extracting: false, id: null, timer: null, interim: '', lastArmAt: 0 }
};

const COMMAND_DEBOUNCE_MS = 7000;

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

// ---- Voice command detection (spin up a Replicas agent) ---------------------
// "Arm" the instant a trigger phrase is heard (even in interim speech) so a
// provisional card shows with ~no latency, then extract the real instruction
// once the phrase completes (a finalized segment) or after a short fallback.
function armCommand() {
  const c = session.cmd;
  if (c.armed || c.extracting) return;
  if (Date.now() - c.lastArmAt < COMMAND_DEBOUNCE_MS) return;
  c.armed = true;
  c.lastArmAt = Date.now();
  c.id = `cmd-${Date.now()}`;
  // Provisional card — appears immediately, no LLM round-trip yet.
  send('command:detected', { id: c.id, pending: true, name: '', message: '', at: new Date().toISOString() });
  // Fallback: if no finalized segment arrives soon, extract from interim.
  c.timer = setTimeout(() => runCommandExtraction(), 1800);
}

async function runCommandExtraction() {
  const c = session.cmd;
  if (!c.armed || c.extracting) return;
  if (c.timer) { clearTimeout(c.timer); c.timer = null; }
  c.extracting = true;
  const cfg = settings.get('replicas') || {};
  const id = c.id;
  try {
    const windowText = (session.commandWindow.join(' ') + ' ' + c.interim).trim().slice(-1400);
    const result = await detectCommand(windowText, cfg.detectModel);
    const ok = result.isCommand && (result.confidence ?? 0) >= (cfg.minConfidence ?? 0.6);
    console.log('[commands] extraction', {
      ok,
      isCommand: result.isCommand,
      confidence: result.confidence,
      threshold: cfg.minConfidence ?? 0.6,
      error: result.error,
      message: result.message,
      window: windowText
    });
    if (!ok) {
      // Retract the provisional card — false alarm.
      send('command:resolved', { id, ok: false });
      return;
    }
    const command = {
      id,
      name: result.name,
      message: result.message,
      codingAgent: result.codingAgent,
      confidence: result.confidence,
      at: new Date().toISOString()
    };
    send('command:resolved', { id, ok: true, ...command });
    if (cfg.autoConfirm) await spinUpReplica(command);
  } finally {
    c.armed = false;
    c.extracting = false;
    c.interim = '';
  }
}

// Interim (not-yet-final) speech: cheap gate → arm instantly.
function onInterim(text) {
  const cfg = settings.get('replicas') || {};
  if (!cfg.enabled) return;
  session.cmd.interim = text || '';
  if (looksLikeCommand(text)) armCommand();
}

// Finalized speech: feed the rolling window; if armed, the phrase is complete,
// so extract now rather than waiting for the fallback timer.
function onFinalForCommands(text) {
  const cfg = settings.get('replicas') || {};
  if (!cfg.enabled) return;
  session.commandWindow.push(text);
  if (session.commandWindow.length > 8) session.commandWindow.shift();
  if (session.cmd.armed) {
    runCommandExtraction();
  } else if (looksLikeCommand(text)) {
    armCommand();
    // Phrase already finalized; give a brief beat for any trailing final.
    setTimeout(() => runCommandExtraction(), 350);
  }
}

async function spinUpReplica(command) {
  const cfg = settings.get('replicas') || {};
  send('replica:update', { id: command.id, status: 'creating', name: command.name });
  try {
    const replica = await replicas.createReplica({
      name: command.name || 'voice-build',
      message: command.message,
      environmentId: cfg.environmentId || undefined,
      codingAgent: command.codingAgent || cfg.codingAgent || 'codex',
      model: cfg.model || undefined
    });
    // Record the spin-up as a memory so it lands in the markdown/InsForge sinks.
    if (session.sinks) {
      await session.sinks.memory({
        kind: 'action_item',
        content: `Spun up Replicas agent "${replica.name}" to: ${command.message}`,
        tags: ['replicas', 'agent'],
        sourceExcerpt: command.message
      });
    }
    send('replica:update', {
      id: command.id,
      status: replica.status || 'preparing',
      replicaId: replica.id,
      name: replica.name,
      url: replica.url,
      message: command.message
    });
    // The create response returns before the workspace finishes booting, so the
    // status above is an early/empty value. Poll until it settles (e.g. "active")
    // and push each change to the renderer so the card stops saying "preparing".
    pollReplicaStatus(command, replica);
    return replica;
  } catch (err) {
    send('replica:update', { id: command.id, status: 'error', error: err.message || String(err) });
    send('error', { scope: 'replicas', message: err.message || String(err) });
  }
}

// Statuses that mean the workspace is still coming up; keep polling while in one.
const REPLICA_PENDING = new Set(['preparing', 'pending', 'creating', 'queued', 'provisioning', 'booting', 'starting']);

/**
 * Poll a freshly-created replica until its status settles, emitting a
 * `replica:update` to the renderer whenever the status changes. Stops on a
 * non-pending status (e.g. "active"/"error") or after a time budget.
 */
async function pollReplicaStatus(command, replica) {
  const intervalMs = 3000;
  const maxAttempts = 40; // ~2 minutes
  let last = replica.status || 'preparing';
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (!mainWindow || mainWindow.isDestroyed()) return;
    let cur;
    try {
      cur = await replicas.getReplica(replica.id);
    } catch {
      continue; // transient; keep trying within the budget
    }
    const status = cur.status || last;
    if (status !== last) {
      last = status;
      send('replica:update', {
        id: command.id,
        status,
        replicaId: replica.id,
        name: cur.name || replica.name,
        url: replica.url,
        message: command.message
      });
    }
    if (!REPLICA_PENDING.has(status)) return; // settled
  }
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
  session.commandWindow = [];
  session.segmentSignatures = new Set();
  if (session.cmd.timer) clearTimeout(session.cmd.timer);
  session.cmd = { armed: false, extracting: false, id: null, timer: null, interim: '', lastArmAt: 0 };
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
  const signature = `${clean.startMs ?? ''}|${clean.endMs ?? ''}|${clean.speaker ?? ''}|${clean.text}`;
  if (session.segmentSignatures.has(signature)) return;
  session.segmentSignatures.add(signature);
  if (session.segmentSignatures.size > 200) {
    const oldest = session.segmentSignatures.values().next().value;
    session.segmentSignatures.delete(oldest);
  }
  if (session.sinks) await session.sinks.segment(clean);
  session.pendingText += (session.pendingText ? ' ' : '') + clean.text;
  session.pendingWordCount += clean.text.split(/\s+/).filter(Boolean).length;
  maybeScheduleUnderstanding();
  // Fire-and-forget command detection so it never blocks transcription.
  onFinalForCommands(clean.text);
});

// Interim (live, not-yet-final) transcript — used only to arm command detection
// for instant UI feedback. Not persisted to any sink.
ipcMain.handle('segment:interim', (_e, text) => {
  if (session.active) onInterim(String(text || ''));
});

// Renderer confirmed (or re-issued) a detected command — actually spin it up.
ipcMain.handle('replicas:spinUp', async (_e, command) => {
  return spinUpReplica(command);
});

ipcMain.handle('replicas:status', () => ({ configured: replicas.isConfigured() }));

ipcMain.handle('session:stop', async () => {
  if (!session.active) return;
  session.active = false;
  if (session.understandingTimer) {
    clearInterval(session.understandingTimer);
    session.understandingTimer = null;
  }
  if (session.cmd.timer) { clearTimeout(session.cmd.timer); session.cmd.timer = null; }
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
