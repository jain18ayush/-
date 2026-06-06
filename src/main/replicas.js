'use strict';

// Replicas adapter — spins up a background coding agent ("replica") in an
// isolated cloud workspace. Docs: https://docs.tryreplicas.com
//
// Auth is a Bearer API key (REPLICAS_API_KEY), kept server-side in the Electron
// main process. We default to the org's repo-less "Global" environment so a
// spoken "build me X" can start from scratch with no repo.

const API_BASE = process.env.REPLICAS_API_BASE || 'https://api.tryreplicas.com';
// The API exposes no per-replica viewer URL, and the docs discourage
// deep-linking the dashboard. Link to the dashboard root, where the freshly
// created replica appears at the top of the list.
const DASHBOARD_URL = process.env.REPLICAS_DASHBOARD_URL || 'https://tryreplicas.com/dashboard';

function getApiKey() {
  return process.env.REPLICAS_API_KEY || '';
}

function isConfigured() {
  return Boolean(getApiKey());
}

async function api(pathname, { method = 'GET', body } = {}) {
  const key = getApiKey();
  if (!key) throw new Error('REPLICAS_API_KEY not set (add it to .env.local)');
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      // Opt into the non-blocking create behavior; the workspace boots async.
      'X-Replicas-Api-Version': '2026-05-17'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`;
    throw new Error(`Replicas API: ${msg}`);
  }
  return json;
}

// Replica name must not contain whitespace.
function slugifyName(input) {
  const base = (input || 'voice-build')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'voice-build';
  return `${base}-${Date.now().toString(36)}`;
}

async function listEnvironments() {
  const data = await api('/v1/environments');
  return data.environments || [];
}

/**
 * Spin up a replica with an initial build instruction.
 * @param {object} opts
 * @param {string} opts.message   What to build (the prompt for the agent)
 * @param {string} [opts.name]    Human-readable name (whitespace stripped)
 * @param {string} [opts.environmentId]
 * @param {string} [opts.codingAgent] 'codex' (default) | 'claude'
 * @param {string} [opts.model]
 */
async function createReplica(opts) {
  const message = (opts.message || '').trim();
  if (!message) throw new Error('A build instruction (message) is required');

  const environment_id = opts.environmentId || process.env.REPLICAS_ENVIRONMENT_ID;
  if (!environment_id) {
    throw new Error('No environment_id (set REPLICAS_ENVIRONMENT_ID or pass one)');
  }

  const body = {
    name: slugifyName(opts.name || message),
    message,
    environment_id,
    coding_agent: opts.codingAgent || 'codex',
    lifecycle_policy: 'default'
  };
  if (opts.model) body.model = opts.model;
  if (opts.thinkingLevel) body.thinking_level = opts.thinkingLevel;

  const data = await api('/v1/replica', { method: 'POST', body });
  const replica = data.replica || data;
  return {
    id: replica.id,
    name: replica.name,
    status: replica.status,
    // No per-replica URL in the API — link to the dashboard list.
    url: DASHBOARD_URL
  };
}

/**
 * Fetch a single replica's current state (for polling status after create).
 * @param {string} id
 */
async function getReplica(id) {
  if (!id) throw new Error('replica id is required');
  const data = await api(`/v1/replica/${id}`);
  const replica = data.replica || data;
  return {
    id: replica.id,
    name: replica.name,
    status: replica.status,
    url: DASHBOARD_URL
  };
}

module.exports = { API_BASE, isConfigured, listEnvironments, createReplica, getReplica, slugifyName };
