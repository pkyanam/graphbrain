// API key management — list existing keys + create new keys (one-time secret
// display) + revoke. Server component fetches the initial list; the
// ApiKeyTable client component handles create/revoke interactions.

import { ApiError, api } from "@/lib/api";
import { handleApiError } from "@/lib/handle-error";
import { ApiKeyTable } from "@/components/ApiKeyTable";
import { ApiErrorView } from "@/components/ApiErrorView";

export default async function ApiKeysPage(): Promise<React.JSX.Element> {
  let keys = null;
  let error: ApiError | null = null;

  try {
    const output = await api.listApiKeys();
    keys = output.keys;
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
        <h1 className="text-2xl font-bold text-neutral-900">API Keys</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Manage API keys for MCP agents. The secret is shown only once at
          creation — store it securely.
        </p>
      </div>

      {error && <ApiErrorView error={error} />}

      {keys && <ApiKeyTable initialKeys={keys} />}
    </div>
  );
}
