"use client";

import Shuffle from "@/components/bits/Shuffle";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A section label that unscrambles once on arrival, like a sealed field opening. */
export function Eyebrow({ text, className = "text-seal" }: { text: string; className?: string }) {
  return (
    <p className={`font-mono text-xs uppercase tracking-[0.18em] ${className}`}>
      {/* The animated copy holds scramble glyphs mid-run, so readers get a plain one. */}
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        <Shuffle
          text={text}
          tag="span"
          className="font-mono"
          shuffleDirection="right"
          duration={0.35}
          shuffleTimes={2}
          stagger={0.02}
          scrambleCharset={CHARSET}
          threshold={0.15}
          triggerOnHover
        />
      </span>
    </p>
  );
}
