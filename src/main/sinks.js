'use strict';

// Pluggable output sinks. Every finalized transcript segment and every distilled
// memory is fanned out to whichever sinks are enabled. Adding a new destination
// (a memory graph, an API, etc.) is just a new class implementing this shape:
//
//   onSessionStart(session) / onSegment(segment) / onMemory(memory) / onSessionEnd(session)
//
// All methods are optional and may be async. A sink throwing must not break the
// pipeline, so the manager isolates failures per-sink.

const fs = require('fs');
const path = require('path');
const insforge = require('./insforge');

function hhmmss(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// MarkdownSink — the base layer. One Markdown file per session for the raw
// transcript, plus an append-only memories.md for distilled items.
// ---------------------------------------------------------------------------
class MarkdownSink {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.sessionFile = null;
    this.memoriesFile = path.join(outputDir, 'memories.md');
  }

  ensureDir() {
    fs.mkdirSync(path.join(this.outputDir, 'sessions'), { recursive: true });
  }

  onSessionStart(session) {
    this.ensureDir();
    const d = new Date(session.startedAt);
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
      d.getHours()
    )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const shortId = (session.id || 'local').slice(0, 8);
    this.sessionFile = path.join(this.outputDir, 'sessions', `${stamp}_${shortId}.md`);

    const header =
      `---\n` +
      `session_id: ${session.id || 'local'}\n` +
      `started_at: ${d.toISOString()}\n` +
      `title: ${session.title || ''}\n` +
      `---\n\n` +
      `# Session ${stamp}\n\n` +
      `## Transcript\n\n`;
    fs.writeFileSync(this.sessionFile, header);

    if (!fs.existsSync(this.memoriesFile)) {
      fs.writeFileSync(this.memoriesFile, `# Memories\n\nDistilled items from every listening session.\n`);
    }
  }

  onSegment(seg) {
    if (!this.sessionFile) return;
    const ts = hhmmss(new Date());
    const who = seg.speaker ? `**${seg.speaker}:** ` : '';
    fs.appendFileSync(this.sessionFile, `- \`${ts}\` ${who}${seg.text}\n`);
  }

  onMemory(mem) {
    const ts = new Date().toISOString();
    const tags = (mem.tags && mem.tags.length) ? ' ' + mem.tags.map((t) => `#${t}`).join(' ') : '';
    const line = `- \`${ts}\` **${mem.kind}** — ${mem.content}${tags}\n`;
    fs.appendFileSync(this.memoriesFile, line);
    // Also mirror memories into the session file so a session reads end-to-end.
    if (this.sessionFile) fs.appendFileSync(this.sessionFile, `\n> [memory:${mem.kind}] ${mem.content}${tags}\n`);
  }

  onSessionEnd() {
    if (this.sessionFile) {
      fs.appendFileSync(this.sessionFile, `\n_Session ended ${new Date().toISOString()}_\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// InsforgeSink — persists segments + memories to the InsForge Postgres backend.
// ---------------------------------------------------------------------------
class InsforgeSink {
  constructor() {
    this.sessionId = null;
  }
  onSessionStart(session) {
    this.sessionId = session.id;
  }
  async onSegment(seg) {
    await insforge.insertSegment(this.sessionId, seg);
  }
  async onMemory(mem) {
    await insforge.insertMemory(this.sessionId, mem);
  }
  async onSessionEnd() {
    await insforge.endSession(this.sessionId);
  }
}

// ---------------------------------------------------------------------------
// SinkManager — fans events out to enabled sinks, isolating failures.
// ---------------------------------------------------------------------------
class SinkManager {
  constructor(sinks) {
    this.sinks = sinks;
  }
  async _emit(method, payload) {
    for (const sink of this.sinks) {
      if (typeof sink[method] !== 'function') continue;
      try {
        await sink[method](payload);
      } catch (err) {
        console.error(`[sink:${sink.constructor.name}] ${method} failed:`, err.message || err);
      }
    }
  }
  sessionStart(session) {
    return this._emit('onSessionStart', session);
  }
  segment(seg) {
    return this._emit('onSegment', seg);
  }
  memory(mem) {
    return this._emit('onMemory', mem);
  }
  sessionEnd(session) {
    return this._emit('onSessionEnd', session);
  }
}

function buildSinkManager(settings) {
  const sinks = [];
  if (settings.sinks?.markdown) sinks.push(new MarkdownSink(settings.outputDir));
  if (settings.sinks?.insforge) sinks.push(new InsforgeSink());
  return new SinkManager(sinks);
}

module.exports = { MarkdownSink, InsforgeSink, SinkManager, buildSinkManager };
