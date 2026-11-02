//! Paying for sittings, certifying, and certificate lookups.

use super::*;

#[test]
fn sitting_calls_outlayer_with_public_input_only() {
    let mut r = setup();
    let id = sit(&mut r);
    let sitting = r.get_sitting(id).unwrap();
    assert_eq!(sitting.candidate_model, MODEL);
    assert_eq!(sitting.compute_deposit, NearToken::from_millinear(85));
    assert_eq!(sitting.runner_hash, RUNNER_HASH);

    let receipts = get_created_receipts();
    let call = receipts
        .iter()
        .find(|rc| rc.receiver_id == acc("outlayer.testnet"))
        .expect("a receipt to OutLayer");
    let (method, args, deposit) = call
        .actions
        .iter()
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => Some((
                String::from_utf8(method_name.clone()).unwrap(),
                String::from_utf8(args.clone()).unwrap(),
                *attached_deposit,
            )),
            _ => None,
        })
        .expect("a function call action");
    assert_eq!(method, "request_execution");
    assert_eq!(deposit, NearToken::from_millinear(85));
    let args: Value = serde_json::from_str(&args).unwrap();
    assert_eq!(args["payer_account_id"], "alice.testnet");
    assert_eq!(args["secrets_ref"]["account_id"], "author.testnet");
    // The public input names the candidate and the sitting, and nothing else:
    // the exam never leaves OutLayer secrets.
    let input: Value = serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input, json!({ "request_id": format!("sitting-{id}"), "candidate": { "model": MODEL } }));

    let callback = receipts
        .iter()
        .find(|rc| rc.receiver_id == acc("registry.testnet"))
        .expect("a callback receipt");
    assert!(callback.actions.iter().any(|a| matches!(
        a,
        MockAction::FunctionCallWeight { method_name, prepaid_gas, .. }
            if method_name == b"on_sitting_result" && *prepaid_gas == CALLBACK_GAS
    )));
}

#[test]
#[should_panic(expected = "attach at least")]
fn sitting_requires_minimum_deposit() {
    let mut r = setup();
    set("alice.testnet", NearToken::from_millinear(1), 300);
    let _ = r.sit_exam(EXAM.into(), MODEL.into(), None);
}

#[test]
#[should_panic(expected = "attach at least 150 TGas")]
fn sitting_requires_enough_gas() {
    let mut r = setup();
    set("alice.testnet", NearToken::from_millinear(100), 100);
    let _ = r.sit_exam(EXAM.into(), MODEL.into(), None);
}

#[test]
#[should_panic(expected = "candidate_model may only use letters, digits")]
fn rejects_candidate_with_separator() {
    let mut r = setup();
    set("alice.testnet", NearToken::from_millinear(100), 300);
    let _ = r.sit_exam(EXAM.into(), "Victim|e".into(), None);
}

#[test]
#[should_panic(expected = "exam is not active")]
fn inactive_exam_cannot_be_sat() {
    let mut r = setup();
    set("author.testnet", NearToken::from_yoctonear(0), 300);
    r.set_exam_active(EXAM.into(), false);
    sit(&mut r);
}

#[test]
fn passing_sitting_issues_certificate() {
    let mut r = setup();
    let id = sit(&mut r);
    let out = output_with(id, 4, QUESTIONS, 0);
    let outcome = resolve(&mut r, id, Ok(Some(out.clone())));
    assert_eq!(outcome, SittingOutcome::Certified { cert_id: 0, score_bps: 8000 });

    let cert = r.get_certificate(0).unwrap();
    assert_eq!(cert.candidate_model, MODEL);
    assert_eq!(cert.exam_commitment, COMMIT);
    assert_eq!(cert.runner_hash, RUNNER_HASH);
    assert_eq!(cert.status, CertStatus::Active);
    let ids: Vec<String> = serde_json::from_value(out["response_ids"].clone()).unwrap();
    assert_eq!(cert.response_count, QUESTIONS);
    assert_eq!(cert.response_ids_hash, response_ids_hash(&ids));
    assert!(r.is_certified(MODEL.into(), EXAM.into()));
    assert!(r.get_sitting(id).is_none(), "pending sitting is cleared");
    assert_eq!(r.get_outcome(id), Some(outcome));
    assert_eq!(r.get_exam(EXAM.into()).unwrap().sittings, 1);
    // The completion ids are published in the event, not stored.
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("sitting_resolved") && l.contains(&ids[0])));
}

#[test]
fn pass_at_exactly_the_pass_mark_certifies() {
    let mut r = setup();
    let id = sit(&mut r);
    // 3/5 = 6000 bps, the registered pass mark.
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 3))));
    assert_eq!(outcome, SittingOutcome::Certified { cert_id: 0, score_bps: 6000 });
}

#[test]
fn failing_sitting_records_failure_without_certificate() {
    let mut r = setup();
    let id = sit(&mut r);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 2))));
    assert_eq!(outcome, SittingOutcome::Failed { score_bps: 4000 });
    assert!(r.get_certificate(0).is_none());
    assert!(!r.is_certified(MODEL.into(), EXAM.into()));
}

#[test]
fn pass_mark_is_decided_by_registry_not_runner() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 1);
    out["passed"] = json!(true); // a runner claiming a pass does not matter
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(outcome, SittingOutcome::Failed { score_bps: 2000 });
}

#[test]
#[should_panic(expected = "candidate already holds a certificate for this exam")]
fn certified_candidate_cannot_sit_again() {
    let mut r = certified();
    sit(&mut r);
}

#[test]
fn only_the_first_of_two_concurrent_passes_certifies() {
    let mut r = setup();
    let first = sit(&mut r);
    let second = sit(&mut r);
    resolve(&mut r, first, Ok(Some(output(first, 5))));
    let outcome = resolve(&mut r, second, Ok(Some(output(second, 5))));
    assert_eq!(rejected_reason(&outcome), "candidate is already certified");
    assert_eq!(r.get_config().certificates, 1);
    assert_eq!(r.latest_certificate(MODEL.into(), EXAM.into()).unwrap().cert_id, 0);
}



#[test]
fn certificate_lookup_never_returns_another_pairs_certificate() {
    let r = certified();
    assert!(r.latest_certificate(MODEL.into(), EXAM.into()).is_some());
    assert!(r.latest_certificate("Qwen/Qwen3.8".into(), format!("27B|{EXAM}")).is_none());
    assert!(!r.is_certified(MODEL.into(), "other-exam".into()));
}

#[test]
fn certificates_page_by_index() {
    let r = certified();
    assert_eq!(r.list_certificates(None, None).len(), 1);
    assert!(r.list_certificates(Some(1), Some(10)).is_empty());
    assert!(r.list_certificates(Some(u32::MAX), Some(10)).is_empty());
}
