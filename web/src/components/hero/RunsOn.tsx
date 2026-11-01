"use client";

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
  return (
    <div className="mt-20 border-y border-rule py-5">
      <h2 className="sr-only">Runs on</h2>
      <LogoLoop logos={ITEMS} speed={36} gap={32} logoHeight={28} pauseOnHover intro={false} draggable={false} ariaLabel="Runs on" />
    </div>
  );
}
