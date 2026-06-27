"use client";

// SettingsForm — the tenant settings form.
//
// Pre-filled from GET /api/dashboard/settings. Submit → PUT /api/dashboard/settings
// with the changed fields. Shows success/error feedback inline.

import { useState } from "react";
import type { TenantSettings } from "@graphbrain/core";
import { ApiError } from "@/lib/api-core";
import { useApi } from "@/lib/use-api";

export interface SettingsFormProps {
  initialSettings: TenantSettings;
}

export function SettingsForm({ initialSettings }: SettingsFormProps): React.JSX.Element {
  const api = useApi();
  const [chatModel, setChatModel] = useState(initialSettings.chatModel ?? "");
  const [embeddingModel, setEmbeddingModel] = useState(initialSettings.embeddingModel ?? "");
  const [searchMode, setSearchMode] = useState(initialSettings.searchMode ?? "balanced");
  const [rerankerEnabled, setRerankerEnabled] = useState(initialSettings.rerankerEnabled ?? true);
  const [monthlyCostCapUsd, setMonthlyCostCapUsd] = useState(
    initialSettings.monthlyCostCapUsd?.toString() ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; message: string } | null>(null);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    const patch: Partial<TenantSettings> = {
      chatModel: chatModel.trim() || undefined,
      embeddingModel: embeddingModel.trim() || undefined,
      searchMode: searchMode as TenantSettings["searchMode"],
      rerankerEnabled,
      monthlyCostCapUsd: monthlyCostCapUsd.trim()
        ? Number(monthlyCostCapUsd)
        : undefined,
    };
    try {
      const result = await api.updateSettings(patch);
      setFeedback({ kind: "ok", message: "Settings saved." });
      // Sync local state from the persisted result.
      const s = result.settings;
      setChatModel(s.chatModel ?? "");
      setEmbeddingModel(s.embeddingModel ?? "");
      setRerankerEnabled(s.rerankerEnabled ?? true);
    } catch (err) {
      setFeedback({
        kind: "err",
        message: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-lg space-y-5">
      <div>
        <label htmlFor="chatModel" className="block text-sm font-medium text-neutral-700">
          Chat model
        </label>
        <input
          id="chatModel"
          type="text"
          value={chatModel}
          onChange={(e) => setChatModel(e.target.value)}
          placeholder="anthropic:claude-sonnet-4-6"
          className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
        />
        <p className="mt-1 text-xs text-neutral-400">
          Provider:model id (e.g. &quot;anthropic:claude-sonnet-4-6&quot;).
        </p>
      </div>

      <div>
        <label htmlFor="embeddingModel" className="block text-sm font-medium text-neutral-700">
          Embedding model
        </label>
        <input
          id="embeddingModel"
          type="text"
          value={embeddingModel}
          onChange={(e) => setEmbeddingModel(e.target.value)}
          placeholder="voyage:voyage-3-large"
          className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
        />
      </div>

      <div>
        <label htmlFor="searchMode" className="block text-sm font-medium text-neutral-700">
          Search mode
        </label>
        <select
          id="searchMode"
          value={searchMode}
          onChange={(e) => setSearchMode(e.target.value as "conservative" | "balanced" | "tokenmax")}
          className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
        >
          <option value="conservative">Conservative</option>
          <option value="balanced">Balanced</option>
          <option value="tokenmax">Token-max</option>
        </select>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="rerankerEnabled"
          type="checkbox"
          checked={rerankerEnabled}
          onChange={(e) => setRerankerEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
        />
        <label htmlFor="rerankerEnabled" className="text-sm font-medium text-neutral-700">
          Reranker enabled
        </label>
      </div>

      <div>
        <label htmlFor="monthlyCostCapUsd" className="block text-sm font-medium text-neutral-700">
          Monthly cost cap (USD)
        </label>
        <input
          id="monthlyCostCapUsd"
          type="number"
          min="0"
          step="0.01"
          value={monthlyCostCapUsd}
          onChange={(e) => setMonthlyCostCapUsd(e.target.value)}
          placeholder="100"
          className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
        />
      </div>

      {feedback && (
        <p
          className={
            feedback.kind === "ok"
              ? "text-sm text-green-600"
              : "text-sm text-red-600"
          }
        >
          {feedback.message}
        </p>
      )}

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}
