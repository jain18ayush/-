'use strict';

const os = require('os');
const path = require('path');
const Store = require('electron-store');

// User-configurable settings. The Deepgram key lives here (local machine only),
// never in source. Output dir defaults to ~/AlwaysListening.
const defaults = {
  deepgramApiKey: '',
  deepgramModel: 'nova-2',
  language: 'en-US',
  outputDir: path.join(os.homedir(), 'AlwaysListening'),
  // Pluggable output sinks. Markdown is the base layer; InsForge is optional.
  sinks: {
    markdown: true,
    insforge: true
  },
  // The "understanding" layer: LLM distillation of transcript into memories.
  understanding: {
    enabled: true,
    // Run extraction once this many new finalized words have accumulated,
    // or after this many seconds since the last run (whichever comes first).
    everyWords: 120,
    everySeconds: 45,
    model: 'anthropic/claude-sonnet-4.5'
  }
};

const store = new Store({ name: 'config', defaults });

module.exports = {
  getAll() {
    return store.store;
  },
  get(key) {
    return store.get(key);
  },
  set(partial) {
    for (const [k, v] of Object.entries(partial)) {
      store.set(k, v);
    }
    return store.store;
  }
};
