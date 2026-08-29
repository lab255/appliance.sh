#![cfg(windows)]

use serde::Deserialize;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
struct EnvelopeVector {
    encoded: String,
}

fn helper() -> Command {
    Command::new(env!("CARGO_BIN_EXE_appliance-credhelper"))
}

fn unique_profile() -> String {
    format!(
        "pipe-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

#[test]
fn binary_pipe_and_exit_code_contract() {
    let vectors: Vec<EnvelopeVector> = serde_json::from_str(include_str!(
        "../../credential-store/testdata/envelope-vectors.json"
    ))
    .unwrap();
    let golden = vectors.last().unwrap().encoded.as_bytes();
    let profile = unique_profile();

    let missing = helper()
        .args(["cluster", "get", "--profile", &profile])
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(3));
    assert!(missing.stdout.is_empty());

    let mut child = helper()
        .args(["cluster", "put", "--profile", &profile])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(golden).unwrap();
    let put = child.wait_with_output().unwrap();
    assert_eq!(put.status.code(), Some(0));
    assert!(put.stdout.is_empty());

    let get = helper()
        .args(["cluster", "get", "--profile", &profile])
        .output()
        .unwrap();
    assert_eq!(get.status.code(), Some(0));
    assert_eq!(get.stdout, golden);

    assert_eq!(
        helper()
            .args(["cluster", "probe", "--profile", &profile])
            .status()
            .unwrap()
            .code(),
        Some(0)
    );
    assert_eq!(
        helper()
            .args(["cluster", "delete", "--profile", &profile])
            .status()
            .unwrap()
            .code(),
        Some(0)
    );
    assert_eq!(
        helper()
            .args(["cluster", "probe", "--profile", &profile])
            .status()
            .unwrap()
            .code(),
        Some(3)
    );

    assert_eq!(
        helper().args(["cluster", "get"]).status().unwrap().code(),
        Some(5)
    );
    assert_eq!(
        helper()
            .args(["agent", "get", "--provider", "../invalid"])
            .status()
            .unwrap()
            .code(),
        Some(6)
    );
}
