"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import SplitFlapText from "@/components/bits/SplitFlapText";
import { useDarkScheme, useReducedMotion } from "@/hooks/useMediaQuery";

import { BOARD_INK, type Token } from "./tokens";

// WebGL, so it loads in its own chunk after the page is readable.
const PhaseRadar = dynamic(() => import("./PhaseRadar"), { ssr: false });

/** The lifecycle the registry contract enforces (see tests/agents.rs). */
const PHASES: { step: string; score: string; status: string; token: Token; note: string }[] = [
  { step: "Sitting", score: "5/5", status: "ACTIVE", token: "--active", note: "Passes the sealed exam. The certificate is written to NEAR." },
  { step: "Re-test 1", score: "1/5", status: "SUSPENDED", token: "--suspended", note: "The owner quietly swaps in a cheaper model. A surprise re-test catches it." },
  { step: "Re-test 2", score: "1/5", status: "REVOKED", token: "--revoked", note: "A second failure in a row. Revoked on chain, for every buyer at once." },
];

const HOLD_MS = [3800, 3800, 5200];

/** Hero centrepiece: a re-test radar over a split-flap certificate status board. */
export function HeroScope() {
  const root = useRef<HTMLElement>(null);
  const [phase, setPhase] = useState(0);
  const [isAuto, setIsAuto] = useState(true);
  const [isVisible, setIsVisible] = useState(false);
  const isReduced = useReducedMotion();
  const isDark = useDarkScheme();
  const current = PHASES[phase];

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting), { threshold: 0.2 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isAuto || isReduced || !isVisible) return;
    const timer = setTimeout(() => setPhase((p) => (p + 1) % PHASES.length), HOLD_MS[phase]);
    return () => clearTimeout(timer);
  }, [phase, isAuto, isReduced, isVisible]);

  const choose = (index: number) => {
    setIsAuto(false);
    setPhase(index);
  };

  return (
    <figure ref={root} aria-labelledby="scope-caption" className="relative mx-auto w-full max-w-[440px]">
      <div className="relative aspect-square w-full overflow-hidden rounded-full border border-rule bg-paper-sunk shadow-[inset_0_0_0_10px_var(--paper),inset_0_0_0_11px_var(--rule)]">
        <PhaseRadar token={current.token} isDark={isDark} isPaused={isReduced} />
        <p aria-hidden="true" className="absolute left-1/2 top-[18%] -translate-x-1/2 font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">
          Surprise re-test
        </p>
      </div>

      <div aria-hidden="true" className="relative -mt-14 mx-auto w-fit rounded-md border border-rule bg-paper-raised px-4 pb-3 pt-2.5 shadow-[0_18px_40px_-24px_rgba(22,20,15,0.5)]">
        <div className="flex items-baseline justify-between gap-6 font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">
          <span>agent:you.testnet/bot</span>
          <span>
            {current.step} · <span className="text-ink">{current.score}</span>
          </span>
        </div>
        <SplitFlapText
          text={current.status}
          padTo={9}
          align="center"
          fontSize={30}
          gap={3}
          tileRadius={4}
          tileColor="#16140f"
          textColor={BOARD_INK[current.token]}
          charset="alpha"
          flipsPerChar={5}
          stagger={0.04}
          depth={0.6}
          className="mt-2"
        />
      </div>

      <figcaption id="scope-caption" className="mt-5 text-center text-sm leading-relaxed text-ink-muted">
        <span className="sr-only">
          An illustration, not live data. How a certificate dies when an agent swaps in a weaker model: it passes its sitting 5 of 5 and is certified; a surprise re-test
          scores 1 of 5 and suspends it; a second scores 1 of 5 and revokes it.
        </span>
        <span aria-hidden="true">
          <span className="font-mono text-xs uppercase tracking-[0.14em]">Illustration · </span>
          {current.note}
        </span>
      </figcaption>

      <div role="group" aria-label="Show a stage of the certificate lifecycle" className="mt-4 flex justify-center gap-2">
        {PHASES.map((p, index) => (
          <button
            key={p.step}
            type="button"
            aria-pressed={index === phase}
            onClick={() => choose(index)}
            className="min-h-10 rounded-full border border-rule px-3.5 font-mono text-xs uppercase tracking-[0.12em] text-ink-muted transition-colors hover:border-ink hover:text-ink aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-paper"
          >
            {p.step}
          </button>
        ))}
      </div>
    </figure>
  );
}
