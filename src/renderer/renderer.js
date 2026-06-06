import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

// ---------------------------------------------------------------------------
// Renderer: capture the microphone, stream it to Deepgram live transcription,
// render interim + finalized text, and forward finalized segments to main.
// ---------------------------------------------------------------------------

const els = {};
['startBtn', 'stopBtn', 'settingsBtn', 'openDirBtn', 'transcript', 'interim',
 'memories', 'agents', 'statusDot', 'statusText', 'understandState', 'insforgeState',
 'replicasState', 'settingsPanel', 'dgKey', 'dgModel', 'language', 'outputDir',
 'sinkMarkdown', 'sinkInsforge', 'understandEnabled', 'understandModel',
 'replicasEnabled', 'replicasAutoConfirm', 'replicasAgent', 'replicasEnv',
 'saveSettings', 'closeSettings', 'errorBar'].forEach((id) => {
  els[id] = document.getElementById(id);
});

let state = {
  recording: false,
  micStream: null,
  recorder: null,
  dgConnection: null,
  keepAlive: null,
  settings: null,
  finalSegmentsSeen: new Set()
};

let lastInterimSent = 0;

function rememberFinalSegment(signature) {
  if (state.finalSegmentsSeen.has(signature)) return false;
  state.finalSegmentsSeen.add(signature);
  if (state.finalSegmentsSeen.size > 200) {
    const oldest = state.finalSegmentsSeen.values().next().value;
    state.finalSegmentsSeen.delete(oldest);
  }
  return true;
}

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

// ---- Agent command cards ----------------------------------------------------
function clearHint() {
  const hint = els.agents.querySelector('.hint');
  if (hint) hint.remove();
}

function getCard(id) {
  return els.agents.querySelector(`.agent-card[data-id="${id}"]`);
}

// Provisional card — shown the instant a trigger phrase is heard (no message yet).
function addCommandCard(cmd) {
  clearHint();
  if (getCard(cmd.id)) return;
  const card = document.createElement('div');
  card.className = 'agent-card pending';
  card.dataset.id = cmd.id;
  card.innerHTML = `
    <div class="agent-head"><span class="agent-badge">listening<span class="dots">…</span></span><span class="agent-name"></span></div>
    <div class="agent-msg">Heard a spin-up command — parsing…</div>
    <div class="agent-actions" style="display:none">
      <button class="btn ghost dismiss">Dismiss</button>
      <button class="btn primary confirm">Spin up agent</button>
    </div>
    <div class="agent-status"></div>`;
  els.agents.prepend(card);
}

// Fill the provisional card with the parsed instruction (or drop it on a false alarm).
function resolveCommandCard(r) {
  const card = getCard(r.id);
  if (!card) return;
  if (!r.ok) { card.remove(); return; }
  card.classList.remove('pending');
  const conf = r.confidence != null ? `${Math.round(r.confidence * 100)}%` : '';
  card.querySelector('.agent-badge').textContent = `detected · ${conf}`;
  card.querySelector('.agent-name').textContent = r.name || '';
  // Swap the placeholder for an editable instruction so the user can tweak
  // what the agent is asked to build before confirming.
  const editor = document.createElement('textarea');
  editor.className = 'agent-msg agent-msg-edit';
  editor.value = r.message;
  editor.rows = 3;
  card.querySelector('.agent-msg').replaceWith(editor);
  const actions = card.querySelector('.agent-actions');
  actions.style.display = '';
  card.querySelector('.dismiss').onclick = () => card.remove();
  card.querySelector('.confirm').onclick = async () => {
    const message = editor.value.trim() || r.message;
    editor.readOnly = true;
    setCardStatus(card, 'Creating workspace…');
    actions.style.display = 'none';
    await window.app.spinUpReplica({ id: r.id, name: r.name, message, codingAgent: r.codingAgent });
  };
}

