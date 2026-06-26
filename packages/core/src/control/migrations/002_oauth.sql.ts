// Migration 002 — `_graphbrain.oauth_clients` + `_graphbrain.oauth_tokens`.
//
// Phase 1 minimal columns per IMPLEMENTATION.md step 5. These tables store
// Clerk-issued API key references (the API-key auth mode in
// `packages/core/src/types.ts` → `AuthInfo`). The full OAuth 2.1 schema
// (authorization codes, refresh tokens, PKCE) lands in a later phase; for
// now we only need enough to record which client a token belongs to and
// when it was revoked.
//
// Idempotent: every statement uses IF NOT EXISTS.

export const MIGRATION_002_NAME = "oauth_tables";
export const MIGRATION_002_VERSION = 2;

export const MIGRATION_002_SQL = /* sql */ `
  CREATE SCHEMA IF NOT EXISTS _graphbrain;

  CREATE TABLE IF NOT EXISTS _graphbrain.oauth_clients (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     TEXT         NOT NULL UNIQUE,
    tenant_id     UUID         NOT NULL REFERENCES _graphbrain.tenants(id) ON DELETE CASCADE,
    name          TEXT,
    scopes        TEXT[]       NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    revoked_at    TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id
    ON _graphbrain.oauth_clients (client_id);

  CREATE INDEX IF NOT EXISTS idx_oauth_clients_tenant_id
    ON _graphbrain.oauth_clients (tenant_id);

  CREATE TABLE IF NOT EXISTS _graphbrain.oauth_tokens (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     TEXT         NOT NULL REFERENCES _graphbrain.oauth_clients(client_id) ON DELETE CASCADE,
    tenant_id     UUID         NOT NULL REFERENCES _graphbrain.tenants(id) ON DELETE CASCADE,
    token_hash    TEXT         NOT NULL UNIQUE,
    scopes        TEXT[]       NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_token_hash
    ON _graphbrain.oauth_tokens (token_hash)
    WHERE revoked_at IS NULL;

  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_tenant_id
    ON _graphbrain.oauth_tokens (tenant_id);
`;
