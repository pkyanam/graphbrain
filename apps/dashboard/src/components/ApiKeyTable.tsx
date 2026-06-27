"use client";

// ApiKeyTable — table of API keys + the "create new key" flow with one-time
// secret display + revoke.
//
// The raw secret is returned ONLY at creation time (Clerk does not store
// plaintext). The UI shows it once in a copyable field with a warning, then
// it's gone forever.

import { useState } from "react";
import type { ClerkApiKey } from "@graphbrain/core";
import { ApiError } from "@/lib/api-core";
import { useApi } from "@/lib/use-api";

export interface ApiKeyTableProps {
  initialKeys: ClerkApiKey[];
}

export function ApiKeyTable({ initialKeys }: ApiKeyTableProps): React.JSX.Element {
  const api = useApi();
  const [keys, setKeys] = useState<ClerkApiKey[]>(initialKeys);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setNewSecret(null);
    try {
      const result = await api.createApiKey({ name: name.trim() || undefined });
      setNewSecret(result.secret);
      setName("");
      // Refresh the list to include the new key.
      const list = await api.listApiKeys();
      setKeys(list.keys);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string): Promise<void> {
    setRevokingId(id);
    setError(null);
    try {
      await api.revokeApiKey(id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRevokingId(null);
    }
  }

  async function copySecret(): Promise<void> {
    if (!newSecret) return;
    try {
      await navigator.clipboard.writeText(newSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; the field is still selectable.
    }
  }

  return (
    <div className="space-y-6">
      {/* One-time secret display */}
      {newSecret && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            Save this key now — it won&apos;t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-white px-3 py-2 text-xs text-neutral-900">
              {newSecret}
            </code>
            <button
              type="button"
              onClick={copySecret}
              className="shrink-0 rounded bg-amber-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-amber-800"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setNewSecret(null)}
              className="shrink-0 rounded border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      <form onSubmit={onCreate} className="flex items-end gap-2">
        <div className="flex-1">
          <label
            htmlFor="apikey-name"
            className="block text-xs font-medium text-neutral-500"
          >
            Key name (optional)
          </label>
          <input
            id="apikey-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My MCP agent key"
            className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="shrink-0 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create key"}
        </button>
      </form>

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}

      {/* Key list */}
      <div className="overflow-hidden rounded-lg border border-neutral-200">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Scopes</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200 bg-white">
            {keys.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-neutral-500">
                  No API keys yet. Create one above.
                </td>
              </tr>
            ) : (
              keys.map((k) => (
                <tr key={k.id}>
                  <td className="px-4 py-2 font-medium text-neutral-900">
                    {k.name || "(unnamed)"}
                  </td>
                  <td className="px-4 py-2 text-neutral-600">
                    {k.scopes.join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2">
                    {k.revoked ? (
                      <span className="text-red-600">Revoked</span>
                    ) : (
                      <span className="text-green-600">Active</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!k.revoked && (
                      <button
                        type="button"
                        onClick={() => onRevoke(k.id)}
                        disabled={revokingId === k.id}
                        className="text-xs font-medium text-red-600 transition hover:text-red-800 disabled:opacity-50"
                      >
                        {revokingId === k.id ? "Revoking…" : "Revoke"}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
