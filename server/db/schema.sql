-- Karix Superagent — multi-tenant schema
-- Target: Postgres (Supabase / Neon). Run via `npm run migrate` or paste into SQL editor.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- One row per client org (MDH Spices, RedTag, Meesho, ...)
CREATE TABLE IF NOT EXISTS organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Karix WABA credentials per org. Karix has separate hosts for India / UAE.
-- karix_token is encrypted at rest by the app layer (see services/crypto.js) — never store plaintext.
CREATE TABLE IF NOT EXISTS waba_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  waba_id           TEXT NOT NULL,
  region            TEXT NOT NULL DEFAULT 'india' CHECK (region IN ('india','uae')),
  karix_token_enc   TEXT NOT NULL,
  label             TEXT,               -- e.g. "MDH Spices - Primary"
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, waba_id)
);

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email             TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('client_admin','member','karix_staff')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every template ever built through the platform, mirroring Karix's own lifecycle.
CREATE TABLE IF NOT EXISTS templates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  waba_account_id   UUID NOT NULL REFERENCES waba_accounts(id) ON DELETE CASCADE,
  created_by        UUID REFERENCES users(id),
  source            TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat','excel_bulk','api')),
  template_name     TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN ('AUTHENTICATION','UTILITY','MARKETING')),
  language          TEXT NOT NULL,
  karix_template_id TEXT,               -- returned by Karix after create; null until submitted
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','pending_review','submitted','approved','rejected','paused','deleted','failed')),
  spec_json         JSONB NOT NULL,     -- full Karix-shaped payload (components, buttons, etc.)
  karix_response    JSONB,              -- raw response from last Karix call, for debugging
  rejection_reason  TEXT,
  edit_count_30d    INT NOT NULL DEFAULT 0,
  last_edited_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_templates_org ON templates(organization_id);
CREATE INDEX IF NOT EXISTS idx_templates_waba ON templates(waba_account_id);
CREATE INDEX IF NOT EXISTS idx_templates_status ON templates(status);

-- Chat-based build sessions (the "ChatGPT-like" conversation state)
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id),
  waba_account_id   UUID REFERENCES waba_accounts(id),
  resulting_template_id UUID REFERENCES templates(id),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content           TEXT NOT NULL,
  tool_payload      JSONB,             -- structured template spec emitted by the agent, if any
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Excel bulk-import jobs
CREATE TABLE IF NOT EXISTS bulk_import_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  waba_account_id   UUID NOT NULL REFERENCES waba_accounts(id),
  uploaded_by       UUID REFERENCES users(id),
  file_name         TEXT NOT NULL,
  total_rows        INT NOT NULL DEFAULT 0,
  processed_rows    INT NOT NULL DEFAULT 0,
  succeeded_rows    INT NOT NULL DEFAULT 0,
  failed_rows       INT NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','completed_with_errors','failed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bulk_import_rows (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID NOT NULL REFERENCES bulk_import_jobs(id) ON DELETE CASCADE,
  row_number        INT NOT NULL,
  raw_row           JSONB NOT NULL,     -- original spreadsheet row, as parsed
  resolved_spec     JSONB,              -- AI-normalized Karix payload
  template_id       UUID REFERENCES templates(id),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validated','submitted','failed','needs_review')),
  error_message     TEXT
);

CREATE INDEX IF NOT EXISTS idx_bulk_rows_job ON bulk_import_rows(job_id);
