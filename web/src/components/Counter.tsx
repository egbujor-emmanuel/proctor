"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useRef } from "react";

gsap.registerPlugin(useGSAP);

/**
 * A number that counts up when it first appears, and on later changes counts
 * from the value it showed. Reduced-motion visitors (including a live OS
 * change) see the final value at once; screen readers always get the value.
 */
export function Counter({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add(
        { motion: "(prefers-reduced-motion: no-preference)", reduce: "(prefers-reduced-motion: reduce)" },
        (context) => {
          if (context.conditions?.reduce || value === shown.current) {
            el.textContent = String(value);
            shown.current = value;
            return;
          }
          const state = { n: shown.current };
          el.textContent = String(state.n);
          gsap.to(state, {
            n: value,
            duration: Math.min(1.2, 0.4 + Math.abs(value - state.n) * 0.08),
            ease: "power3.out",
            onUpdate: () => {
              el.textContent = String(Math.round(state.n));
            },
            onComplete: () => {
              shown.current = value;
            },
          });
        },
      );
      return () => mm.revert();
    },
    { dependencies: [value] },
  );

  return (
    <span className={className}>
      <span ref={ref} aria-hidden="true">
        {value}
      </span>
      <span className="sr-only">{value}</span>
    </span>
  );
}
