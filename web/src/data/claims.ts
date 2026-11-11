// The claims the Verify section shows, each with the test that checks it and
// the transaction that shows it. The full list is CLAIMS.md; a unit test
// (claims.test.ts) checks every test name and transaction here is real.

export interface Claim {
  claim: string;
  /** Repository path of the test file, and the test's name in it. */
  test: { file: string; name: string };
  /** A NEAR testnet transaction that shows the claim, if there is one. */
  tx?: string;
}

export const CLAIMS: Claim[] = [
  {
    claim: "A certificate is written only from OutLayer's callback, never from a caller's word",
    test: { file: "contracts/registry/src/tests/sittings.rs", name: "passing_sitting_issues_certificate" },
    tx: "4ewFE77FvYXLTzA5dfBWWanntAQeyfFEXAvZFo6LaoR1",
  },
  {
    claim: "A result replayed from another sitting is refused",
    test: { file: "contracts/registry/src/tests/verification.rs", name: "rejects_output_replayed_from_another_sitting" },
  },
  {
    claim: "A sitting cannot be recognised: 10 of 28 questions, reworded and reframed every time",
    test: { file: "proctor-core/src/sitting.rs", name: "plan_asks_the_sample_size_and_varies_between_sittings" },
    tx: "7fHjeDpb6ViT2gQkP4PoKLvwPfDyGb4NWo8Jyk16T68z",
  },
  {
    claim: "Two failed surprise re-tests in a row revoke a certificate",
    test: { file: "contracts/registry/src/tests/retests.rs", name: "second_failed_retest_in_a_row_revokes" },
    tx: "3SGvHzEY7c2Bo91eehtnapZbXE2eVk5mv4y1DDPWBLm4",
  },
  {
    claim: "Outages never fail a NEAR AI model",
    test: { file: "contracts/registry/src/tests/hardening.rs", name: "a_model_candidate_is_never_struck_for_outages" },
    tx: "5bspuwmbcfgoUN4rUyGTZN6o746szJEF3uQTEDBWajUG",
  },
  {
    claim: "A new runner build cannot grade until a public 24-hour notice has passed",
    test: { file: "contracts/registry/src/tests/admin.rs", name: "runner_change_cannot_be_applied_early" },
    tx: "HQx9am4QrjSEbptjvsJpfLkB87iB8U5Z491J25jVqgte",
  },
  {
    claim: "The escrow refunds the buyer when the agent's certificate is no longer live",
    test: { file: "contracts/escrow/src/tests.rs", name: "a_certificate_that_is_no_longer_live_refunds_the_buyer" },
    tx: "ypHUGxQgLae18JAXigcJo2hGYwY2grKBAZHZJSH8NJK",
  },
  {
    claim: "No live certificate goes 5 days without a re-test, so none lapses into \"stale\"",
    test: { file: "sentinel/test/sentinel.test.ts", name: "re-tests the live certificate verified longest ago once it is overdue, whatever the roll" },
  },
  {
    claim: "Anyone can order a re-test here; a daily cap keeps the sentinel's account from being drained",
    test: { file: "sentinel/test/ondemand.test.ts", name: "stops at the daily cap so nobody can drain the sentinel's account" },
    tx: "Eokg4Rja1MzFuHDKo998LNrtJNuqSRk21H9qF22PkK4U",
  },
  {
    claim: "The verifier fails a replayed hardware report and GPU tokens NVIDIA did not sign",
    test: { file: "mcp/test/attest.test.ts", name: "fails GPU tokens not signed by NVIDIA" },
  },
];
