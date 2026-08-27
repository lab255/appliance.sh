# CLI reference

Appliance has two command namespaces. Existing Builder commands remain available at the top level, so scripts such as `appliance build` and `appliance deploy` continue to work unchanged.

## Builder

`appliance builder <verb>` routes to the existing command implementation for:

`build`, `configure`, `deploy`, `deployment`, `destroy`, `dev`, `down`, `env`, `init`, `install`, `link`, `logs`, `manifest`, `open`, `shell`, `stack`, `test`, `unlink`, and `up`.

Use `appliance builder --help` for the descriptions. The top-level `list`, `logs`, and `open` commands retain their existing application/deployment behavior.

## Runtime

`appliance runtime <verb>` reserves the packaged-app surface: `run`, `install`, `uninstall`, `list`, `ps`, `stop`, `logs`, `open`, `search`, and `entitlements`.

These Runtime verbs are placeholders in this release. They print `coming in a later release` and exit with status 2. Unambiguous Runtime verbs (`run`, `uninstall`, `ps`, `stop`, `search`, and `entitlements`) also have top-level aliases; existing colliding top-level commands remain unchanged.

## `install` versus `deploy`

- `appliance deploy` keeps the existing target selection: it uses `--profile`, `APPLIANCE_PROFILE`, or the active cluster (usually a cloud cluster), falling back to the local cluster when none is selected.
- `appliance install` uses the same deploy engine but defaults to the local VM cluster. It ignores `APPLIANCE_PROFILE` and the active cluster; use `--cluster <name>` to install to another registered cluster (`--profile <name>` remains accepted for compatibility).
- `appliance runtime install` is the reserved packaged-app command and is still a placeholder in this release.
