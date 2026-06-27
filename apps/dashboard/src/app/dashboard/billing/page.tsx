// Billing — Phase 2 stub. The billing API (GET /api/dashboard/billing) returns
// 501. Show a "Coming in Phase 2" state; do NOT call the endpoint.

export default function BillingPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Billing</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Usage metering, billing, and plan selection.
        </p>
      </div>
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-12 text-center">
        <p className="text-sm font-medium text-neutral-500">Coming in Phase 2</p>
        <p className="mt-1 text-xs text-neutral-400">
          Usage metering and billing are not built in Phase 1.
        </p>
      </div>
    </div>
  );
}
