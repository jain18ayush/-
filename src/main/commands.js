'use strict';

// Voice command detection. As the user talks, we watch for an intent to spin up
// a Replicas coding agent — e.g. "spin up a replicas agent to build a Tetris
// game". A cheap keyword pre-filter gates an LLM extraction that pulls out a
// clean, self-contained build instruction.

const OpenAI = require('openai');

let client = null;
function getOpenAI() {
  if (!process.env.OPENROUTER_API_KEY) return null;
  if (!client) {
    client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY
    });
  }
  return client;
}

// Fast local gate so we don't call the LLM on every segment. The phrase must
// look like a "start an agent" instruction.
const TRIGGER = /\b(replica|replicas)\b|\b(spin up|spin off|fire up|kick off|kick (it )?off|start|launch|stand up)\b[^.?!]{0,40}\bagent\b/i;

function looksLikeCommand(text) {
  return TRIGGER.test(text || '');
}

const SYSTEM_PROMPT = `You detect whether the speaker is issuing a command to spin up a background coding agent ("replica") to build or work on something.

You are given a short rolling window of speech transcript. The latest sentence may contain the trigger. Decide if the speaker is actually instructing that an agent be started NOW (not merely musing about agents in general).

Return STRICT JSON:
{"isCommand": boolean, "confidence": 0..1, "name": string, "message": string, "codingAgent": "claude"|"codex"}

- isCommand: true only if there is a clear directive to spin up / start / launch an agent to build/do something.
- message: a clear, self-contained build instruction for the coding agent, written as an imperative (e.g. "Build a Tetris game in React with keyboard controls and a score counter."). Infer reasonable scope from context; do NOT include filler or meta-talk about agents.
- name: a short descriptive label, max 4 words (e.g. "tetris game").
- codingAgent: "claude" unless the speaker explicitly asks for codex.
If it is not a real command, return {"isCommand": false, "confidence": <low>, "name": "", "message": "", "codingAgent": "claude"}.`;

async function detectCommand(windowText, model) {
  const ai = getOpenAI();
  if (!ai) return { isCommand: false, error: 'OPENROUTER_API_KEY not set' };

  try {
    const resp = await ai.chat.completions.create({
      model: model || 'openrouter/free',
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Transcript window:\n\n${windowText}` }
      ]
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { isCommand: false };
    }
    if (!parsed.isCommand || !parsed.message || !String(parsed.message).trim()) {
      return { isCommand: false, confidence: parsed.confidence ?? 0 };
    }
    return {
      isCommand: true,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
      name: (parsed.name || '').trim(),
      message: String(parsed.message).trim(),
      codingAgent: parsed.codingAgent === 'codex' ? 'codex' : 'claude'
    };
  } catch (err) {
    console.error('[commands] detection failed:', err.message || err);
    return { isCommand: false, error: err.message || String(err) };
  }
}

module.exports = { looksLikeCommand, detectCommand };
