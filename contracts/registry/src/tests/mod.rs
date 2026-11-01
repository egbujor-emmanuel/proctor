use super::*;
use crate::admin::RUNNER_CHANGE_DELAY_NS;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const COMMIT: &str = "7dd0aefd001086f5bafaae03736ff06facf351efe1e9187b9e93bb4817c4d1d4";
const RUNNER_HASH: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_HASH: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const MODEL: &str = "Qwen/Qwen3.8-27B";
const EXAM: &str = "near-basics-v1";
const QUESTIONS: u32 = 5;
const HOUR_NS: u64 = 60 * NS_PER_MINUTE;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: NearToken, gas_tgas: u64, at_ns: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("registry.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(gas_tgas))
        .block_timestamp(at_ns)
        .account_balance(NearToken::from_near(50));
    b
}

fn set(predecessor: &str, deposit: NearToken, gas_tgas: u64) {
    testing_env!(ctx(predecessor, deposit, gas_tgas, 0).build());
}

fn set_at(predecessor: &str, deposit: NearToken, at_ns: u64) {
    testing_env!(ctx(predecessor, deposit, 300, at_ns).build());
}

/// A runner build pinned by hash, as the registry requires.
fn source_for(hash: &str) -> Value {
    json!({ "WasmUrl": { "url": format!("https://example.org/{hash}.wasm"), "hash": hash, "build_target": "wasm32-wasip2" } })
}

fn runner_source() -> Value {
    source_for(RUNNER_HASH)
}

fn setup() -> Registry {
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    let mut r = Registry::new(acc("owner.testnet"), acc("outlayer.testnet"), runner_source(), RUNNER_HASH.to_string());
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam(EXAM.into(), "NEAR basics".into(), COMMIT.into(), 6000, QUESTIONS, "exam-near-basics".into());
    r
}

fn sit(r: &mut Registry) -> u64 {
    set("alice.testnet", NearToken::from_millinear(100), 300);
    let id = r.get_config().next_sitting_id;
    let _ = r.sit_exam(EXAM.into(), MODEL.into());
    id
}

/// A well-formed runner output: one completion id per answered question.
fn output_with(sitting_id: u64, correct: u32, total: u32, failed_calls: u32) -> Value {
    let ids: Vec<String> = (0..total - failed_calls).map(|i| format!("chatcmpl-{sitting_id}-{i}")).collect();
    json!({
        "proctor_version": "0.1.0",
        "request_id": format!("sitting-{sitting_id}"),
        "exam_id": EXAM,
        "candidate": { "model": MODEL, "endpoint": "https://cloud-api.near.ai/v1/chat/completions" },
        "exam_commitment": COMMIT,
        "total": total,
        "correct": correct,
        "score_bps": (correct as u64 * 10_000 / total as u64) as u32,
        "passed": true,
        "complete": failed_calls == 0,
        "failed_calls": failed_calls,
        "response_ids": ids,
    })
}

fn output(sitting_id: u64, correct: u32) -> Value {
    output_with(sitting_id, correct, QUESTIONS, 0)
}

/// Delivers raw promise result bytes to the callback, as the chain would.
fn resolve_raw(r: &mut Registry, sitting_id: u64, result: PromiseResult) -> SittingOutcome {
    testing_env!(
        ctx("registry.testnet", NearToken::from_yoctonear(0), 300, 0).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
    r.on_sitting_result(sitting_id)
}

fn resolve(r: &mut Registry, sitting_id: u64, result: Result<Option<Value>, PromiseError>) -> SittingOutcome {
    let raw = match result {
        Ok(value) => PromiseResult::Successful(serde_json::to_vec(&value).unwrap()),
        Err(_) => PromiseResult::Failed,
    };
    resolve_raw(r, sitting_id, raw)
}

fn rejected_reason(outcome: &SittingOutcome) -> &str {
    match outcome {
        SittingOutcome::Rejected { reason } => reason,
        other => panic!("expected Rejected, got {other:?}"),
    }
}

fn transfers_to(account: &str) -> Vec<NearToken> {
    get_created_receipts()
        .into_iter()
        .filter(|rc| rc.receiver_id == acc(account))
        .flat_map(|rc| rc.actions)
        .filter_map(|a| match a {
            MockAction::Transfer { deposit, .. } => Some(deposit),
            _ => None,
        })
        .collect()
}

fn certified() -> Registry {
    let mut r = setup();
    let id = sit(&mut r);
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    r
}

fn start_retest_at(r: &mut Registry, cert_id: u64, at_ns: u64) -> u64 {
    set_at("anyone.testnet", NearToken::from_millinear(100), at_ns);
    let id = r.get_config().next_sitting_id;
    let _ = r.retest(cert_id);
    id
}

fn start_retest(r: &mut Registry, cert_id: u64) -> u64 {
    start_retest_at(r, cert_id, HOUR_NS)
}

/// `near_sdk::store` collections cache writes until flushed (the wasm entry
/// point does this after each call), so flush before reading storage usage.
fn flush(r: &mut Registry) {
    r.exams.flush();
    r.certificates.flush();
    r.sittings.flush();
    r.outcomes.flush();
    r.latest.flush();
}

mod exams;
mod sittings;
mod verification;
mod retests;
mod admin;
mod storage;
