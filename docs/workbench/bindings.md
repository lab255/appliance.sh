# Workbench directory bindings (v1)

Workbench is a desktop view of a resolved project directory. It is not an API
Project, Environment, Build, Deployment, VM, or session. The URL encodes the
canonical directory, not its display name or the global cluster selection.

## Project-local format

Only `.appliance/workbench.json` belongs to the Workbench writer:

```json
{
  "version": 1,
  "label": "Example",
  "selectedTarget": { "kind": "local", "ref": "microvm" },
  "mutatingSessionId": "agent-example"
}
```

`version` is required. All other fields are optional. `selectedTarget.kind` is
`local` or `cloud`; `ref` identifies an existing host cluster. A missing target is
shown as unavailable until the human chooses a current target. References are
machine-local and must be resolved again on another computer. The session
selection is advisory, never an authorization lock. Unknown fields and unsupported
versions are rejected; malformed files are reported rather than overwritten.
No credentials, API copies, results, or build artifacts belong in this file.

The CLI utility is `packages/cli/src/utils/workbench.ts`. Desktop binding I/O lives
in `packages/desktop/src-tauri/src/workbench.rs`. Both use sibling temporary files
and rename. Neither writes `link.json` or `agents.json`. Reads use their existing
records only as observations; recorded sessions do not prove a VM is idle.

Resolution canonicalizes symlinks, then walks upward to the nearest existing
`.appliance/link.json` or `.appliance/workbench.json`. With neither present, the
opened directory is the identity. Opening a subdirectory therefore shows the
actual project root. Opening does not require a manifest or deployment link.

## Opened directories and creation

The desktop app-data file `workbench-directories.json` contains only an array of
opened canonical directory references. There is no filesystem crawl. Missing or
unreadable directories remain visible with an error. Project metadata is read
fresh, rather than copied into this index.

Create blank workspace requires an absolute existing parent and one folder name.
It exclusively creates an empty directory, without a manifest, framework, agent,
VM start or remount. Conflicts retain the form values. To avoid creating a child
that would resolve to its parent's project identity, a parent inside an existing
linked/bound project is rejected with an inline explanation. Cancellation before
submission has no filesystem effect. If indexing fails, only the newly created,
still-empty directory is removed (never recursively).

The open/create path has a named baseline-capture hook before returning. W3 replaces
its explicit unavailable stub with `inspection::capture(app, directory)`. Capture
is attempted only for a newly remembered directory, not on list/read/reopen.
Failure is a visible warning and does not gate launch. W3 owns persistent attempt
and warning records outside the mounted tree.

## UI and integration seams

`ConsoleHost.workbench` exposes `list`, `open`, `read`, `create`, and `update`.
`WorkbenchWorkspace.directory` is the canonical identity. `binding` is the small
format above; `sessions` and `affectedSessions` are recorded metadata, with the
latter read from the machine's actual mounted folder. No UI action remounts it.

Both Workbench routes require resolved developer mode and operator role. Existing
routes, the user navigation branch, `/agents`, and ordinary source deployment are
unchanged. The nav uses the shell's existing WeightLabel and variable-row reserve.

The detail selector reuses cluster classification and the canonical target list.
It writes only `binding.selectedTarget` and never invokes `selectCluster`.
Changing the shell's global target keeps Workbench detail open.

The current shell deliberately leaves these unavailable with adjacent reasons:

- W3: Changes / Files / Logs and host baseline capture.
- W2: Package action and its status/result.
- Wave 2b: live sessions, intent/steering, and workspace Deploy review/execution.

Ordinary `/projects/deploy` remains linked independently. No placeholder claims a
successful package, deployment, launch, inspection, or readiness event.
