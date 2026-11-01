"use client";

import { useSyncExternalStore } from "react";

/** Live result of a CSS media query; `false` during static prerender. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");
export const useDarkScheme = () => useMediaQuery("(prefers-color-scheme: dark)");
