import { explorerAccount, REGISTRY, RUNNER_RELEASES } from "@/lib/config";

const LINKS = [
  { href: explorerAccount(REGISTRY), label: "Registry contract" },
  { href: RUNNER_RELEASES, label: "Exam runner builds" },
  { href: "https://outlayer.ai", label: "OutLayer" },
  { href: "https://cloud.near.ai", label: "NEAR AI Cloud" },
  { href: "https://market.near.ai", label: "Agent Market" },
];

export function Footer() {
  return (
    <footer className="border-t border-rule">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-5 py-10 text-sm text-ink-muted sm:px-8">
        <p>
          <span className="font-serif text-lg text-ink">PROCTOR</span> · built for the NEAR hackathon on NEAR testnet
        </p>
        <ul role="list" className="flex flex-wrap gap-x-6 gap-y-2">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a href={l.href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center hover:text-ink">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </footer>
  );
}
