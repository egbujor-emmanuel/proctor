"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useRef } from "react";

import SplitText from "@/components/SplitText";
import { Eyebrow } from "@/components/ui/Eyebrow";

gsap.registerPlugin(ScrollTrigger, useGSAP);

const STAGES = [
  {
    tag: "01 · Seal",
    title: "The exam is sealed in OutLayer",
    body: "An author stores the exam as an OutLayer secret and registers only its SHA-256 on NEAR. The secret opens for one exact runner build, and only on calls that come through the registry contract.",
    proof: "Commitment on chain, exam never published",
  },
  {
    tag: "02 · Sit",
    title: "The agent sits it inside a TEE",
    body: "Anyone pays for a sitting. OutLayer runs the PROCTOR runner in an Intel TDX enclave, which asks the candidate every question through NEAR AI and grades each answer by fixed rules.",
    proof: "Runner pinned by hash; NEAR AI signs every answer",
  },
  {
    tag: "03 · Certify",
    title: "The registry checks, then certifies",
    body: "The result comes back to the contract, which re-checks the exam, the candidate, the sitting and the arithmetic, and applies its own pass mark. An outage or a cut-off answer is never a fail.",
    proof: "Certificate written only from OutLayer's callback",
  },
  {
    tag: "04 · Re-test",
    title: "Surprise re-tests keep it live",
    body: "Anyone can re-test a certified agent, at most once an hour. One failed re-test suspends the certificate; a second in a row revokes it. A pass restores it.",
    proof: "Two strikes, so one noisy run can't kill a certificate",
  },
];

export function HowItWorks() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia(root);
      mm.add("(prefers-reduced-motion: no-preference) and (min-width: 1024px)", () => {
        // Each stage rises in once as it reaches the reading line, then stays
        // at full contrast; text is never left dimmed.
        gsap.utils.toArray<HTMLElement>("[data-stage]").forEach((item) => {
          gsap.from(item, {
            opacity: 0,
            y: 28,
            duration: 0.6,
            ease: "power3.out",
            scrollTrigger: { trigger: item, start: "top 75%", once: true },
          });
        });
        gsap.fromTo("[data-progress]", { scaleY: 0 }, {
          scaleY: 1,
          ease: "none",
          scrollTrigger: { trigger: "[data-stages]", start: "top 60%", end: "bottom 60%", scrub: true },
        });
      });
    },
    { scope: root },
  );

  return (
    <section id="how" ref={root} aria-labelledby="how-title" className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="lg:sticky lg:top-28 lg:h-fit">
          <Eyebrow text="How it works" />
          <h2 id="how-title" className="mt-3 font-serif text-4xl text-ink sm:text-5xl">
            {/* Below the fold, so the word reveal never delays the first paint. */}
            <SplitText text="Benchmarks leak. A sealed exam can’t." tag="span" splitType="words" textAlign="left" className="block" />
          </h2>
          <p className="mt-5 max-w-prose text-ink-muted">
            Public benchmarks end up in training data, so a high score can mean the model memorised the test. PROCTOR’s questions never leave a
            hardware enclave, and the certificate keeps being re-earned.
          </p>
        </div>
        <ol role="list" data-stages className="relative grid gap-10 pl-8">
          <span aria-hidden="true" className="absolute left-[11px] top-2 h-[calc(100%-1rem)] w-px bg-rule" />
          <span aria-hidden="true" data-progress className="absolute left-[11px] top-2 h-[calc(100%-1rem)] w-px origin-top bg-seal" />
          {STAGES.map((s) => (
            <li key={s.tag} data-stage className="relative">
              <span aria-hidden="true" className="absolute -left-8 top-1.5 size-[23px] rounded-full border-2 border-seal bg-paper" />
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-ink-muted">{s.tag}</p>
              <h3 className="mt-2 font-serif text-2xl text-ink sm:text-3xl">{s.title}</h3>
              <p className="mt-3 text-ink-muted">{s.body}</p>
              <p className="mt-3 inline-block rounded bg-seal-soft px-2.5 py-1 font-mono text-xs text-seal">{s.proof}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
