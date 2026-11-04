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
    const lenis = new Lenis({ lerp: 0.12, autoRaf: false });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    // In-page links are handled here, not by Lenis's `anchors` option: after
    // its first jump that option overshot every later target by a constant
    // ~450 px. The target is computed from the real scroll position each time.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.('a[href^="#"]');
      const id = link?.getAttribute("href")?.slice(1);
      const target = id ? document.getElementById(id) : null;
      if (!target) return;
      event.preventDefault();
      const headerHeight = document.querySelector("header")?.getBoundingClientRect().height ?? 72;
      lenis.scrollTo(target.getBoundingClientRect().top + window.scrollY - Math.ceil(headerHeight));
      history.pushState(null, "", `#${id}`);
      // Keyboard and screen-reader users continue from the section they jumped to.
      target.focus({ preventScroll: true });
    };
    document.addEventListener("click", onClick);

    return () => {
      document.removeEventListener("click", onClick);
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(LAG_THRESHOLD_MS, LAG_ADJUSTED_MS);
      lenis.destroy();
    };
  }, [reduced]);

  return <>{children}</>;
}
