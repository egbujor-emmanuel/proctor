//! The registry on a real NEAR node (near-workspaces sandbox), talking to a
//! mock OutLayer contract through real cross-contract promises. These cover
//! what unit tests cannot: the generated wasm entry points (including the
//! `#[private]` check), the promise chain and its gas, raw result bytes, and
//! refunds as actual balance changes.

use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const REGISTRY_WASM: &str = "../registry/target/near/proctor_registry.wasm";
const MOCK_WASM: &str = "../mock-outlayer/target/near/mock_outlayer.wasm";
const EXAM: &str = "near-basics-v1";
const COMMIT: &str = "7dd0aefd001086f5bafaae03736ff06facf351efe1e9187b9e93bb4817c4d1d4";
const RUNNER_HASH: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const MODEL: &str = "Qwen/Qwen3.8-27B";
const QUESTIONS: u32 = 5;
const SITTING_DEPOSIT: NearToken = NearToken::from_millinear(100);
/// The registry's re-test cooldown, plus a margin.
const COOLDOWN_NS: u64 = 61 * 60 * 1_000_000_000;
/// Blocks per fast-forward step while waiting out the cooldown, and a cap.
const FORWARD_STEP: u64 = 5_000;
const MAX_FORWARD_BLOCKS: u64 = 400_000;

struct Env {
    worker: Worker<Sandbox>,
    registry: Contract,
    mock: Contract,
    alice: Account,
}

