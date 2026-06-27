"use client";

// ProvisioningSpinner — the onboarding provisioning progress UI.
//
// Polls GET /api/dashboard/stats until it returns 200 (brain ready). The API
// returns 403 (tenant_not_found) when no tenant exists for the org, and 503
// (tenant_not_active) while provisioning. A 200 means the brain is ready.
//
// Polling strategy: every 3s, max 60 attempts (~3 min). Shows a spinner +
// rotating status messages. On success, redirects to /dashboard. On timeout,
// shows a retry button.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api-core";
import { useApi } from "@/lib/use-api";

const POLL_INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 60;

const STATUS_MESSAGES = [
  "Creating your brain…",
  "Deploying HelixDB…",
  "Building indexes…",
  "Almost ready…",
];

export function ProvisioningSpinner(): React.JSX.Element {
  const router = useRouter();
  const api = useApi();
  const [attempt, setAttempt] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (timedOut) return;

    let timer: ReturnType<typeof setTimeout>;

    async function poll(): Promise<void> {
      if (attempt >= MAX_ATTEMPTS) {
        setTimedOut(true);
        return;
      }
      try {
        await api.stats();
        if (mounted.current) {
          router.replace("/dashboard");
        }
        return;
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof ApiError) {
          // 403 tenant_not_found or 503 tenant_not_active → keep polling.
          if (err.status === 403 || err.status === 503) {
            setLastError(err.message);
            setAttempt((a) => a + 1);
            timer = setTimeout(poll, POLL_INTERVAL_MS);
            return;
          }
          // Other errors (e.g. 401 unauthenticated) → stop + surface.
          setLastError(err.message);
          setTimedOut(true);
          return;
        }
        setLastError(err instanceof Error ? err.message : String(err));
        setAttempt((a) => a + 1);
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    poll();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [attempt, timedOut, router, api]);

  const statusIndex = Math.min(
    Math.floor((attempt / MAX_ATTEMPTS) * STATUS_MESSAGES.length),
    STATUS_MESSAGES.length - 1,
  );

  if (timedOut) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <p className="text-sm font-medium text-neutral-900">
          Provisioning is taking longer than expected.
        </p>
        {lastError && (
          <p className="max-w-md text-xs text-neutral-500">{lastError}</p>
        )}
        <button
          type="button"
          onClick={() => {
            setTimedOut(false);
            setAttempt(0);
            setLastError(null);
          }}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
      <p className="text-sm font-medium text-neutral-900">
        {STATUS_MESSAGES[statusIndex]}
      </p>
      <p className="text-xs text-neutral-400">
        Attempt {attempt + 1} of {MAX_ATTEMPTS}
      </p>
      {lastError && (
        <p className="max-w-md text-xs text-neutral-400">{lastError}</p>
      )}
    </div>
  );
}
