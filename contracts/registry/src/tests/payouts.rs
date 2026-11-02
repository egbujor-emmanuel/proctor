//! Exam-author fees: held per sitting, paid on a verdict, refunded otherwise,
//! withdrawn by the author; and the in-place upgrade that added them.

use super::*;
use crate::migrate::RegistryBeforePayouts;
use crate::payouts::MAX_EXAM_FEE;

const FEE: NearToken = NearToken::from_millinear(20);

fn with_fee(fee: NearToken) -> Registry {
    let mut r = setup();
    set("author.testnet", NearToken::from_millinear(10), 300);
    r.set_exam_fee(EXAM.into(), fee);
    r
}

/// A sitting paying exactly the minimum deposit plus `fee`.
fn sit_paying(r: &mut Registry, fee: NearToken) -> u64 {
    set("alice.testnet", NearToken::from_millinear(40).saturating_add(fee), 300);
    let id = r.get_config().next_sitting_id;
    let _ = r.sit_exam(EXAM.into(), MODEL.into());
    id
}

/// The deposit forwarded to OutLayer by the latest sitting.
fn forwarded_to_outlayer() -> NearToken {
    get_created_receipts()
        .into_iter()
        .filter(|rc| rc.receiver_id == acc("outlayer.testnet"))
        .flat_map(|rc| rc.actions)
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { attached_deposit, .. } => Some(attached_deposit),
            _ => None,
        })
        .expect("a request to OutLayer")
}

#[test]
fn exams_are_free_unless_the_author_sets_a_fee() {
    let mut r = setup();
    assert_eq!(r.get_exam_fee(EXAM.into()), NearToken::from_yoctonear(0));
    let id = sit(&mut r);
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    assert_eq!(r.get_author_balance(acc("author.testnet")), NearToken::from_yoctonear(0));
}

#[test]
fn the_fee_is_held_on_top_of_the_deposit_and_not_sent_to_outlayer() {
    let mut r = with_fee(FEE);
    assert_eq!(r.get_exam_fee(EXAM.into()), FEE);
    sit_paying(&mut r, FEE);
    // 40 mNEAR + fee attached; storage keeps 15 mNEAR, the fee stays here.
    assert_eq!(forwarded_to_outlayer(), NearToken::from_millinear(25));
}

#[test]
#[should_panic(expected = "attach at least 0.060 NEAR")]
fn a_sitting_must_attach_the_fee() {
    let mut r = with_fee(FEE);
    sit_paying(&mut r, NearToken::from_yoctonear(0));
}

#[test]
fn a_verdict_pays_the_author_whether_the_candidate_passes_or_fails() {
    let mut r = with_fee(FEE);
    let failed = sit_paying(&mut r, FEE);
    assert!(matches!(resolve(&mut r, failed, Ok(Some(output(failed, 1)))), SittingOutcome::Failed { .. }));
    let passed = sit_paying(&mut r, FEE);
    assert!(matches!(resolve(&mut r, passed, Ok(Some(output(passed, 5)))), SittingOutcome::Certified { .. }));
    assert_eq!(r.get_author_balance(acc("author.testnet")), FEE.saturating_mul(2));
    assert!(get_logs().iter().any(|l| l.contains("earnings_credited")));
}

#[test]
fn re_tests_pay_the_author_too() {
    let mut r = with_fee(FEE);
    let id = sit_paying(&mut r, FEE);
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    set_at("anyone.testnet", NearToken::from_millinear(40).saturating_add(FEE), HOUR_NS);
    let retest = r.get_config().next_sitting_id;
    let _ = r.retest(0);
    assert_eq!(resolve(&mut r, retest, Ok(Some(output(retest, 1)))), SittingOutcome::Suspended { cert_id: 0, score_bps: 2000 });
    assert_eq!(r.get_author_balance(acc("author.testnet")), FEE.saturating_mul(2));
}

#[test]
fn an_outage_or_a_bad_run_refunds_the_fee_to_whoever_paid() {
    let mut r = with_fee(FEE);
    let incomplete = sit_paying(&mut r, FEE);
    assert!(matches!(resolve(&mut r, incomplete, Ok(Some(output_with(incomplete, 3, QUESTIONS, 1)))), SittingOutcome::Incomplete { .. }));
    assert!(transfers_to("alice.testnet").contains(&FEE));

    let failed_run = sit_paying(&mut r, FEE);
    assert!(matches!(resolve(&mut r, failed_run, Ok(None)), SittingOutcome::RunnerFailed { .. }));
    assert!(transfers_to("alice.testnet").contains(&FEE));

    let refused = sit_paying(&mut r, FEE);
    resolve(&mut r, refused, Err(PromiseError::Failed));
    // OutLayer refused: the compute deposit and the fee both come back.
    let refunds = transfers_to("alice.testnet");
    assert!(refunds.contains(&FEE) && refunds.contains(&NearToken::from_millinear(25)), "{refunds:?}");

    let tampered = sit_paying(&mut r, FEE);
    let mut out = output(tampered, 5);
    out["exam_commitment"] = json!("0".repeat(64));
    assert!(matches!(resolve(&mut r, tampered, Ok(Some(out))), SittingOutcome::Rejected { .. }));
    assert!(transfers_to("alice.testnet").contains(&FEE));

    assert_eq!(r.get_author_balance(acc("author.testnet")), NearToken::from_yoctonear(0));
}

