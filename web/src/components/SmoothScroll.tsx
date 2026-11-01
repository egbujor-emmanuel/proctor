"use client";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";

gsap.registerPlugin(ScrollTrigger);

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
/** GSAP's default lag smoothing, restored when smooth scrolling stops. */
const LAG_THRESHOLD_MS = 500;
const LAG_ADJUSTED_MS = 33;

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True when the visitor asked the OS for less motion. Updates live. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    // The static HTML is rendered without motion preferences; smooth
    // scrolling starts once the browser answers.
    () => true,
  );
}

/**
 * Lenis smooth scrolling driven by GSAP's ticker, so ScrollTrigger and Lenis
 * share one clock. Lenis is created and destroyed here rather than through a
 * wrapper component: the React tree never changes shape (so nothing remounts
 * after hydration), and the ticker always has the instance it drives. Off
 * entirely for reduced-motion visitors, and it follows live OS changes.
 */
export function SmoothScroll({ children }: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) return;
    // Anchor jumps land below the sticky header, whose height changes with
    // the viewport (it wraps to two rows on small screens).
    const headerHeight = document.querySelector("header")?.getBoundingClientRect().height ?? 72;
    const lenis = new Lenis({ lerp: 0.12, autoRaf: false, anchors: { offset: -Math.ceil(headerHeight) } });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(LAG_THRESHOLD_MS, LAG_ADJUSTED_MS);
      lenis.destroy();
    };
  }, [reduced]);

  return <>{children}</>;
}
