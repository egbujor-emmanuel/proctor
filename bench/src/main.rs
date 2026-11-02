//! PROCTOR benchmark: sits the registered exam N times per model through NEAR
//! AI Cloud, grades with proctor-core like the enclave does, and publishes
//! scores plus what the registry's two-strike rule does with them.
//!
//!   NEARAI_API_KEY=... cargo run -p proctor-bench --release -- \
//!     --exam exams/near-protocol-basics.public.json --runs 10 \
//!     --models anthropic/claude-sonnet-5-5,openai/gpt-5.4-nano

mod analysis;
mod ask;
mod report;

use std::time::{SystemTime, UNIX_EPOCH};
use std::{env, fs, process, thread};

use analysis::{stats, ModelStats, Run};
use ask::Asker;
use proctor_core::{commitment, grade, parse_exam, score_bps, Exam};
use serde::Serialize;

const DEFAULT_MODELS: &str = "anthropic/claude-sonnet-5-5,openai/gpt-5.4-nano,deepseek-ai/DeepSeek-V4.1-Flash-1017,google/gemini-3.5-flash,openai/gpt-5.5";

#[derive(Serialize)]
pub struct Results {
    exam_id: String,
    exam_commitment: String,
    question_count: usize,
    pass_mark_bps: u32,
    started_utc: String,
    command: String,
    runs_per_model: u32,
    models: Vec<ModelStats>,
    runs: Vec<ModelRuns>,
}

#[derive(Serialize)]
struct ModelRuns {
    model: String,
    runs: Vec<Run>,
}

struct Args {
    exam: String,
    models: Vec<String>,
    runs: u32,
    out_dir: String,
    max_tokens: u32,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args { exam: String::new(), models: vec![], runs: 10, out_dir: "bench".into(), max_tokens: 4096 };
    let mut models = DEFAULT_MODELS.to_string();
    let mut it = env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--exam" => args.exam = value()?,
            "--models" => models = value()?,
            "--runs" => args.runs = value()?.parse().map_err(|_| "--runs must be a number")?,
            "--out-dir" => args.out_dir = value()?,
            "--max-tokens" => args.max_tokens = value()?.parse().map_err(|_| "--max-tokens must be a number")?,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if args.exam.is_empty() {
        return Err("--exam <exam.json> is required".into());
    }
    if args.runs == 0 {
        return Err("--runs must be at least 1".into());
    }
    args.models = models.split(',').map(str::trim).filter(|m| !m.is_empty()).map(String::from).collect();
    Ok(args)
}

/// One sitting: every question at once (the exam is small), graded by proctor-core.
fn sit(asker: &Asker, exam: &Exam, model: &str) -> Run {
    let answers: Vec<Result<(String, String), String>> = thread::scope(|scope| {
        let handles: Vec<_> = exam.questions.iter().map(|q| scope.spawn(|| asker.ask(model, &q.prompt))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("question thread panicked".into()))).collect()
    });
    let mut run = Run { correct: 0, total: exam.questions.len() as u32, failed_calls: 0, score_bps: 0, response_ids: vec![] };
    for (question, answer) in exam.questions.iter().zip(answers) {
        match answer {
            Ok((id, reply)) => {
                run.response_ids.push(id);
                if grade(&question.grader, &reply) {
                    run.correct += 1;
                }
            }
            Err(reason) => {
                eprintln!("    {model} {}: failed call: {reason}", question.id);
                run.failed_calls += 1;
            }
        }
    }
    run.score_bps = score_bps(run.correct, run.total);
    run
}

/// Days-from-civil inverse (Howard Hinnant), so the report needs no date crate.
fn utc_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02} UTC", rem / 3600, rem % 3600 / 60)
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let api_key = env::var("NEARAI_API_KEY").map_err(|_| "set NEARAI_API_KEY")?;
    let bytes = fs::read(&args.exam).map_err(|e| format!("cannot read {}: {e}", args.exam))?;
    let exam = parse_exam(&bytes).map_err(|e| format!("invalid exam: {e:?}"))?;
    let asker = Asker::new(api_key, args.max_tokens);
    let started_utc = utc_now();
    eprintln!("exam {} ({} questions), {} run(s) x {} model(s)", exam.exam_id, exam.questions.len(), args.runs, args.models.len());

    let mut all = Vec::new();
    for model in &args.models {
        let runs: Vec<Run> = (1..=args.runs)
            .map(|i| {
                let run = sit(&asker, &exam, model);
                eprintln!("  {model} run {i}/{}: {}/{} (failed calls {})", args.runs, run.correct, run.total, run.failed_calls);
                run
            })
            .collect();
        all.push(ModelRuns { model: model.clone(), runs });
    }

    let results = Results {
        exam_id: exam.exam_id.clone(),
        exam_commitment: commitment(&bytes),
        question_count: exam.questions.len(),
        pass_mark_bps: exam.pass_mark_bps,
        started_utc,
        command: format!("cargo run -p proctor-bench --release -- --exam {} --runs {} --models {}", args.exam, args.runs, args.models.join(",")),
        runs_per_model: args.runs,
        models: all.iter().map(|m| stats(&m.model, &m.runs, exam.pass_mark_bps)).collect(),
        runs: all,
    };
    fs::create_dir_all(&args.out_dir).map_err(|e| format!("cannot create {}: {e}", args.out_dir))?;
    let json = serde_json::to_string_pretty(&results).map_err(|e| e.to_string())?;
    fs::write(format!("{}/results.json", args.out_dir), json + "\n").map_err(|e| format!("cannot write results.json: {e}"))?;
    let page = report::markdown(&results);
    fs::write(format!("{}/RESULTS.md", args.out_dir), &page).map_err(|e| format!("cannot write RESULTS.md: {e}"))?;
    println!("{page}");
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        process::exit(1);
    }
}
