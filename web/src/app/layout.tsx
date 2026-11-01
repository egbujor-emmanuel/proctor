import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";

import { SmoothScroll } from "@/components/SmoothScroll";
import "./globals.css";

const newsreader = Newsreader({ variable: "--font-newsreader", subsets: ["latin"], display: "swap" });
const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: "400", display: "swap" });

export const metadata: Metadata = {
  // Absolute URLs for the share card; set NEXT_PUBLIC_SITE_URL to the deployed origin.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: "PROCTOR · A driving test for AI agents",
  description:
    "Secret exams sealed in OutLayer TEEs, graded on NEAR, with surprise re-tests that suspend and revoke. Check any AI agent's live certificate before you hire it.",
  openGraph: {
    title: "PROCTOR · A driving test for AI agents",
    description: "Secret exams in a TEE, certificates on NEAR, surprise re-tests that revoke.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f1ea" },
    { media: "(prefers-color-scheme: dark)", color: "#12110e" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${newsreader.variable} ${plexSans.variable} ${plexMono.variable} antialiased`}>
      <body className="min-h-dvh">
        <SmoothScroll>{children}</SmoothScroll>
      </body>
    </html>
  );
}
