"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  text: string;
  /** What is copied, for screen readers: "Copy: <label>". */
  label: string;
  className?: string;
};

const RESET_MS = 2500;

/**
 * Copies `text`, and says what happened: "Copied" on success, a manual-copy
 * hint when the clipboard is blocked. The status is a sibling of the button,
 * always mounted, so screen readers announce it reliably.
 */
export function CopyButton({ text, label, className = "" }: Props) {
  const [message, setMessage] = useState("");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function handleCopy() {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`Copied: ${label}`);
    } catch {
      setMessage("Copy failed. Select the text and copy it manually.");
    }
    timer.current = window.setTimeout(() => setMessage(""), RESET_MS);
  }

  const copied = message.startsWith("Copied");
  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy: ${label}`}
        className={`min-h-9 rounded border border-ink-muted/50 bg-paper-raised px-3 text-xs font-medium text-ink transition-colors hover:border-seal hover:text-seal active:translate-y-px ${className}`}
      >
        {copied ? "Copied" : message ? "Failed" : "Copy"}
      </button>
      <span role="status" className="sr-only">
        {message}
      </span>
    </>
  );
}
