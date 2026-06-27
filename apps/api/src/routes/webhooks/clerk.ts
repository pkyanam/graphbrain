// Clerk webhook route (Stage 12) — POST /webhooks/clerk.
//
// Receives org-lifecycle events from Clerk (organization.created / .updated /
// .deleted, api_key.created / .revoked). Verifies the Svix signature on the
// RAW body, then dispatches via `handleClerkWebhook` (provisions/deprovisions
// tenants).
//
// Webhook best practice: respond 200 ALWAYS, even on handler errors. Clerk /
// Svix retry on non-2xx, and retries can mask real issues + pile up. So we
// log errors to stderr and still return 200. The one exception is a missing
// raw body (misconfigured middleware) — that's a 500-class server error, but
// we still respond 200 to avoid retries (logged loudly).
//
// Raw body: this route is mounted with `express.raw({ type: 'application/json' })`
// BEFORE `express.json()` so the raw bytes are available for signature
// verification. `req.body` arrives as a Buffer.

import { Router } from "express";
import { handleClerkWebhook, type WebhookDeps, type WebhookResult } from "@graphbrain/core";

/** Injectable deps for the webhook handler (tests pass mocks). */
export interface ClerkWebhookRouteDeps {
  /** WebhookDeps passed through to handleClerkWebhook. */
  webhookDeps?: WebhookDeps;
}

/**
 * Build the Clerk webhook router. Mount at the app root with
 * `express.raw({ type: 'application/json' })` applied to `/webhooks/*` BEFORE
 * the global `express.json()`.
 */
export function clerkWebhookRouter(routeDeps: ClerkWebhookRouteDeps = {}): Router {
  const router = Router();

  router.post("/webhooks/clerk", async (req, res) => {
    // req.body is a Buffer when express.raw parsed it; a string if a upstream
    // middleware already converted it. handleClerkWebhook wants a string.
    let rawBody: string;
    if (Buffer.isBuffer(req.body)) {
      rawBody = req.body.toString("utf8");
    } else if (typeof req.body === "string") {
      rawBody = req.body;
    } else if (req.body === undefined || req.body === null) {
      // No raw body — middleware misconfiguration. Log + 200 (webhook best
      // practice: never let a server bug trigger Clerk retries).
      process.stderr.write(
        "[graphbrain-api] /webhooks/clerk: no raw body — express.raw middleware did not run.\n",
      );
      res.status(200).json({ ok: false, error: "no raw body" });
      return;
    } else {
      rawBody = JSON.stringify(req.body);
    }

    // Express headers are lowercased Record<string, string>.
    const headers = req.headers as Record<string, string>;

    let result: WebhookResult;
    try {
      result = await handleClerkWebhook(rawBody, headers, routeDeps.webhookDeps);
    } catch (err) {
      // Handler threw unexpectedly — log + 200 (best practice).
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[graphbrain-api] /webhooks/clerk: handleClerkWebhook threw: ${msg}\n`,
      );
      if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n");
      res.status(200).json({ ok: false, error: "webhook handler error" });
      return;
    }

    // Webhook best practice: respond 200 ALWAYS, even when the handler
    // returned a non-200 (e.g. 400 on a bad signature). Returning non-2xx
    // can trigger Clerk/Svix retries, which mask real issues + pile up. The
    // failure is logged to stderr so the operator can investigate; the 200
    // tells Svix "received, don't retry".
    if (result.status >= 400) {
      process.stderr.write(
        `[graphbrain-api] /webhooks/clerk: handler returned status ${result.status}: ` +
          `${JSON.stringify(result.body)}\n`,
      );
    }
    // The handler may return a background provisioning promise. We respond
    // immediately (200) and do NOT await it — provisioning runs async.
    res.status(200).json(result.body ?? { ok: true });
  });

  return router;
}
