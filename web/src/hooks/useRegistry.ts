"use client";

import useSWR from "swr";

import { registry, type Certificate, type Exam, type RegistryConfig } from "@/lib/registry";

export interface RegistrySnapshot {
  config: RegistryConfig;
  exams: Exam[];
  certificates: Certificate[];
}

async function loadSnapshot(): Promise<RegistrySnapshot> {
  // Independent reads, fetched in parallel.
  const [config, exams, certificates] = await Promise.all([registry.config(), registry.exams(), registry.certificates()]);
  return { config, exams, certificates };
}

/** The live registry, refreshed every 30 s while the page is open. */
export function useRegistry() {
  return useSWR<RegistrySnapshot, Error>("registry-snapshot", loadSnapshot, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    shouldRetryOnError: true,
    errorRetryCount: 3,
  });
}
