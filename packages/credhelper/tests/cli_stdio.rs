use std::process::Command;

fn helper() -> Command {
    Command::new(env!("CARGO_BIN_EXE_appliance-credhelper"))
}

#[test]
fn help_and_version_never_write_to_stdout() {
    for argument in ["--help", "--version"] {
        let output = helper().arg(argument).output().unwrap();
        assert!(output.status.success(), "{argument}: {output:?}");
        assert!(output.stdout.is_empty(), "{argument} leaked onto stdout");
        assert!(
            !output.stderr.is_empty(),
            "{argument} did not render on stderr"
        );
    }
}

#[test]
fn malformed_cli_never_writes_to_stdout() {
    let output = helper().args(["cluster", "get"]).output().unwrap();
    assert_eq!(output.status.code(), Some(5));
    assert!(output.stdout.is_empty());
    assert!(!output.stderr.is_empty());
}
