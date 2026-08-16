//! Bring-up credential mint: the engine owns the FIRST api key.
//!
//! A VM's api-server keeps its key store on the VM's data disk, so a
//! freshly created (or recreated) VM boots with ZERO keys. Historically
//! only the wrapping CLI's `appliance vm up` minted one — an engine-only
//! start (`appliance-vm up|start|run`, the desktop's engine self-heal,
//! a crashed CLI) left the store empty forever and every client holding
//! a now-dead credential with nothing to re-mint it. This module closes
//! that hole at the layer that owns the VM lifecycle.
//!
//! The resident host process spawns one background thread per boot. It
//! reaches the guest api-server at `127.0.0.1:9091` *through the vsock
//! shell channel* — available seconds into boot, long before k3s or the
//! traefik ingress — and:
//!
//! 1. polls `/bootstrap/status` until the api-server answers;
//! 2. if the store already has keys AND the host profile store carries
//!    a credential for this VM, does nothing (verification of a stale
//!    key is the CLI's and desktop's job — they can sign requests);
//! 3. otherwise mints a key via `/bootstrap/create-key`, authorized by
//!    the guest's own `/etc/appliance/bootstrap-token`, and persists it
//!    to `~/.appliance/profiles.json` exactly as the CLI would.
//!
//! The CLI's `vm up` then finds a working profile and adopts it instead
//! of minting a second key; the desktop's cluster sync picks the profile
//! up on its next status poll.

use crate::guest::API_SERVER_GUEST_PORT;
use crate::guest_exec::run_wrapped;
use crate::profiles;
use crate::spec::{VmPaths, VmSpec, DEFAULT_VM_NAME};
use crate::bringup;
use std::time::{Duration, Instant};

/// How long the thread keeps trying before giving up. The shell agent
/// and api-server start seconds into boot; the budget is generous only
/// for pathological first boots.
const MINT_DEADLINE: Duration = Duration::from_secs(15 * 60);
/// Poll spacing while waiting for the guest api-server to answer.
const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// A failing *mint* (as opposed to an unreachable server) is not
/// transient — a token mismatch or server bug won't fix itself. Try a
/// few times, then leave the field to the CLI/desktop paths.
const MAX_MINT_ATTEMPTS: u32 = 3;

/// Spawn the bring-up mint thread for this boot. No-op for agent-only
/// VMs (no api-server) and hosts without staged api-server artifacts
/// (the guest never started one).
pub fn spawn_bringup_mint(spec: &VmSpec) {
    if spec.agent_only || !spec.cluster || crate::guest::apiserver_assets().is_none() {
        return;
    }
    let name = spec.name.clone();
    let host_port = spec.host_port;
    std::thread::spawn(move || run_mint_loop(&name, host_port));
}

