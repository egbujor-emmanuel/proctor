// The deliverable: one Markdown report, every line read from the chain.

import type { Verdict } from "../../mcp/src/verdict";

export interface ReportOptions {
  registry: string;
  site: string;
  now: Date;
}

const EXPLORER = "https://testnet.near.rocks";
const STATE: Record<string, string> = { active: "live", stale: "stale", suspended: "suspended", revoked: "revoked", none: "no certificate" };

function section(v: Verdict): string {
  const decision = v.decision === "hire" ? "**Hire**: holds a live PROCTOR certificate" : "**Do not hire**";
  const lines = [`## \`${v.candidate}\``, "", decision, ""];
  for (const reason of v.reasons) lines.push(`- ${reason}`);
  if (v.exams.length > 0) {
    lines.push("", "| Exam | Standing | Score | Surprise re-tests passed | Last verified | Certificate |", "|---|---|---|---|---|---|");
    for (const e of v.exams) {
      const c = e.certificate;
      lines.push(
        c
          ? `| \`${e.exam_id}\` | ${STATE[e.state] ?? e.state} | ${c.score} | ${c.retests_passed} | ${c.last_verified} | certificate ${c.cert_id} |`
          : `| \`${e.exam_id}\` | ${STATE[e.state] ?? e.state} | | | | |`,
      );
    }
  }
  if (v.market) lines.push("", `Agent Market listing \`${v.market.handle}\`: ${v.market.delivered_jobs} jobs delivered (context only; a certificate decides).`);
  return lines.join("\n");
}

/** The report for every candidate the brief named, or how to name one if it named none. */
export function renderReport(verdicts: Verdict[], o: ReportOptions): string {
  const head = [
    "# PROCTOR check",
    "",
    `Read from the PROCTOR registry [\`${o.registry}\`](${EXPLORER}/account/${o.registry}) on NEAR testnet at ${o.now.toISOString()}. A certificate is live only if the candidate passed a secret exam sealed in an OutLayer TEE, and every surprise re-test since.`,
    "",
  ];
  const body =
    verdicts.length > 0
      ? verdicts.map(section).join("\n\n")
      : [
          "The brief named no candidate to check. Name any of these and request changes:",
          "",
          "- a NEAR AI model id, such as `anthropic/claude-sonnet-5-5`",
          "- an agent certified through its own endpoint, as `agent:<owner-account>/<name>`",
          "- an Agent Market listing, as `@handle` or its `market.near.ai/a/<handle>` link",
        ].join("\n");
  const tail = [
    "",
    "## Check this yourself",
    "",
    `- The live registry and each certificate: ${o.site}/#registry`,
    `- The deployed code, the pinned runner and the timelock, checked on load: ${o.site}/#verify`,
    "- Every transaction PROCTOR cites, read back from the chain: `node scripts/evidence.mjs` in https://github.com/egbujor-emmanuel/proctor",
    "",
    "This report is the same verdict PROCTOR's MCP server gives Claude Code.",
  ];
  return [...head, body, ...tail].join("\n");
}
