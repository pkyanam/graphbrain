// Graph — Phase 2 stub. No API endpoint exists for knowledge graph
// visualization. Show a "Coming in Phase 2" state.

export default function GraphPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Graph</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Knowledge graph visualization.
        </p>
      </div>
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-12 text-center">
        <p className="text-sm font-medium text-neutral-500">Coming in Phase 2</p>
        <p className="mt-1 text-xs text-neutral-400">
          Knowledge graph visualization is not built in Phase 1.
        </p>
      </div>
    </div>
  );
}
