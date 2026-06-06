import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

// ---------------------------------------------------------------------------
// Renderer: capture the microphone, stream it to Deepgram live transcription,
// render interim + finalized text, and forward finalized segments to main.
// ---------------------------------------------------------------------------

const els = {};
['startBtn', 'stopBtn', 'settingsBtn', 'openDirBtn', 'transcript', 'interim',
 'memories', 'statusDot', 'statusText', 'understandState', 'insforgeState',
 'settingsPanel', 'dgKey', 'dgModel', 'language', 'outputDir', 'sinkMarkdown',
 'sinkInsforge', 'understandEnabled', 'understandModel', 'saveSettings',
 'closeSettings', 'errorBar'].forEach((id) => {
  els[id] = document.getElementById(id);
});

let state = {
  recording: false,
  micStream: null,
  recorder: null,
  dgConnection: null,
  keepAlive: null,
  settings: null
};

function setStatus(text, active) {
  els.statusText.textContent = text;
  els.statusDot.classList.toggle('active', Boolean(active));
}

function showError(msg) {
  els.errorBar.textContent = msg;
  els.errorBar.classList.add('show');
  setTimeout(() => els.errorBar.classList.remove('show'), 6000);
}

function appendFinal(text, speaker) {
  const line = document.createElement('div');
  line.className = 'line';
  const ts = new Date().toTimeString().slice(0, 8);
  line.innerHTML = `<span class="ts">${ts}</span>${speaker ? `<span class="spk">${speaker}</span>` : ''}<span class="txt"></span>`;
  line.querySelector('.txt').textContent = text;
  els.transcript.appendChild(line);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function addMemory(mem) {
  const card = document.createElement('div');
  card.className = `memory kind-${mem.kind}`;
  const tags = (mem.tags || []).map((t) => `<span class="tag">#${t}</span>`).join('');
  card.innerHTML = `<div class="memory-head"><span class="memory-kind">${mem.kind.replace('_', ' ')}</span></div>
    <div class="memory-content"></div><div class="memory-tags">${tags}</div>`;
  card.querySelector('.memory-content').textContent = mem.content;
  els.memories.prepend(card);
}

// ---- Deepgram live ----------------------------------------------------------
async function startTranscription() {
  const s = state.settings;
  if (!s.deepgramApiKey) {
    showError('Add your Deepgram API key in Settings first.');
    openSettings();
    return;
  }

  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showError('Microphone access denied: ' + err.message);
    return;
  }

  const deepgram = createClient(s.deepgramApiKey);
  const connection = deepgram.listen.live({
    model: s.deepgramModel || 'nova-2',
    language: s.language || 'en-US',
    smart_format: true,
    interim_results: true,
    punctuate: true,
    // diarize lets us attribute speakers; downstream we pass speaker through.
    diarize: true,
    utterance_end_ms: 1000
  });
  state.dgConnection = connection;

  connection.on(LiveTranscriptionEvents.Open, () => {
    setStatus('Listening', true);

    // Stream mic audio in small chunks. webm/opus from MediaRecorder is
    // accepted by Deepgram's live endpoint.
    const recorder = new MediaRecorder(state.micStream, { mimeType: 'audio/webm' });
    state.recorder = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && connection.getReadyState() === 1) {
        connection.send(e.data);
      }
    };
    recorder.start(250);

    // Keepalive so Deepgram doesn't close the socket during long silences.
    state.keepAlive = setInterval(() => {
      try { connection.keepAlive(); } catch (_) {}
    }, 8000);
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data.channel?.alternatives?.[0];
    const text = alt?.transcript?.trim();
    if (!text) return;

    if (data.is_final) {
      // Derive a speaker label from diarization if present.
      let speaker = null;
      const words = alt.words || [];
      if (words.length && typeof words[0].speaker === 'number') {
        speaker = `Speaker ${words[0].speaker}`;
      }
      els.interim.textContent = '';
      appendFinal(text, speaker);
      window.app.sendFinalSegment({
        text,
        speaker,
        startMs: data.start != null ? Math.round(data.start * 1000) : null,
        endMs: data.start != null && data.duration != null ? Math.round((data.start + data.duration) * 1000) : null
      });
    } else {
      els.interim.textContent = text;
    }
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    showError('Deepgram error: ' + (err?.message || JSON.stringify(err)));
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    if (state.recording) setStatus('Disconnected', false);
  });
}

