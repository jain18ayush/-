'use strict';

// The "understanding" layer. Given a window of recent finalized transcript,
// ask an LLM (through the InsForge OpenRouter gateway) to distill durable
// "memories": notes, action items, questions, decisions, and entities.
//
// This is the seam where a richer memory backend ("G Brain", a contacts/memory
// graph, etc.) plugs in later — it would consume the same structured memories.

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

const SYSTEM_PROMPT = `You distill a live conversation transcript into durable memory items.
Read the transcript excerpt and extract only genuinely useful, self-contained items.
Return STRICT JSON: {"memories":[{"kind","content","tags","sourceExcerpt"}]}.
- kind is one of: note, action_item, question, decision, entity.
- content is a concise, standalone statement (no "the user said"). Rephrase into a clear fact/task.
- tags is a short array of lowercase topic keywords (0-4).
- sourceExcerpt is a short verbatim quote from the transcript that supports it.
Rules: skip filler, greetings, and anything not worth remembering. If nothing is
worth keeping, return {"memories":[]}. Do not invent details not in the transcript.`;

async function extractMemories(transcriptText, model) {
  const ai = getOpenAI();
  if (!ai) {
    return { memories: [], error: 'OPENROUTER_API_KEY not set (run: npx @insforge/cli ai setup)' };
  }
  if (!transcriptText || transcriptText.trim().length < 20) {
    return { memories: [] };
  }

  try {
    const resp = await ai.chat.completions.create({
      model: model || 'anthropic/claude-sonnet-4.5',
      temperature: 0.2,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Transcript excerpt:\n\n${transcriptText}` }
      ]
    });

    const raw = resp.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Be forgiving if the model wraps JSON in prose.
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { memories: [] };
    }
    const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
    return {
      memories: memories
        .filter((m) => m && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({
          kind: ['note', 'action_item', 'question', 'decision', 'entity'].includes(m.kind)
            ? m.kind
            : 'note',
          content: m.content.trim(),
          tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string').slice(0, 4) : [],
          sourceExcerpt: typeof m.sourceExcerpt === 'string' ? m.sourceExcerpt.trim() : null
        }))
    };
  } catch (err) {
    console.error('[understanding] extraction failed:', err.message || err);
    return { memories: [], error: err.message || String(err) };
  }
}

module.exports = { extractMemories };
