"use client";

import { useState } from "react";

type Props = {
  command: string;
  label: string;
};

/** A shell command with a copy button. The command stays selectable text. */
export function CopyCommand({ command, label }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="group relative rounded-md border border-rule bg-paper-sunk">
      <pre className="hash whitespace-pre-wrap px-4 py-3 pr-20 text-[13px] leading-relaxed text-ink">
        <code>{command}</code>
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy: ${label}`}
        className="absolute right-2 top-2 min-h-9 rounded border border-rule bg-paper-raised px-3 text-xs font-medium text-ink transition-colors hover:border-seal hover:text-seal active:translate-y-px"
      >
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
