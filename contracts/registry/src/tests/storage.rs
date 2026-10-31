//! The sitting fee covers the storage a worst-case certificate uses.

use super::*;

#[test]
fn storage_fee_covers_a_worst_case_certificate() {
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    let mut r = Registry::new(acc("owner.testnet"), acc("outlayer.testnet"), runner_source(), RUNNER_HASH.to_string());
    let exam_id = "e".repeat(MAX_ID_LEN);
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam(exam_id.clone(), "T".into(), COMMIT.into(), 0, MAX_QUESTIONS, "p".into());

    // Each testing_env! resets the storage counter, so measure each step
    // inside its own environment and add the two.
    let model = "m".repeat(MAX_MODEL_LEN);
    let payer = format!("{}.testnet", "a".repeat(56)); // 64 bytes, the longest account id
    set(&payer, NearToken::from_millinear(100), 300);
    let before_sit = env::storage_usage();
    let id = r.get_config().next_sitting_id;
    let _ = r.sit_exam(exam_id.clone(), model.clone());
    flush(&mut r);
    let sit_bytes = env::storage_usage() - before_sit;

    let ids: Vec<String> = (0..MAX_QUESTIONS).map(|_| "i".repeat(MAX_RESPONSE_ID_LEN)).collect();
    let out = json!({
        "request_id": format!("sitting-{id}"), "exam_id": exam_id, "candidate": { "model": model },
        "exam_commitment": COMMIT, "total": MAX_QUESTIONS, "correct": MAX_QUESTIONS, "score_bps": 10_000,
        "complete": true, "failed_calls": 0, "response_ids": ids,
    });
    testing_env!(
        ctx("registry.testnet", NearToken::from_yoctonear(0), 300, 0).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(serde_json::to_vec(&out).unwrap())],
    );
    let before_callback = env::storage_usage();
    let outcome = r.on_sitting_result(id);
    flush(&mut r);
    assert!(matches!(outcome, SittingOutcome::Certified { .. }), "{outcome:?}");
    // The callback frees the sitting record, so its delta may be negative.
    let callback_bytes = env::storage_usage() as i64 - before_callback as i64;

    assert!(sit_bytes > 0 && callback_bytes != 0, "storage was not measured");
    let used = u64::try_from(sit_bytes as i64 + callback_bytes).unwrap();
    let cost = env::storage_byte_cost().saturating_mul(u128::from(used));
    assert!(cost <= SITTING_STORAGE_FEE, "a certified sitting uses {used} bytes ({cost}), more than the fee");
}
