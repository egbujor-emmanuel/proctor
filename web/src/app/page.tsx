import { CheckAgent } from "@/components/check/CheckAgent";
import { Hero } from "@/components/hero/Hero";
import { HowItWorks } from "@/components/how-it-works/HowItWorks";
import { OnChainProof } from "@/components/proof/OnChainProof";
import { LiveRegistry } from "@/components/registry/LiveRegistry";
import { Footer } from "@/components/site/Footer";
import { Header } from "@/components/site/Header";
import { TestIt } from "@/components/test-it/TestIt";
import { TrustModel } from "@/components/trust/TrustModel";

export default function Home() {
  return (
    <>
      <Header />
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero />
        <TestIt />
        <HowItWorks />
        <LiveRegistry />
        <OnChainProof />
        <CheckAgent />
        <TrustModel />
      </main>
      <Footer />
    </>
  );
}
