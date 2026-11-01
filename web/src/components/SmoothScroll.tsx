"use client";

import { ReactLenis, type LenisRef } from "lenis/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

gsap.registerPlugin(ScrollTrigger);

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

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
 * share one clock. Turned off entirely for reduced-motion visitors.
 */
export function SmoothScroll({ children }: { children: ReactNode }) {
  const lenisRef = useRef<LenisRef>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const lenis = lenisRef.current?.lenis;
    if (!lenis) return;
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      lenis.off("scroll", ScrollTrigger.update);
      gsap.ticker.remove(tick);
    };
  }, [reduced]);

  if (reduced) return <>{children}</>;
  return (
    <ReactLenis root ref={lenisRef} options={{ autoRaf: false, lerp: 0.12 }}>
      {children}
    </ReactLenis>
  );
}
