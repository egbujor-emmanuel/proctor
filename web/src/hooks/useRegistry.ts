"use client";

import useSWR from "swr";

import { registry, type Certificate, type Exam, type RegistryConfig } from "@/lib/registry";

export interface RegistrySnapshot {
  config: RegistryConfig;
  exams: Exam[];
  certificates: Certificate[];
  /** Registry rows that failed validation and are not shown. */
  skipped: number;
  /** When this snapshot was read, in ms since the epoch. */
  readAt: number;
}

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
  };
}

/**
 * The live registry, refreshed every 30 s while the tab is visible. When a
 * refresh fails after a good read, `data` keeps the last snapshot and
 * `isStale` says so, so the page never shows old data as current.
 */
export function useRegistry() {
  const swr = useSWR<RegistrySnapshot, Error>("registry-snapshot", loadSnapshot, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
    shouldRetryOnError: true,
    errorRetryCount: 3,
  });
  return { ...swr, isStale: Boolean(swr.error && swr.data) };
}
