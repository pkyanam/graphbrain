// StatCard — a single stat (label + value).

export interface StatCardProps {
  label: string;
  value: number | string;
}

export function StatCard({ label, value }: StatCardProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-neutral-500">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-neutral-900">
        {value}
      </p>
    </div>
  );
}