#[test]
fn an_expired_sitting_refunds_the_fee() {
    let mut r = with_fee(FEE);
    let id = sit_paying(&mut r, FEE);
    set_at("anyone.testnet", NearToken::from_yoctonear(0), SITTING_TIMEOUT_NS);
    assert_eq!(r.expire_sitting(id), SittingOutcome::Expired);
    assert!(transfers_to("alice.testnet").contains(&FEE));
}

#[test]
fn a_fee_change_does_not_touch_sittings_already_paid() {
    let mut r = with_fee(FEE);
    let id = sit_paying(&mut r, FEE);
    set("author.testnet", NearToken::from_millinear(10), 300);
    r.set_exam_fee(EXAM.into(), NearToken::from_yoctonear(0));
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    assert_eq!(r.get_author_balance(acc("author.testnet")), FEE);
}

#[test]
fn the_author_withdraws_everything_once() {
    let mut r = with_fee(FEE);
    let id = sit_paying(&mut r, FEE);
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    set("author.testnet", NearToken::from_yoctonear(1), 300);
    let _ = r.withdraw_earnings();
    assert_eq!(transfers_to("author.testnet"), vec![FEE.saturating_add(NearToken::from_yoctonear(1))]);
    assert_eq!(r.get_author_balance(acc("author.testnet")), NearToken::from_yoctonear(0));
}

#[test]
#[should_panic(expected = "no earnings to withdraw")]
fn nothing_to_withdraw_twice() {
    let mut r = with_fee(FEE);
    let id = sit_paying(&mut r, FEE);
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    set("author.testnet", NearToken::from_yoctonear(1), 300);
    let _ = r.withdraw_earnings();
    let _ = r.withdraw_earnings();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdrawing_needs_a_full_access_key() {
    let mut r = setup();
    set("author.testnet", NearToken::from_yoctonear(0), 300);
    let _ = r.withdraw_earnings();
}

#[test]
#[should_panic(expected = "only the exam author can do this")]
fn only_the_author_sets_the_fee() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_millinear(10), 300);
    r.set_exam_fee(EXAM.into(), FEE);
}

#[test]
#[should_panic(expected = "fee must be at most")]
fn the_fee_is_capped() {
    let mut r = setup();
    set("author.testnet", NearToken::from_millinear(10), 300);
    r.set_exam_fee(EXAM.into(), MAX_EXAM_FEE.saturating_add(NearToken::from_yoctonear(1)));
}

#[test]
#[should_panic(expected = "to cover storage")]
fn setting_a_fee_pays_for_its_storage() {
    let mut r = setup();
    set("author.testnet", NearToken::from_yoctonear(0), 300);
    r.set_exam_fee(EXAM.into(), FEE);
}

#[test]
fn the_upgrade_keeps_every_record_and_adds_the_ledgers() {
    // A certified registry as the previous version left it in storage.
    let mut before = certified();
    flush(&mut before);
    let Registry { owner, outlayer_account, runner_source_json, runner_hash, max_instructions, max_memory_mb, max_execution_seconds, exams, certificates, sittings, outcomes, latest, next_sitting_id, pending_runner, pending_owner, .. } = before;
    env::state_write(&RegistryBeforePayouts {
        owner, outlayer_account, runner_source_json, runner_hash, max_instructions, max_memory_mb, max_execution_seconds,
        exams, certificates, sittings, outcomes, latest, next_sitting_id, pending_runner, pending_owner,
    });

    set("registry.testnet", NearToken::from_yoctonear(0), 300);
    let mut r = Registry::migrate();
    assert_eq!(r.get_config().owner, acc("owner.testnet"));
    assert!(r.get_exam(EXAM.into()).is_some());
    assert_eq!(r.get_certificate(0).unwrap().status, CertStatus::Active);
    assert!(r.is_certified(MODEL.into(), EXAM.into()));
    assert_eq!(r.get_config().next_sitting_id, 1);

    // And the new features work on the upgraded state.
    set("author.testnet", NearToken::from_millinear(10), 300);
    r.set_exam_fee(EXAM.into(), FEE);
    assert_eq!(r.get_exam_fee(EXAM.into()), FEE);
}

#[test]
#[should_panic(expected = "Method migrate is private")]
fn only_the_contract_can_run_the_upgrade() {
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    let _ = Registry::migrate();
}