fn run_mint_loop(name: &str, host_port: u16) {
    let vm_dir = VmPaths::for_name(name).dir.clone();
    let deadline = Instant::now() + MINT_DEADLINE;
    let mut mint_attempts = 0u32;
    loop {
        if Instant::now() >= deadline {
            eprintln!("credential mint: giving up after {}s (api-server never answered)", MINT_DEADLINE.as_secs());
            return;
        }
        if matches!(
            bringup::read(&vm_dir).map(|b| b.phase),
            Some(bringup::Phase::Failed)
        ) {
            return;
        }

        match probe_initialized(name) {
            // Not reachable yet (relay not up, api-server still
            // starting) — quiet wait.
            Err(_) => {}
            Ok(initialized) => {
                let ids = profiles::vm_profile_ids(name);
                let host_has_profile = profiles::profile_key_id(&ids[0]).is_some();
                if !needs_mint(initialized, host_has_profile) {
                    return;
                }
                mint_attempts += 1;
                match mint_and_persist(name, host_port, &ids) {
                    Ok(key_id) => {
                        println!(
                            "credential mint: initial api key {key_id} saved to profile '{}'",
                            ids[0]
                        );
                        return;
                    }
                    Err(e) if mint_attempts >= MAX_MINT_ATTEMPTS => {
                        eprintln!("credential mint failed ({mint_attempts} attempts), giving up: {e}");
                        return;
                    }
                    Err(e) => {
                        eprintln!("credential mint attempt {mint_attempts} failed, retrying: {e}");
                    }
                }
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Whether the engine should mint: yes unless the guest store already
/// has keys AND the host already holds a credential profile for this
/// VM. (An initialized store with no host profile still mints — the
/// host lost its credentials; an uninitialized store always mints.)
fn needs_mint(store_initialized: bool, host_has_profile: bool) -> bool {
    !(store_initialized && host_has_profile)
}

/// GET /bootstrap/status inside the guest. `Ok(initialized)` when the
/// api-server answered with its bootstrap state. Shared with the
/// runtime doctor's guest reachability check.
pub(crate) fn probe_initialized(name: &str) -> Result<bool, String> {
    let out = run_wrapped(
        name,
        &format!("wget -qO- -T 5 http://127.0.0.1:{API_SERVER_GUEST_PORT}/bootstrap/status"),
    )?;
    let parsed: serde_json::Value =
        serde_json::from_str(out.trim()).map_err(|e| format!("parse status: {e} ({out:?})"))?;
    parsed
        .get("initialized")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| format!("status response missing 'initialized': {out:?}"))
}

/// POST /bootstrap/create-key inside the guest (authorized by the
/// guest's own token file) and persist the minted key host-side.
/// Returns the new key id.
fn mint_and_persist(name: &str, host_port: u16, profile_ids: &[String]) -> Result<String, String> {
    let body = serde_json::json!({ "name": key_name(name) }).to_string();
    let out = run_wrapped(
        name,
        &format!(
            "wget -qO- -T 10 \
             --header \"X-Bootstrap-Token: $(cat /etc/appliance/bootstrap-token)\" \
             --header 'Content-Type: application/json' \
             --post-data '{body}' \
             http://127.0.0.1:{API_SERVER_GUEST_PORT}/bootstrap/create-key"
        ),
    )?;
    let key: serde_json::Value =
        serde_json::from_str(out.trim()).map_err(|e| format!("parse minted key: {e}"))?;
    let (id, secret) = match (
        key.get("id").and_then(|v| v.as_str()),
        key.get("secret").and_then(|v| v.as_str()),
    ) {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => (id, secret),
        _ => return Err(format!("create-key response missing id/secret: {out:?}")),
    };
    profiles::upsert_vm_credentials(
        profile_ids,
        &profiles::ProfileCredentials {
            api_url: format!("http://api.appliance.localhost:{host_port}"),
            key_id: id.to_string(),
            secret: secret.to_string(),
        },
    )?;
    Ok(id.to_string())
}

/// Human label for the minted key — matches the CLI's `vm up` naming.
/// VM names are constrained upstream, but defend the JSON body anyway:
/// anything outside a safe charset falls back to the bare label.
fn key_name(name: &str) -> String {
    if name == DEFAULT_VM_NAME {
        return "Dev Machine".to_string();
    }
    let safe = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if safe {
        format!("Dev Machine ({name})")
    } else {
        "Dev Machine".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mints_when_store_is_uninitialized() {
        // The incident class: fresh data disk, zero keys — mint no
        // matter what the host holds (a stale profile heals too).
        assert!(needs_mint(false, false));
        assert!(needs_mint(false, true));
    }

    #[test]
    fn mints_when_host_lost_its_profile() {
        // Store has keys but the host has no profile for this VM —
        // without a mint the host can never talk to it again.
        assert!(needs_mint(true, false));
    }

    #[test]
    fn leaves_a_healthy_pairing_alone() {
        // Keys exist and the host holds a profile: whether that profile
        // still VERIFIES is the signing clients' job, not the engine's.
        assert!(!needs_mint(true, true));
    }

    #[test]
    fn key_names_match_cli_labels_and_stay_json_safe() {
        assert_eq!(key_name("appliance"), "Dev Machine");
        assert_eq!(key_name("claude"), "Dev Machine (claude)");
        // A hostile name never reaches the JSON body.
        assert_eq!(key_name("x\"y"), "Dev Machine");
    }
}
