import { RUNNER_RELEASE } from "@/lib/config";

const LINKS = [
  { href: "#test-it", label: "Test it" },
  { href: "#how", label: "How it works" },
  { href: "#registry", label: "Registry" },
  { href: "#check", label: "Check an agent" },
  { href: "#trust", label: "Trust model" },
];

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper/85 backdrop-blur supports-[backdrop-filter]:bg-paper/70">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded focus:bg-ink focus:px-3 focus:py-2 focus:text-paper">
        Skip to content
      </a>
      <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3 sm:px-8">
        <a href="#top" className="font-serif text-xl tracking-tight text-ink">
          PROCTOR
        </a>
        <ul role="list" className="order-last flex w-full items-center gap-x-5 overflow-x-auto pb-1 text-sm text-ink-muted [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:order-none md:w-auto md:gap-6 md:overflow-visible md:pb-0">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="inline-flex min-h-8 items-center whitespace-nowrap hover:text-ink">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <a
          href={RUNNER_RELEASE}
          target="_blank"
          rel="noopener noreferrer"
          className="min-h-9 rounded border border-rule px-3 py-1.5 text-sm text-ink hover:border-seal hover:text-seal"
        >
          Runner build
        </a>
      </nav>
    </header>
  );
}
