"use client";

// SearchBar — input that navigates to /dashboard/search?q= on submit.

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface SearchBarProps {
  initialValue?: string;
  placeholder?: string;
}

export function SearchBar({
  initialValue = "",
  placeholder = "Search your brain…",
}: SearchBarProps): React.JSX.Element {
  const router = useRouter();
  const [q, setQ] = useState(initialValue);

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = q.trim();
    if (trimmed) {
      router.push(`/dashboard/search?q=${encodeURIComponent(trimmed)}`);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full gap-2">
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
        autoFocus
      />
      <button
        type="submit"
        className="shrink-0 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700"
      >
        Search
      </button>
    </form>
  );
}
