"use client";

import useSWR from "swr";

import * as z from "zod/mini";

import built from "@/data/registry-snapshot.json";
import { CertificateSchema, ConfigSchema, ExamSchema, registry, type Certificate, type Exam, type RegistryConfig } from "@/lib/registry";

export interface RegistrySnapshot {
  config: RegistryConfig;
  exams: Exam[];
  certificates: Certificate[];
  /** Registry rows that failed validation and are not shown. */
  skipped: number;
  /** When this snapshot was read, in ms since the epoch. */
  readAt: number;
  /** "build": read when the site was built and shown until the live read lands. */
  source: "build" | "live";
}

const BuildSnapshot = z.object({
  readAt: z.number(),
  config: ConfigSchema,
  exams: z.array(ExamSchema),
  certificates: z.array(CertificateSchema),
});

/** The registry as read at build time, validated like a live read; undefined if it doesn't parse. */
const buildSnapshot: RegistrySnapshot | undefined = (() => {
  const parsed = BuildSnapshot.safeParse(built);
  return parsed.success ? { ...parsed.data, skipped: 0, source: "build" } : undefined;
})();

async function loadSnapshot(): Promise<RegistrySnapshot> {
  // Independent reads, fetched in parallel. They share one snapshot so the
  // counts and the lists come from the same moment.
  const [config, exams, certificates] = await Promise.all([registry.config(), registry.exams(), registry.certificates()]);
  return {
    config,
    exams: exams.rows,
    certificates: certificates.rows,
    skipped: exams.skipped + certificates.skipped,
    readAt: Date.now(),
    source: "live",
  };
}

/**
 * The live registry, refreshed every 30 s while the tab is visible. Until the
 * first live read lands, `data` is the build-time snapshot and `isSnapshot`
 * says so. When a refresh fails after a good read, `data` keeps the last
 * snapshot and `isStale` says so, so the page never shows old data as current.
 */
export function useRegistry() {
  const swr = useSWR<RegistrySnapshot, Error>("registry-snapshot", loadSnapshot, {
    fallbackData: buildSnapshot,
    // fallbackData must not stop the first live read.
    revalidateOnMount: true,
    refreshInterval: 30_000,
    revalidateOnFocus: false,
    shouldRetryOnError: true,
    errorRetryCount: 3,
  });
  const isSnapshot = swr.data?.source === "build";
  return { ...swr, isSnapshot, isStale: Boolean(swr.error && swr.data) };
}
