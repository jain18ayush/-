-- Schema for the always-listening transcription app.
-- A session is one continuous listening run. Transcript segments are the raw
-- finalized Deepgram output. Memories are the LLM-distilled "understanding".

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  title text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.sessions(id) on delete cascade,
  text text not null,
  speaker text,
  start_ms double precision,
  end_ms double precision,
  is_final boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.sessions(id) on delete set null,
  kind text not null default 'note', -- note | action_item | question | entity | decision
  content text not null,
  tags text[] default '{}',
  source_excerpt text,
  created_at timestamptz not null default now()
);

create index if not exists transcript_segments_session_created_idx
  on public.transcript_segments (session_id, created_at);

create index if not exists memories_session_created_idx
  on public.memories (session_id, created_at);

-- This desktop app reaches the backend through the admin (service) key from the
-- trusted Electron main process, which bypasses RLS. Enable RLS so the tables
-- are not exposed to the anon key by default; add user-scoped policies later if
-- the app gains end-user auth.
alter table public.sessions enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.memories enable row level security;
