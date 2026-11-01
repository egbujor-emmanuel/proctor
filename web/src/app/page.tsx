import { CheckAgent } from "@/components/check/CheckAgent";
import { Hero } from "@/components/hero/Hero";
import { HowItWorks } from "@/components/how-it-works/HowItWorks";
import { LiveRegistry } from "@/components/registry/LiveRegistry";
import { Footer } from "@/components/site/Footer";
import { Header } from "@/components/site/Header";
import { TestIt } from "@/components/test-it/TestIt";
import { TrustModel } from "@/components/trust/TrustModel";

export default function Home() {
  return (
    <>
      <Header />
      <main id="main">
        <Hero />
        <TestIt />
        <HowItWorks />
        <LiveRegistry />
        <CheckAgent />
        <TrustModel />
      </main>
      <Footer />
    </>
  );
}
