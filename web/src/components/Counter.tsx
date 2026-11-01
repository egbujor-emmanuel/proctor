"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useRef } from "react";

gsap.registerPlugin(useGSAP);

/**
 * A number that counts up from 0 when it first appears. Reduced-motion
 * visitors see the final value at once; screen readers always get the value.
 */
export function Counter({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || value === 0) {
        el.textContent = String(value);
        return;
      }
      const state = { n: 0 };
      gsap.to(state, {
        n: value,
        duration: Math.min(1.2, 0.4 + value * 0.08),
        ease: "power3.out",
        onUpdate: () => {
          el.textContent = String(Math.round(state.n));
        },
      });
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
