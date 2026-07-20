# RFC 0002: CLI Commands

- **Status:** Superseded by the shipped CLI — this catalog is stale; run `appliance --help` for the current surface
- **Created:** 2026-03-04

## Summary

The `appliance` CLI is the primary interface for developers interacting with the platform. This RFC describes the command structure, both existing commands and planned additions for multi-cloud and multi-target support.

## Command Structure

```
appliance <command> [subcommand] [options]
```

All commands follow a git-style subcommand pattern. Interactive prompts (via Inquirer) fill in missing arguments when running in a TTY.

## Implemented Commands

### `appliance login`

Authenticate the CLI with an Appliance API server.

```bash
# Interactive -- prompts for server URL and credentials
appliance login

# With arguments
appliance login --server https://api.appliance.sh
```

**Behavior:**

- On first use, prompts for a bootstrap token to create an API key
- On subsequent use, prompts for existing API key credentials
- Stores credentials in `~/.appliance/credentials.json` (mode 0600)
- Validates connectivity before saving

### `appliance configure`

Create or update the `appliance.json` manifest in the current directory.

```bash
# Interactive wizard
appliance configure
```

**Behavior:**

- Prompts for application name, type (container/framework/other)
- For containers: prompts for port
- For frameworks: prompts for framework type, port, includes/excludes
- Writes `appliance.json` to the current directory

### `appliance link`

Associate the current directory with a project on the server.

```bash
# Interactive -- lists projects or creates a new one
appliance link

# Link to existing project
appliance link --project my-project
```

**Behavior:**

- Lists existing projects or offers to create a new one
- Stores the project association locally
- Subsequent commands in this directory use the linked project

### `appliance deploy`

Deploy the current application to an environment.

```bash
# Interactive -- prompts for environment
appliance deploy

# Deploy to specific environment
appliance deploy --env production
```

**Behavior:**

- Reads `appliance.json` from the current directory
- Creates a deployment via the API
- Polls `GET /api/v1/deployments/:id` until completion
- Reports success with the live URL, or failure with error details

### `appliance destroy`

Tear down an environment's infrastructure.

```bash
appliance destroy --env staging
```

**Behavior:**

- Requires double confirmation (environment name + "yes")
- Creates a destroy deployment via the API
- Polls until the environment is torn down

### `appliance list`

List projects and environments.

```bash
# List all projects
appliance list

# List environments for a project
appliance list --project my-project
```

### `appliance status <deployment-id>`

Check the status of a deployment.

```bash
appliance status dep_abc123
```

### `appliance build`

Build the application locally using the manifest's build script.

```bash
appliance build
```

### `appliance install <appliance-names...>`

Install one or more appliances (pre-built applications or services).

```bash
appliance install postgres redis
```

### `appliance remove <appliance-names...>`

Remove installed appliances.

```bash
appliance remove postgres
```

## Planned Commands

### `appliance init`

Initialize a new project from scratch, combining `configure` + `link` into a single flow.

```bash
# Full interactive setup
appliance init

# From a template
appliance init --template express-api
```

**Behavior:**

- Detects the current directory's language/framework
- Generates `appliance.json` with sensible defaults
- Creates a project on the server and links it
- Optionally creates a default environment

### `appliance env`

Manage environments explicitly.

```bash
# List environments
appliance env list

# Create a new environment
appliance env create staging --base aws-public-us-east-1

# Show environment details
appliance env show production

# Delete an environment (must be destroyed first)
appliance env delete old-staging
```

### `appliance logs`

Stream or fetch logs from a deployed environment.

```bash
# Tail logs
appliance logs --env production --follow

# Last 100 lines
appliance logs --env production --lines 100

# Filter by time
appliance logs --env production --since 1h
```

### `appliance exec`

Run a command in the context of a deployed environment.

```bash
# Run a one-off command
appliance exec --env production -- npm run migrate

# Open an interactive shell (where supported)
appliance exec --env staging --interactive
```

### `appliance domain`

Manage custom domains for environments.

```bash
# Add a custom domain
appliance domain add --env production --domain app.example.com

# List domains
appliance domain list --env production

# Remove a domain
appliance domain remove --env production --domain app.example.com
```

### `appliance secret`

Manage environment variables and secrets.

```bash
# Set a secret
appliance secret set --env production DATABASE_URL=postgres://...

# List secrets (values masked)
appliance secret list --env production

# Remove a secret
appliance secret remove --env production DATABASE_URL
```

### `appliance base`

Manage infrastructure bases.

```bash
# List available bases
appliance base list

# Create a new base
appliance base create --type aws-public --region us-west-2 --domain apps.example.com

# Show base details
appliance base show aws-public-us-east-1

# Destroy a base (must have no environments)
appliance base destroy aws-public-us-east-1
```

### `appliance preview`

Create ephemeral preview environments, designed for CI/CD integration.

```bash
# Create a preview for a PR
appliance preview create --ref pr-42

# Destroy a preview
appliance preview destroy --ref pr-42

# List active previews
appliance preview list
```

## CLI Configuration

### Credential Storage

```
~/.appliance/
  credentials.json    # API keys (mode 0600)
  config.json         # CLI preferences
```

### Project-Local Configuration

```
./appliance.json      # Application manifest
./.appliance/
  project.json        # Linked project ID
```

## Exit Codes

| Code | Meaning                         |
| ---- | ------------------------------- |
| 0    | Success                         |
| 1    | General error                   |
| 2    | Invalid arguments / usage error |
| 3    | Authentication failure          |
| 4    | Deployment failure              |
| 5    | Timeout waiting for deployment  |

## Design Considerations

- **Offline-first:** Commands that don't need the server (configure, build) work without connectivity
- **CI-friendly:** All interactive prompts can be bypassed with flags; JSON output via `--json`
- **Progressive:** Simple commands work immediately; advanced options are discoverable via `--help`
- **Scriptable:** Exit codes and `--json` output enable use in shell scripts and CI pipelines