function stopTranscription() {
  if (state.keepAlive) { clearInterval(state.keepAlive); state.keepAlive = null; }
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  state.recorder = null;
  if (state.dgConnection) { try { state.dgConnection.requestClose(); } catch (_) {} state.dgConnection = null; }
  if (state.micStream) { state.micStream.getTracks().forEach((t) => t.stop()); state.micStream = null; }
  els.interim.textContent = '';
}

// ---- Session controls -------------------------------------------------------
async function start() {
  if (state.recording) return;
  state.settings = await window.app.getSettings();
  await window.app.startSession({});
  await startTranscription();
  state.recording = true;
  els.startBtn.disabled = true;
  els.stopBtn.disabled = false;
}

async function stop() {
  if (!state.recording) return;
  state.recording = false;
  stopTranscription();
  await window.app.stopSession();
  setStatus('Stopped', false);
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
}

// ---- Settings panel ---------------------------------------------------------
async function loadSettingsIntoForm() {
  const s = await window.app.getSettings();
  state.settings = s;
  els.dgKey.value = s.deepgramApiKey || '';
  els.dgModel.value = s.deepgramModel || 'nova-2';
  els.language.value = s.language || 'en-US';
  els.outputDir.value = s.outputDir || '';
  els.sinkMarkdown.checked = !!s.sinks?.markdown;
  els.sinkInsforge.checked = !!s.sinks?.insforge;
  els.understandEnabled.checked = !!s.understanding?.enabled;
  els.understandModel.value = s.understanding?.model || 'anthropic/claude-sonnet-4.5';
}

function openSettings() {
  loadSettingsIntoForm();
  els.settingsPanel.classList.add('open');
}
function closeSettings() {
  els.settingsPanel.classList.remove('open');
}

async function saveSettings() {
  const partial = {
    deepgramApiKey: els.dgKey.value.trim(),
    deepgramModel: els.dgModel.value.trim() || 'nova-2',
    language: els.language.value.trim() || 'en-US',
    outputDir: els.outputDir.value.trim(),
    sinks: { markdown: els.sinkMarkdown.checked, insforge: els.sinkInsforge.checked },
    understanding: {
      enabled: els.understandEnabled.checked,
      everyWords: 120,
      everySeconds: 45,
      model: els.understandModel.value.trim() || 'anthropic/claude-sonnet-4.5'
    }
  };
  state.settings = await window.app.setSettings(partial);
  closeSettings();
}

// ---- Wire up ----------------------------------------------------------------
els.startBtn.addEventListener('click', start);
els.stopBtn.addEventListener('click', stop);
els.settingsBtn.addEventListener('click', openSettings);
els.closeSettings.addEventListener('click', closeSettings);
els.saveSettings.addEventListener('click', saveSettings);
els.openDirBtn.addEventListener('click', () => window.app.openOutputDir());

window.app.onMemory(addMemory);
window.app.onStatus((s) => {
  if (s.understanding) els.understandState.textContent = `Understanding: ${s.understanding}`;
});
window.app.onError((err) => showError(`${err.scope || 'error'}: ${err.message}`));

(async function init() {
  await loadSettingsIntoForm();
  const ins = await window.app.insforgeStatus();
  els.insforgeState.textContent = ins.linked ? 'InsForge: linked' : 'InsForge: not linked';
  els.insforgeState.classList.toggle('ok', ins.linked);
  setStatus('Idle', false);
})();
