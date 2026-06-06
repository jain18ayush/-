'use strict';

const fs = require('fs');
const path = require('path');

// The Electron main process is trusted, so we talk to InsForge with the admin
// (service) key, which bypasses RLS. The key + base URL come from the linked
// project file written by `npx @insforge/cli link`, never from source.
function loadProjectConfig() {
  const file = path.join(__dirname, '..', '..', '.insforge', 'project.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { baseUrl: raw.oss_host, apiKey: raw.api_key };
  } catch (err) {
    return { baseUrl: null, apiKey: null, error: err.message };
  }
}

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { baseUrl, apiKey } = loadProjectConfig();
      if (!baseUrl || !apiKey) return null;
      const { createAdminClient } = await import('@insforge/sdk');
      return createAdminClient({ baseUrl, apiKey });
    })();
  }
  return clientPromise;
}

async function createSession(title) {
  const client = await getClient();
  if (!client) return null;
  const { data, error } = await client.database
    .from('sessions')
    .insert([{ title: title || null }])
    .select();
  if (error) {
    console.error('[insforge] createSession failed:', error.message || error);
    return null;
  }
  return data && data[0] ? data[0].id : null;
}

async function endSession(sessionId) {
  if (!sessionId) return;
  const client = await getClient();
  if (!client) return;
  const { error } = await client.database
    .from('sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', sessionId);
  if (error) console.error('[insforge] endSession failed:', error.message || error);
}

async function insertSegment(sessionId, seg) {
  const client = await getClient();
  if (!client) return;
  const { error } = await client.database.from('transcript_segments').insert([
    {
      session_id: sessionId || null,
      text: seg.text,
      speaker: seg.speaker || null,
      start_ms: seg.startMs ?? null,
      end_ms: seg.endMs ?? null,
      is_final: true
    }
  ]);
  if (error) console.error('[insforge] insertSegment failed:', error.message || error);
}

async function insertMemory(sessionId, mem) {
  const client = await getClient();
  if (!client) return;
  const { error } = await client.database.from('memories').insert([
    {
      session_id: sessionId || null,
      kind: mem.kind || 'note',
      content: mem.content,
      tags: mem.tags || [],
      source_excerpt: mem.sourceExcerpt || null
    }
  ]);
  if (error) console.error('[insforge] insertMemory failed:', error.message || error);
}

module.exports = {
  loadProjectConfig,
  getClient,
  createSession,
  endSession,
  insertSegment,
  insertMemory
};
