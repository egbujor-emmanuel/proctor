# PROCTOR website

The public site: live proof that PROCTOR works, read straight from the
registry contract on NEAR testnet in the visitor's browser (keyless view
calls). It also runs the buyer check, using the same verdict rules as the
PROCTOR MCP server (`../mcp/src/verdict.ts`).

Static export (Next.js 16, App Router), GSAP + ScrollTrigger with Lenis on
GSAP's ticker, React Bits SplitText, Tailwind 4. Motion is skipped entirely
for visitors who ask for reduced motion.

```bash
npm ci
npm run dev        # http://localhost:3000
npm test           # unit tests for the data layer
npm run build      # static site in out/
```

QA evidence (Lighthouse, Playwright screenshots, content states) is in
`qa/evidence.json`.
