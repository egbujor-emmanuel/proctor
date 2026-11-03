"use client";

import { useState } from "react";

import { LogoLoop, type LogoItem } from "@/components/bits/LogoLoop";

// Only what PROCTOR actually runs on; every name here is in the repo.
const STACK = [
  "NEAR Protocol",
  "OutLayer TEE runner",
  "Intel TDX enclaves",
  "NEAR AI Cloud",
  "near-sdk 5",
  "Model Context Protocol",
  "NEAR Agent Market",
];

const ITEMS: LogoItem[] = STACK.map((name) => ({
  node: (
    <span className="flex items-center gap-8 font-serif text-xl italic text-ink-muted">
      {name}
      <span aria-hidden="true" className="font-mono text-xs not-italic text-seal">
        ✦
      </span>
    </span>
  ),
  title: name,
}));

export function RunsOn() {
  // WCAG 2.2.2: anything that moves for more than five seconds can be paused.
  const [isPaused, setIsPaused] = useState(false);
  return (
    <div className="mt-20 flex items-center gap-3 border-y border-rule py-5">
      <h2 className="sr-only">Runs on</h2>
      <div className="min-w-0 flex-1">
        <LogoLoop logos={ITEMS} speed={isPaused ? 0 : 36} gap={32} logoHeight={28} pauseOnHover intro={false} draggable={false} ariaLabel="Runs on" />
      </div>
      <button
        type="button"
        onClick={() => setIsPaused((p) => !p)}
        aria-pressed={isPaused}
        className="min-h-10 shrink-0 rounded border border-rule px-3 font-mono text-xs uppercase tracking-[0.12em] text-ink-muted hover:border-seal hover:text-seal motion-reduce:hidden"
      >
        {isPaused ? "Play" : "Pause"}
        <span className="sr-only"> the scrolling list</span>
      </button>
    </div>
  );
}
