// Migration 001 — `_graphbrain.tenants` schema + table.
//
// The control-plane source of truth for Clerk org → HelixDB instance mapping.
// One row per tenant. `helix_instance_url` + `helix_api_key_encrypted` are
// written by Stage 3 (Coolify provisioning); until then they are NULL and
// `status` stays 'pending'.
//
// `helix_api_key_encrypted` is stored as TEXT containing the AES-256-GCM
// ciphertext in the format `base64(iv:ciphertext:tag)` produced by Stage 3's
// encryption.ts. (TEXT, not BYTEA, so it round-trips through JSON snapshots
// and psql without binary-escape pain.)
//
// Idempotent: every statement uses IF NOT EXISTS / DO block guards so the
// migration runner can re-run it safely.

export const MIGRATION_001_NAME = "tenants_table";
export const MIGRATION_001_VERSION = 1;

export const MIGRATION_001_SQL = /* sql */ `
  -- Dedicated schema keeps the control plane isolated from any per-tenant
  -- or extension-owned objects in the public namespace.
  CREATE SCHEMA IF NOT EXISTS _graphbrain;

  CREATE TABLE IF NOT EXISTS _graphbrain.tenants (
    id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    clerk_org_id             TEXT         NOT NULL UNIQUE,
    name                     TEXT         NOT NULL,
    slug                     TEXT         NOT NULL UNIQUE,
    helix_instance_url       TEXT,
    helix_api_key_encrypted  TEXT,
    coolify_app_id           TEXT,
    tier                     TEXT         NOT NULL DEFAULT 'free'
      CHECK (tier IN ('free', 'pro', 'enterprise')),
    status                   TEXT         NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'active', 'suspended', 'deleted', 'error')),
    settings                 JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_tenants_clerk_org_id
    ON _graphbrain.tenants (clerk_org_id);

  CREATE INDEX IF NOT EXISTS idx_tenants_slug
    ON _graphbrain.tenants (slug);

  CREATE INDEX IF NOT EXISTS idx_tenants_status
    ON _graphbrain.tenants (status);
`;