function setCardStatus(card, text, link) {
  const s = card.querySelector('.agent-status');
  if (!s) return;
  s.textContent = text;
  if (link) {
    const a = document.createElement('a');
    a.href = link; a.target = '_blank'; a.textContent = ' open dashboard ↗'; a.className = 'agent-link';
    s.appendChild(a);
    const u = document.createElement('span');
    u.textContent = link; u.className = 'agent-link-url';
    u.title = 'click to copy';
    u.onclick = () => { navigator.clipboard.writeText(link); };
    s.appendChild(u);
  }
}

function handleReplicaUpdate(u) {
  let card = getCard(u.id);
  if (!card) {
    // e.g. auto-confirm path with no prior card — synthesize one.
    addCommandCard({ id: u.id });
    resolveCommandCard({ id: u.id, ok: true, message: u.message || '', name: u.name, confidence: null });
    card = getCard(u.id);
  }
  if (!card) return;
  const actions = card.querySelector('.agent-actions');
  if (actions) actions.style.display = 'none';
  // Once the replica is being created the instruction is locked in.
  const editor = card.querySelector('.agent-msg-edit');
  if (editor) editor.readOnly = true;
  if (u.status === 'error') {
    card.classList.add('err');
    setCardStatus(card, `Error: ${u.error || 'failed'}`);
  } else if (u.status === 'creating') {
    setCardStatus(card, 'Creating workspace…');
  } else {
    card.classList.add('ok');
    const idShort = u.replicaId ? ` · ${u.replicaId.slice(0, 8)}` : '';
    setCardStatus(card, `Agent ${u.status || 'preparing'}${idShort}`, u.url);
  }
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
      const startMs = data.start != null ? Math.round(data.start * 1000) : null;
      const endMs = data.start != null && data.duration != null ? Math.round((data.start + data.duration) * 1000) : null;
      const signature = `${startMs ?? ''}|${endMs ?? ''}|${speaker ?? ''}|${text}`;
      if (!rememberFinalSegment(signature)) return;

      els.interim.textContent = '';
      appendFinal(text, speaker);
      window.app.sendFinalSegment({
        text,
        speaker,
        startMs,
        endMs
      });
    } else {
      els.interim.textContent = text;
      // Forward interim speech (throttled) so command detection can arm the
      // instant a trigger phrase is heard, without waiting for the final.
      const now = Date.now();
      if (now - lastInterimSent > 250) {
        lastInterimSent = now;
        window.app.sendInterim(text);
      }
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
  state.finalSegmentsSeen = new Set();
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
  els.understandModel.value = s.understanding?.model || 'openrouter/free';
  els.replicasEnabled.checked = !!s.replicas?.enabled;
  els.replicasAutoConfirm.checked = !!s.replicas?.autoConfirm;
  els.replicasAgent.value = s.replicas?.codingAgent || 'claude';
  els.replicasEnv.value = s.replicas?.environmentId || '';
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
      model: els.understandModel.value.trim() || 'openrouter/free'
    },
    replicas: {
      enabled: els.replicasEnabled.checked,
      autoConfirm: els.replicasAutoConfirm.checked,
      codingAgent: els.replicasAgent.value.trim() || 'claude',
      environmentId: els.replicasEnv.value.trim(),
      // Preserve fields not exposed in the form — don't clobber on save.
      model: state.settings?.replicas?.model ?? '',
      detectModel: state.settings?.replicas?.detectModel || 'anthropic/claude-haiku-4.5',
      minConfidence: state.settings?.replicas?.minConfidence ?? 0.6
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
window.app.onCommandDetected(addCommandCard);
window.app.onCommandResolved(resolveCommandCard);
window.app.onReplicaUpdate(handleReplicaUpdate);

(async function init() {
  await loadSettingsIntoForm();
  const ins = await window.app.insforgeStatus();
  els.insforgeState.textContent = ins.linked ? 'InsForge: linked' : 'InsForge: not linked';
  els.insforgeState.classList.toggle('ok', ins.linked);
  const rep = await window.app.replicasStatus();
  els.replicasState.textContent = rep.configured ? 'Replicas: ready' : 'Replicas: no key';
  els.replicasState.classList.toggle('ok', rep.configured);
  setStatus('Idle', false);
})();
