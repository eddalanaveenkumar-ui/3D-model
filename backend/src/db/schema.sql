-- ============================================================================
-- NV3D Studio — PostgreSQL Schema (PostgreSQL 14+ / Supabase / PGlite)
-- Tables: users, user_credits, generation_jobs, generated_models,
--         uploaded_images, generation_history
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_guest BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_credits (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 250 CHECK (balance >= 0),
  lifetime_granted INTEGER NOT NULL DEFAULT 250 CHECK (lifetime_granted >= 0),
  lifetime_spent INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_spent >= 0),
  last_transaction_delta INTEGER NOT NULL DEFAULT 250,
  last_transaction_reason TEXT NOT NULL DEFAULT 'Initial studio allocation',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('text', 'image')),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'enhancing', 'submitting', 'processing',
    'downloading', 'optimizing', 'validating', 'succeeded',
    'failed', 'provider_unconfigured'
  )),
  stage_label TEXT NOT NULL DEFAULT 'Queued',
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  prompt TEXT,
  enhanced_prompt TEXT,
  structured_spec JSONB,
  settings JSONB NOT NULL,
  provider_id TEXT,
  external_job_id TEXT,
  model_id UUID,
  credits_charged INTEGER NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
  credits_refunded BOOLEAN NOT NULL DEFAULT FALSE,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS generated_models (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  job_id UUID REFERENCES generation_jobs(id) ON DELETE SET NULL,
  demo_slug TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL CHECK (category IN (
    'human', 'animal', 'car', 'building', 'furniture', 'prop', 'tree', 'environment'
  )),
  style TEXT NOT NULL DEFAULT 'realistic-pbr',
  source_type TEXT NOT NULL CHECK (source_type IN ('generated', 'demo_sample', 'user_import')),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  provider_id TEXT NOT NULL,
  prompt TEXT,
  structured_spec JSONB,
  settings JSONB,
  storage_key TEXT NOT NULL UNIQUE,
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
  sha256 TEXT NOT NULL,
  gltf_export_supported BOOLEAN NOT NULL DEFAULT TRUE,
  validated BOOLEAN NOT NULL DEFAULT FALSE,
  validation_report JSONB NOT NULL,
  statistics JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS uploaded_images (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id UUID REFERENCES generation_jobs(id) ON DELETE SET NULL,
  view_angle TEXT NOT NULL CHECK (view_angle IN ('front', 'side', 'back')),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  storage_key TEXT NOT NULL UNIQUE,
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generation_history (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id UUID REFERENCES generation_jobs(id) ON DELETE SET NULL,
  model_id UUID REFERENCES generated_models(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('text', 'image', 'import', 'system')),
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  prompt TEXT,
  provider_id TEXT,
  credits_delta INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_generation_jobs_user_created ON generation_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_status ON generation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_external ON generation_jobs(provider_id, external_job_id);
CREATE INDEX IF NOT EXISTS idx_generated_models_user_created ON generated_models(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_models_is_demo ON generated_models(is_demo);
CREATE INDEX IF NOT EXISTS idx_uploaded_images_user_job ON uploaded_images(user_id, job_id);
CREATE INDEX IF NOT EXISTS idx_generation_history_user_created ON generation_history(user_id, created_at DESC);
