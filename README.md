# Always Listening

An Electron desktop app that **constantly listens**, transcribes your voice in
real time with **Deepgram**, and distills the running transcript into durable
**memories** with an LLM. Output is **pluggable**: it writes Markdown files by
default and can also persist to an **InsForge** Postgres backend.

```
 mic ──▶ Deepgram live (renderer) ──▶ finalized segments ──▶ main process
                                                              │
                                          ┌───────────────────┼────────────────────┐
                                          ▼                   ▼                    ▼
                                   MarkdownSink         InsforgeSink         Understanding
                                   (.md files)        (Postgres tables)   (LLM → memories)
                                                                                  │
                                                                          memories fan back
                                                                          out to the sinks
```

## Layers

| Layer | What it does | Where |
|-------|--------------|-------|
| **Transcription (base)** | Streams mic audio to Deepgram live, shows interim + final text | `src/renderer/renderer.js` |
| **Sinks (flexibility)** | Fan finalized segments + memories to destinations | `src/main/sinks.js` |
| **Understanding** | Periodic LLM pass → structured memories (notes, action items, questions, decisions, entities) | `src/main/understanding.js` |
| **Backend** | Sessions / segments / memories in Postgres via InsForge | `src/main/insforge.js` |

The **understanding layer is the seam** for "G Brain" / a memory-contacts graph
later — a new backend would just consume the same structured memories or be
added as one more sink.

## Setup

```bash
npm install                 # installs Electron, Deepgram SDK, InsForge SDK, esbuild
npx @insforge/cli ai setup  # writes OPENROUTER_API_KEY to .env.local (for understanding)
npm start                   # builds the renderer bundle and launches the app
```

Then open **Settings** in the app and paste your **Deepgram API key**
(get one at https://console.deepgram.com). Click **Start listening**.

## Configuration

- **Deepgram key / model / language** — Settings panel (stored locally via `electron-store`, never committed).
- **Sinks** — toggle Markdown and/or InsForge in Settings.
- **Understanding** — toggle on/off and pick the OpenRouter model (default `anthropic/claude-sonnet-4.5`).
- **Markdown output** — defaults to `~/AlwaysListening/` (`sessions/*.md` + `memories.md`). "Open Markdown folder" reveals it.

## InsForge backend

Schema lives in `migrations/` (`sessions`, `transcript_segments`, `memories`)
and is already applied to the linked project. The main process uses the admin
key from `.insforge/project.json` (bypasses RLS) — appropriate for a local,
single-user desktop app. Add user auth + RLS policies before any multi-user or
hosted deployment.

## Notes / limitations

- Deepgram diarization is on, so finalized lines carry a `Speaker N` label when available.
- The Deepgram key is used directly from the renderer to open the live socket — fine for a local desktop app; do not ship it to untrusted clients.
- Understanding runs on a rolling buffer (every ~120 new words or ~45s) to keep LLM calls bounded.
