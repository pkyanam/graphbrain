// Tests for the env-driven config loader + per-tenant override resolution.

import { describe, it, expect, beforeEach } from "bun:test";
import {
  ConfigSchema,
  loadConfig,
  getConfig,
  resetConfig,
  resolveSetting,
  type Config,
} from "../src/index.ts";

/** A complete valid env dict (matches .env.example). */
const VALID_ENV: Record<string, string> = {
  CLERK_SECRET_KEY: "sk_test_clerk",
  CLERK_PUBLISHABLE_KEY: "pk_test_clerk",
  CLERK_JWT_ISSUER: "https://clerk.acme.com",
  CLERK_WEBHOOK_SECRET: "whsec_test",
  COOLIFY_API_URL: "https://coolify.acme.com",
  COOLIFY_API_TOKEN: "tok_test",
  COOLIFY_SERVER_UUID: "srv_abc",
  OPENROUTER_API_KEY: "or_test",
  ENCRYPTION_KEY: "base64key==",
  POLYGRES_DATABASE_URL: "postgres://graphbrain:graphbrain@localhost:5432/graphbrain_control",
  MINIO_ENDPOINT: "http://localhost:9000",
  MINIO_ACCESS_KEY: "graphbrain",
  MINIO_SECRET_KEY: "graphbrain-dev-secret",
};

describe("ConfigSchema", () => {
  it("accepts a complete valid env dict", () => {
    const cfg = loadConfig(VALID_ENV);
    expect(cfg.clerkSecretKey).toBe("sk_test_clerk");
    expect(cfg.coolifyApiUrl).toBe("https://coolify.acme.com");
  });

  it("applies defaults for optional fields", () => {
    const cfg = loadConfig(VALID_ENV);
    expect(cfg.defaults.chatModel).toBe("anthropic:claude-sonnet-4-6");
    expect(cfg.defaults.embeddingModel).toBe("voyage:voyage-3-large");
    expect(cfg.defaults.embeddingDimensions).toBe(1024);
    expect(cfg.defaults.searchMode).toBe("balanced");
    expect(cfg.defaults.tenantMonthlyCostCapUsd).toBe(50);
    expect(cfg.debug).toBe(false);
    expect(cfg.apiPort).toBe(3000);
  });

  it("honors explicit overrides for optional fields", () => {
    const cfg = loadConfig({
      ...VALID_ENV,
      GRAPHBRAIN_DEBUG: "true",
      API_PORT: "4000",
    });
    expect(cfg.debug).toBe(true);
    expect(cfg.apiPort).toBe(4000);
  });

  it("accepts optional HelixDB local-dev vars", () => {
    const cfg = loadConfig({
      ...VALID_ENV,
      HELIX_INSTANCE_URL: "http://localhost:8080",
      HELIX_API_KEY: "dev-key",
    });
    expect(cfg.helixInstanceUrl).toBe("http://localhost:8080");
    expect(cfg.helixApiKey).toBe("dev-key");
  });
});

describe("loadConfig — error paths", () => {
  it("throws when a required var is missing", () => {
    const { CLERK_SECRET_KEY: _omit, ...missing } = VALID_ENV;
    expect(() => loadConfig(missing)).toThrow(/CLERK_SECRET_KEY/);
  });

  it("throws when a required var is empty string", () => {
    expect(() => loadConfig({ ...VALID_ENV, OPENROUTER_API_KEY: "" })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("throws with a clear multi-var message when several are missing", () => {
    const broken = {
      ...VALID_ENV,
      CLERK_SECRET_KEY: "",
      COOLIFY_API_TOKEN: "",
      ENCRYPTION_KEY: "",
    };
    let err: Error | null = null;
    try {
      loadConfig(broken);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("CLERK_SECRET_KEY");
    expect(err!.message).toContain("COOLIFY_API_TOKEN");
    expect(err!.message).toContain("ENCRYPTION_KEY");
    expect(err!.message).toContain(".env.example");
  });

  it("rejects an invalid URL for POLYGRES_DATABASE_URL", () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, POLYGRES_DATABASE_URL: "not-a-url" }),
    ).toThrow(/POLYGRES_DATABASE_URL/);
  });

  it("rejects an invalid URL for COOLIFY_API_URL", () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, COOLIFY_API_URL: "not-a-url" }),
    ).toThrow(/COOLIFY_API_URL/);
  });
});

describe("getConfig singleton", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("returns a frozen config", () => {
    // Stub process.env for the singleton path.
    const orig = process.env;
    process.env = { ...VALID_ENV };
    try {
      const cfg = getConfig();
      expect(Object.isFrozen(cfg)).toBe(true);
      // Second call returns the same instance.
      expect(getConfig()).toBe(cfg);
    } finally {
      process.env = orig;
      resetConfig();
    }
  });

  it("resetConfig forces a reload on next getConfig", () => {
    const orig = process.env;
    process.env = { ...VALID_ENV };
    try {
      const first = getConfig();
      resetConfig();
      const second = getConfig();
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    } finally {
      process.env = orig;
      resetConfig();
    }
  });
});

describe("resolveSetting — precedence chain", () => {
  const cfg = loadConfig(VALID_ENV);

  it("per-call override wins over tenant settings and global default", () => {
    const v = resolveSetting(
      cfg,
      { searchMode: "tokenmax" },
      { searchMode: "conservative" },
      "searchMode",
    );
    expect(v).toBe("conservative");
  });

  it("tenant settings win over global default when no per-call override", () => {
    const v = resolveSetting(cfg, { searchMode: "tokenmax" }, undefined, "searchMode");
    expect(v).toBe("tokenmax");
  });

  it("falls back to global default when neither tenant nor per-call set it", () => {
    const v = resolveSetting(cfg, undefined, undefined, "searchMode");
    expect(v).toBe("balanced");
  });

  it("returns undefined when no layer sets the key and there's no matching default", () => {
    // `features` is a TenantSettings key with no corresponding Config.defaults entry.
    const v = resolveSetting(cfg, undefined, undefined, "features");
    expect(v).toBeUndefined();
  });

  it("ignores undefined per-call values (does not short-circuit on undefined)", () => {
    const v = resolveSetting(
      cfg,
      { searchMode: "tokenmax" },
      { searchMode: undefined },
      "searchMode",
    );
    expect(v).toBe("tokenmax");
  });
});