async fn deploy() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let mock = worker.dev_deploy(&std::fs::read(MOCK_WASM)?).await?;
    mock.call("new")
        .args_json(json!({ "exam_id": EXAM, "exam_commitment": COMMIT, "total": QUESTIONS }))
        .transact()
        .await?
        .into_result()?;

    let registry = worker.dev_deploy(&std::fs::read(REGISTRY_WASM)?).await?;
    registry
        .call("new")
        .args_json(json!({
            "owner": registry.id(),
            "outlayer_account": mock.id(),
            "runner_source": { "Project": { "project_id": "attrito.testnet/proctor-exam-runner", "version_key": null } },
            "runner_hash": RUNNER_HASH,
        }))
        .transact()
        .await?
        .into_result()?;

    let author = worker.dev_create_account().await?;
    author
        .call(registry.id(), "register_exam")
        .args_json(json!({
            "exam_id": EXAM, "title": "NEAR basics", "commitment": COMMIT,
            "pass_mark_bps": 6000, "question_count": QUESTIONS, "secrets_profile": "exam-near-basics",
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;

    let alice = worker.dev_create_account().await?;
    Ok(Env { worker, registry, mock, alice })
}

async fn set_mode(env: &Env, mode: &str) -> anyhow::Result<()> {
    env.mock.call("set_mode").args_json(json!({ "mode": mode })).transact().await?.into_result()?;
    Ok(())
}

/// Pays for a sitting and returns the outcome the callback recorded.
async fn sit(env: &Env) -> anyhow::Result<Value> {
    let result = env
        .alice
        .call(env.registry.id(), "sit_exam")
        .args_json(json!({ "exam_id": EXAM, "candidate_model": MODEL }))
        .deposit(SITTING_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    Ok(result.into_result()?.json()?)
}

async fn retest(env: &Env, cert_id: u64) -> anyhow::Result<Value> {
    let result = env
        .alice
        .call(env.registry.id(), "retest")
        .args_json(json!({ "cert_id": cert_id }))
        .deposit(SITTING_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    Ok(result.into_result()?.json()?)
}

/// Fast-forwards until the chain clock has moved past the re-test cooldown.
/// How much time a fast-forwarded block adds depends on the sandbox, so this
/// measures the clock rather than assuming a block time.
async fn wait_out_cooldown(env: &Env) -> anyhow::Result<()> {
    let start = env.worker.view_block().await?.timestamp();
    let mut forwarded = 0;
    loop {
        let now = env.worker.view_block().await?.timestamp();
        if now.saturating_sub(start) >= COOLDOWN_NS {
            eprintln!("cooldown passed after {forwarded} blocks ({} ns/block)", (now - start) / forwarded.max(1));
            return Ok(());
        }
        anyhow::ensure!(forwarded < MAX_FORWARD_BLOCKS, "chain clock moved only {} s in {forwarded} blocks", (now - start) / 1_000_000_000);
        env.worker.fast_forward(FORWARD_STEP).await?;
        forwarded += FORWARD_STEP;
    }
}

async fn view(env: &Env, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(env.registry.view(method).args_json(args).await?.json()?)
}

async fn is_certified(env: &Env) -> anyhow::Result<bool> {
    Ok(view(env, "is_certified", json!({ "candidate_model": MODEL, "exam_id": EXAM })).await? == json!(true))
}

#[tokio::test]
async fn passing_sitting_is_certified_end_to_end() -> anyhow::Result<()> {
    let env = deploy().await?;
    let outcome = sit(&env).await?;
    assert_eq!(outcome, json!({ "Certified": { "cert_id": 0, "score_bps": 10000 } }));
    assert!(is_certified(&env).await?);

    let cert = view(&env, "get_certificate", json!({ "cert_id": 0 })).await?;
    assert_eq!(cert["candidate_model"], MODEL);
    assert_eq!(cert["runner_hash"], RUNNER_HASH);
    assert_eq!(cert["response_count"], QUESTIONS);
    assert_eq!(view(&env, "get_sitting", json!({ "sitting_id": 0 })).await?, Value::Null);

    // What OutLayer was sent: the deposit less the 15 mNEAR storage fee, the
    // sitter as payer, and a public input that names only the sitting and
    // the candidate. The exam itself never leaves OutLayer's secrets.
    let request: Value = env.mock.view("last_request").await?.json()?;
    assert_eq!(request["attached_deposit"], NearToken::from_millinear(85).as_yoctonear().to_string());
    assert_eq!(request["payer_account_id"], env.alice.id().to_string());
    let input: Value = serde_json::from_str(request["input_data"].as_str().unwrap())?;
    assert_eq!(input, json!({ "request_id": "sitting-0", "candidate": { "model": MODEL } }));
    Ok(())
}

#[tokio::test]
async fn failing_sitting_is_recorded_without_a_certificate() -> anyhow::Result<()> {
    let env = deploy().await?;
    set_mode(&env, "Fail").await?;
    assert_eq!(sit(&env).await?, json!({ "Failed": { "score_bps": 0 } }));
    assert!(!is_certified(&env).await?);
    Ok(())
}

#[tokio::test]
async fn non_json_result_is_recorded_not_stuck() -> anyhow::Result<()> {
    let env = deploy().await?;
    set_mode(&env, "Garbage").await?;
    let outcome = sit(&env).await?;
    let reason = outcome["Rejected"]["reason"].as_str().unwrap_or_default();
    assert!(reason.starts_with("malformed runner output"), "{outcome}");
    assert_eq!(view(&env, "get_sitting", json!({ "sitting_id": 0 })).await?, Value::Null);
    assert_eq!(view(&env, "get_outcome", json!({ "sitting_id": 0 })).await?, outcome);
    Ok(())
}

#[tokio::test]
async fn failed_run_is_recorded() -> anyhow::Result<()> {
    let env = deploy().await?;
    set_mode(&env, "Null").await?;
    let outcome = sit(&env).await?;
    assert!(outcome.get("RunnerFailed").is_some(), "{outcome}");
    assert!(!is_certified(&env).await?);
    Ok(())
}

#[tokio::test]
async fn refused_request_refunds_the_sitter() -> anyhow::Result<()> {
    let env = deploy().await?;
    set_mode(&env, "Refuse").await?;
    let before = env.alice.view_account().await?.balance;
    let outcome = sit(&env).await?;
    assert!(outcome.get("RunnerFailed").is_some(), "{outcome}");
    // Let the refund receipt land, then check that only the storage fee and
    // gas were spent, not the 100 mNEAR deposit.
    env.worker.fast_forward(3).await?;
    let after = env.alice.view_account().await?.balance;
    let spent = before.saturating_sub(after);
    assert!(spent < NearToken::from_millinear(30), "sitter lost {spent} on a refused request");
    Ok(())
}

#[tokio::test]
async fn outsiders_cannot_call_the_callback() -> anyhow::Result<()> {
    let env = deploy().await?;
    let result = env
        .alice
        .call(env.registry.id(), "on_sitting_result")
        .args_json(json!({ "sitting_id": 0 }))
        .transact()
        .await?;
    assert!(result.is_failure());
    assert!(format!("{:?}", result.into_result().unwrap_err()).contains("Method on_sitting_result is private"));
    Ok(())
}

#[tokio::test]
async fn two_failed_retests_in_a_row_revoke_and_outages_change_nothing() -> anyhow::Result<()> {
    let env = deploy().await?;
    sit(&env).await?;

    // An outage during a re-test leaves the certificate as it was.
    set_mode(&env, "Outage").await?;
    assert_eq!(retest(&env, 0).await?, json!({ "Incomplete": { "failed_calls": QUESTIONS } }));
    assert!(is_certified(&env).await?);

    // First complete failure suspends.
    wait_out_cooldown(&env).await?;
    set_mode(&env, "Fail").await?;
    assert_eq!(retest(&env, 0).await?, json!({ "Suspended": { "cert_id": 0, "score_bps": 0 } }));
    assert!(!is_certified(&env).await?);

    // A second one in a row revokes.
    wait_out_cooldown(&env).await?;
    assert_eq!(retest(&env, 0).await?, json!({ "Revoked": { "cert_id": 0, "score_bps": 0 } }));
    let cert = view(&env, "get_certificate", json!({ "cert_id": 0 })).await?;
    assert!(cert["status"].get("Revoked").is_some(), "{cert}");
    Ok(())
}

#[tokio::test]
async fn retests_are_rate_limited_on_chain() -> anyhow::Result<()> {
    let env = deploy().await?;
    sit(&env).await?;
    retest(&env, 0).await?;
    let result = env
        .alice
        .call(env.registry.id(), "retest")
        .args_json(json!({ "cert_id": 0 }))
        .deposit(SITTING_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(format!("{:?}", result.into_result().unwrap_err()).contains("at least an hour apart"));
    Ok(())
}
