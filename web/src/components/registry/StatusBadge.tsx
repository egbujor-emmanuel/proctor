import type { CertState } from "../../../../mcp/src/verdict";

const STYLE: Record<CertState, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-active-soft text-active border-active" },
  stale: { label: "Stale", className: "bg-suspended-soft text-suspended border-suspended" },
  suspended: { label: "Suspended", className: "bg-suspended-soft text-suspended border-suspended" },
  revoked: { label: "Revoked", className: "bg-revoked-soft text-revoked border-revoked" },
  none: { label: "No certificate", className: "bg-paper-sunk text-ink-muted border-rule" },
};

/** A certificate's status, shown as text as well as colour. */
export function StatusBadge({ state }: { state: CertState }) {
  const { label, className } = STYLE[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${className}`}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
