// Settings — tenant AI model config, embedding model, search mode, cost cap.
// Server component fetches current settings; the SettingsForm client component
// handles the form submission (PUT /api/dashboard/settings).

import { ApiError, api } from "@/lib/api";
import { handleApiError } from "@/lib/handle-error";
import { SettingsForm } from "@/components/SettingsForm";
import { ApiErrorView } from "@/components/ApiErrorView";

export default async function SettingsPage(): Promise<React.JSX.Element> {
  let settings = null;
  let error: ApiError | null = null;

  try {
    const output = await api.getSettings();
    settings = output.settings;
  } catch (err) {
    try {
      handleApiError(err);
    } catch (e) {
      error = e as ApiError;
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Settings</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Configure your brain&apos;s AI models and retrieval behavior.
        </p>
      </div>

      {error && <ApiErrorView error={error} />}

      {settings && <SettingsForm initialSettings={settings} />}
    </div>
  );
}
