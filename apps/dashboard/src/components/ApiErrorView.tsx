// ApiErrorView — a friendly inline error display for server-component pages.
//
// Used when a dashboard page's data fetch throws an ApiError that isn't a
// redirect-worthy auth/tenant issue (those are handled by `handleApiError`).

import type { ApiError } from "@/lib/api";

export interface ApiErrorViewProps {
  error: ApiError;
}

export function ApiErrorView({ error }: ApiErrorViewProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-900">
        {error.code.replace(/_/g, " ")}
      </p>
      <p className="mt-1 text-sm text-red-700">{error.message}</p>
      {error.suggestion && (
        <p className="mt-1 text-xs text-red-500">{error.suggestion}</p>
      )}
    </div>
  );
}
