"use client";

import Radar from "@/components/bits/Radar";
import { BOARD_INK, type Token } from "./tokens";

type Props = { token: Token; isDark: boolean; isPaused: boolean };

/**
 * The re-test radar, tinted with the current certificate status. Loaded on the
 * client only, so the theme token can be read straight from the document; the
 * parent re-renders it when the scheme changes.
 */
export default function PhaseRadar({ token, isDark, isPaused }: Props) {
  const color = getComputedStyle(document.documentElement).getPropertyValue(token).trim() || BOARD_INK[token];
  return (
    <Radar
      color={color}
      lightMode={!isDark}
      // On paper the sweep needs more ink to read as clearly as it glows in the dark.
      brightness={isDark ? 1 : 1.6}
      glow={isDark ? 1 : 1.3}
      targets={5}
      ringCount={5}
      spokeCount={12}
      speed={0.7}
      trail={0.4}
      clutter={0.2}
      grain={0.02}
      scale={0.86}
      mouseInteraction={false}
      paused={isPaused}
      className="absolute inset-0"
    />
  );
}
