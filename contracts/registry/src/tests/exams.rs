//! Registering and managing exams.

use super::*;

#[test]
fn registers_exam_with_author_and_commitment() {
    let r = setup();
    let exam = r.get_exam(EXAM.into()).unwrap();
    assert_eq!(exam.author, acc("author.testnet"));
    assert_eq!(exam.commitment, COMMIT);
    assert_eq!(exam.question_count, QUESTIONS);
    assert!(exam.active);
    assert!(get_logs().iter().any(|l| l.contains("exam_registered")));
}

#[test]
#[should_panic(expected = "commitment must be 64 lowercase hex characters")]
fn rejects_bad_commitment() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("x".into(), "X".into(), "not-a-hash".into(), 6000, 5, "p".into());
}

#[test]
#[should_panic(expected = "exam_id is already registered")]
fn rejects_duplicate_exam() {
    let mut r = setup();
    set("other.testnet", NearToken::from_near(1), 300);
    r.register_exam(EXAM.into(), "Copy".into(), COMMIT.into(), 6000, 5, "p".into());
}

#[test]
#[should_panic(expected = "pass_mark_bps must be at most 10000")]
fn rejects_pass_mark_over_100_percent() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("y".into(), "Y".into(), COMMIT.into(), 10_001, 5, "p".into());
}

#[test]
#[should_panic(expected = "question_count must be between 1 and 64")]
fn rejects_exam_over_the_question_cap() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("y".into(), "Y".into(), COMMIT.into(), 6000, 65, "p".into());
}

#[test]
#[should_panic(expected = "exam_id may only use letters, digits")]
fn rejects_exam_id_with_separator() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("e|f".into(), "Y".into(), COMMIT.into(), 6000, 5, "p".into());
}

#[test]
#[should_panic(expected = "secrets_profile must be 1-64 letters, digits, - or _")]
fn rejects_profile_outlayer_would_refuse() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("y".into(), "Y".into(), COMMIT.into(), 6000, 5, "my.profile".into());
}

#[test]
#[should_panic(expected = "only the exam author can do this")]
fn only_author_can_deactivate_exam() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.set_exam_active(EXAM.into(), false);
}
