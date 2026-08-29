use appliance_credential_store::KeyringStore;
use appliance_credhelper::{
    execute, parse_store_key, CommandError, KeyKind, Operation, Request, EXIT_INTERNAL,
    EXIT_MALFORMED, EXIT_OK,
};
use clap::{Parser, Subcommand};
use std::process::ExitCode;

#[derive(Debug, Parser)]
#[command(
    name = "appliance-credhelper",
    version,
    about = "Typed Appliance credential store helper"
)]
struct Cli {
    #[command(subcommand)]
    command: TopLevelCommand,
}

#[derive(Debug, Subcommand)]
enum TopLevelCommand {
    Cluster {
        #[command(subcommand)]
        command: ClusterCommand,
    },
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
    EntitlementKey {
        #[command(subcommand)]
        command: EntitlementKeyCommand,
    },
    EntitlementAnchor {
        #[command(subcommand)]
        command: EntitlementAnchorCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ClusterCommand {
    Get(ClusterIdentifier),
    Put(ClusterIdentifier),
    Delete(ClusterIdentifier),
    Probe(ClusterIdentifier),
}

#[derive(Debug, clap::Args)]
struct ClusterIdentifier {
    #[arg(long)]
    profile: String,
}

#[derive(Debug, Subcommand)]
enum AgentCommand {
    Get(AgentIdentifier),
    Put(AgentIdentifier),
    Delete(AgentIdentifier),
    Probe(AgentIdentifier),
}

#[derive(Debug, clap::Args)]
struct AgentIdentifier {
    #[arg(long)]
    provider: String,
}

#[derive(Debug, Subcommand)]
enum EntitlementKeyCommand {
    GetOrCreate,
}

#[derive(Debug, Subcommand)]
enum EntitlementAnchorCommand {
    Get,
    Put,
}

fn main() -> ExitCode {
    if let Err(message) = set_binary_stdio() {
        eprintln!("appliance-credhelper: {message}");
        return exit_code(EXIT_INTERNAL);
    }

    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            let help_or_version = matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            );
            let _ = error.print();
            return exit_code(if help_or_version {
                EXIT_OK
            } else {
                EXIT_MALFORMED
            });
        }
    };

    let request = match request_from_cli(cli) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("appliance-credhelper: {}", error.diagnostic());
            return exit_code(error.exit_code());
        }
    };

    let store = KeyringStore::new();
    match execute(
        &store,
        &request,
        &mut std::io::stdin().lock(),
        &mut std::io::stdout().lock(),
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("appliance-credhelper: {}", error.diagnostic());
            exit_code(error.exit_code())
        }
    }
}

fn request_from_cli(cli: Cli) -> Result<Request, CommandError> {
    match cli.command {
        TopLevelCommand::Cluster { command } => {
            let (operation, profile) = match command {
                ClusterCommand::Get(identifier) => (Operation::Get, identifier.profile),
                ClusterCommand::Put(identifier) => (Operation::Put, identifier.profile),
                ClusterCommand::Delete(identifier) => (Operation::Delete, identifier.profile),
                ClusterCommand::Probe(identifier) => (Operation::Probe, identifier.profile),
            };
            Ok(Request::Store {
                operation,
                key: parse_store_key(KeyKind::Cluster(&profile))?,
            })
        }
        TopLevelCommand::Agent { command } => {
            let (operation, provider) = match command {
                AgentCommand::Get(identifier) => (Operation::Get, identifier.provider),
                AgentCommand::Put(identifier) => (Operation::Put, identifier.provider),
                AgentCommand::Delete(identifier) => (Operation::Delete, identifier.provider),
                AgentCommand::Probe(identifier) => (Operation::Probe, identifier.provider),
            };
            Ok(Request::Store {
                operation,
                key: parse_store_key(KeyKind::Agent(&provider))?,
            })
        }
        TopLevelCommand::EntitlementKey {
            command: EntitlementKeyCommand::GetOrCreate,
        } => Ok(Request::EntitlementKeyGetOrCreate),
        TopLevelCommand::EntitlementAnchor { command } => Ok(match command {
            EntitlementAnchorCommand::Get => Request::EntitlementAnchorGet,
            EntitlementAnchorCommand::Put => Request::EntitlementAnchorPut,
        }),
    }
}

fn exit_code(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code).unwrap_or(EXIT_INTERNAL as u8))
}

#[cfg(not(windows))]
fn set_binary_stdio() -> Result<(), &'static str> {
    Ok(())
}

#[cfg(windows)]
fn set_binary_stdio() -> Result<(), &'static str> {
    const O_BINARY: i32 = 0x8000;
    unsafe extern "C" {
        fn _setmode(file_descriptor: i32, mode: i32) -> i32;
    }

    // stdin = 0, stdout = 1. stderr remains text-only diagnostics.
    if unsafe { _setmode(0, O_BINARY) } == -1 {
        return Err("could not set stdin to binary mode");
    }
    if unsafe { _setmode(1, O_BINARY) } == -1 {
        return Err("could not set stdout to binary mode");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_documented_command_shapes() {
        for argv in [
            vec!["helper", "cluster", "get", "--profile", "prod"],
            vec!["helper", "agent", "put", "--provider", "openai"],
            vec!["helper", "entitlement-key", "get-or-create"],
            vec!["helper", "entitlement-anchor", "get"],
        ] {
            assert!(Cli::try_parse_from(argv).is_ok());
        }
    }

    #[test]
    fn malformed_shape_is_not_claps_default_exit_two() {
        assert!(Cli::try_parse_from(["helper", "cluster", "get"]).is_err());
        assert_eq!(EXIT_MALFORMED, 5);
        assert_eq!(appliance_credhelper::EXIT_INVALID_IDENTIFIER, 6);
    }
}
