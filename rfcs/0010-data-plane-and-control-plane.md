# RFC 0010: Data Plane and Control Plane

- **Status:** Draft
- **Created:** 2026-03-04

## Summary

Appliance separates concerns into two planes:

- **Data plane** -- Direct communication between clients (SDK, CLI, Desktop) and appliance endpoints (local daemon or cloud server). Simple access model: admin, read, or none.
- **Control plane** -- Management layer for multi-tenant organizations with RBAC, ACLs, teams, and audit trails. Part of the Appliance managed/enterprise cloud offering (proprietary).

The data plane is open-source and works the same whether the endpoint is a local daemon on your laptop or a cloud server on AWS. The control plane is an optional layer on top for organizations that need governance.

## Motivation

The current authentication model (RFC 0005) handles a single concern: "does this client have a valid API key?" This works for single-operator installations but doesn't distinguish between:

- A CI pipeline that should only deploy, not delete
- A team member who should read logs but not modify infrastructure
- A Desktop user who just needs to browse and open appliances
- A local daemon that the current user implicitly has full access to

We need a model that is:

1. **Simple at the data plane** -- Two access levels (admin and read) plus unauthenticated. No roles, no policies, no groups to configure for a single-user setup.
2. **Extensible at the control plane** -- Full RBAC/ACL for organizations that need it, layered on top without changing the data plane protocol.
3. **Uniform across endpoints** -- The same SDK client works against a local daemon and a cloud server. The authentication mechanism is the same; only the credential source differs.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Clients                                                    │
│                                                             │
│  ┌─────┐    ┌─────┐    ┌─────────┐                         │
│  │ SDK │    │ CLI │    │ Desktop │                         │
│  └──┬──┘    └──┬──┘    └────┬────┘                         │
│     │          │            │                               │
│     └──────────┴────────────┘                               │
│                │                                            │
│         ApplianceClient                                     │
│         (unified interface)                                 │
└────────────────┬────────────────────────────────────────────┘
                 │
        ┌────────┴────────┐
        │   Data Plane    │
        │   (direct mode) │
        └────────┬────────┘
                 │
    ┌────────────┼────────────┐
    │            │            │
    ▼            ▼            ▼
┌────────┐  ┌────────┐  ┌────────────┐
│ Local  │  │ Cloud  │  │ Cloud      │
│ Daemon │  │ Server │  │ Server     │
│        │  │ (AWS)  │  │ (GCP, ...) │
└────────┘  └────────┘  └────────────┘

─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
                 │
        ┌────────┴────────┐
        │ Control Plane   │         (optional, proprietary)
        │ (managed cloud) │
        └─────────────────┘
```

## Endpoints

An **endpoint** is any Appliance API server that clients connect to. All endpoints implement the same data plane API. The client doesn't care what's behind the endpoint.

### Local Daemon

The local daemon runs on the user's machine and manages locally-running appliances. It is started automatically by Appliance Desktop or manually via the CLI.

```
Endpoint:  http://localhost:7210
Auth:      Implicit (same-user, same-machine)
Storage:   ~/Appliance/
```

**Characteristics:**

- Single-user by definition -- the person running the daemon has full access
- No authentication required in direct mode (connection is localhost-only)
- Can optionally require a local token for security (e.g., multi-user machines)
- Manages local containers, processes, and storage
- Implements the same API as cloud endpoints

### Cloud Server

A cloud server is a remotely-hosted Appliance API server. `appliance-cloud-aws` is the current implementation (Lambda + S3), but any cloud provider can implement the same API.

```
Endpoint:  https://api.example.com
Auth:      API key + HTTP Message Signatures (RFC 9421)
Storage:   S3 (or equivalent)
```

**Characteristics:**

- Multi-user -- multiple clients connect with different API keys
- Full authentication required (HTTP Message Signatures)
- May be self-hosted or managed (Appliance Cloud)
- Manages cloud infrastructure via Pulumi

### Endpoint Discovery

Clients maintain a list of known endpoints in their configuration:

```json
{
  "endpoints": [
    {
      "name": "local",
      "url": "http://localhost:7210",
      "type": "daemon",
      "default": true
    },
    {
      "name": "production",
      "url": "https://api.mycompany.appliance.sh",
      "type": "server",
      "accessKeyId": "ak_abc123"
    },
    {
      "name": "staging",
      "url": "https://staging-api.mycompany.appliance.sh",
      "type": "server",
      "accessKeyId": "ak_def456"
    }
  ]
}
```

The CLI and Desktop can switch between endpoints:

```bash
# CLI
appliance --endpoint production deploy
appliance --endpoint local install redis

# Or set a default
appliance endpoint use production
```

In Desktop, endpoints appear as sections in the sidebar (see RFC 0007).

## Data Plane: Access Model

The data plane has three access levels. No roles, no groups, no policies -- just three tiers.

### Access Levels

| Level     | Can do                                                                                             | Typical user                                           |
| --------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **admin** | Everything: create/delete projects, deploy/destroy environments, manage API keys, read all data    | Operator, developer, CI pipeline                       |
| **read**  | Read-only: list projects, list environments, get deployment status, view logs, open appliance URLs | Designer, stakeholder, monitoring, Desktop browse-only |
| **none**  | Nothing. Request rejected.                                                                         | Revoked key, unknown client                            |

### How Access Level is Determined

#### Local Daemon

The local daemon **always** requires a token, even on localhost. On first start, the daemon generates a cryptographically random token and stores it at `~/Appliance/.token` (mode 0600, owner-read-only). The CLI and Desktop read this token automatically -- the user never sees it.

```
request + valid token   → admin
request + invalid token → none (401)
request + no token      → none (401)
```

This is the minimum viable security for a local service:

- **Protects against local privilege escalation.** On multi-user machines, other users cannot access your daemon even though it's on localhost. The token file is only readable by the owner.
- **Protects against browser-based attacks.** Malicious web pages cannot make authenticated requests to `localhost:7210` because they don't have the token. Without this, any website could send `fetch('http://localhost:7210/api/v1/local/stop')` and control your appliances (CSRF via localhost).
- **Protects against rogue local processes.** A compromised or untrusted application running under a different user account cannot reach the daemon.
- **Zero friction for the legitimate user.** The CLI and Desktop read `~/Appliance/.token` automatically. The user never types a token or sees a login prompt for local access.

The token is passed as a bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

**Token lifecycle:**

- Generated automatically on first daemon start (64 bytes, hex-encoded)
- Stored at `~/Appliance/.token` with mode `0600`
- Rotated via `appliance daemon rotate-token` (invalidates all existing connections)
- Desktop and CLI re-read the token file on each request (so rotation is seamless)

#### Cloud Server

Each API key has an access level set at creation:

```bash
# Create an admin key (default)
appliance key create --name "ci-deploy" --access admin

# Create a read-only key
appliance key create --name "monitoring" --access read
```

The access level is stored alongside the key hash:

```typescript
{
  id: 'ak_abc123',
  secretHash: '...',
  name: 'ci-deploy',
  access: 'admin',       // <-- new field
  createdAt: '...',
  lastUsedAt: '...'
}
```

### Enforcement

The data plane enforces access at the API layer. Every endpoint checks:

1. **Is the request authenticated?** (valid signature / localhost / local token)
2. **What access level does this client have?** (admin or read)
3. **Does this access level permit this operation?**

#### Operation → Access Level Matrix

| Operation             | admin | read |
| --------------------- | :---: | :--: |
| List projects         |  Yes  | Yes  |
| Get project           |  Yes  | Yes  |
| Create project        |  Yes  |  No  |
| Delete project        |  Yes  |  No  |
| List environments     |  Yes  | Yes  |
| Get environment       |  Yes  | Yes  |
| Create environment    |  Yes  |  No  |
| Delete environment    |  Yes  |  No  |
| Execute deployment    |  Yes  |  No  |
| Get deployment status |  Yes  | Yes  |
| View logs             |  Yes  | Yes  |
| Create API key        |  Yes  |  No  |
| Revoke API key        |  Yes  |  No  |
| Bootstrap             |  Yes  |  No  |

The implementation is a simple middleware check:

```typescript
function requireAccess(level: 'admin' | 'read') {
  return (req, res, next) => {
    if (req.auth.access === 'admin') return next(); // admin can do everything
    if (level === 'read' && req.auth.access === 'read') return next();
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Insufficient access', status: 403 },
    });
  };
}

// Usage
router.get('/projects', requireAccess('read'), listProjects);
router.post('/projects', requireAccess('admin'), createProject);
```

### Why Only Two Levels?

More granular permissions (deploy-but-not-destroy, project-A-but-not-project-B) are useful for organizations but add complexity that single-operator and small-team setups don't need. The data plane stays simple:

- **admin** = you run this installation, you can do anything
- **read** = you can see what's happening but not change anything

Fine-grained access control belongs in the control plane.

## Control Plane (Proprietary)

The control plane is an optional management layer provided by the Appliance managed/enterprise cloud offering. It sits above the data plane and adds organizational features.

### What the Control Plane Adds

| Feature       | Data Plane                 | Control Plane                                             |
| ------------- | -------------------------- | --------------------------------------------------------- |
| Access levels | admin / read               | RBAC with custom roles                                    |
| Scope         | All-or-nothing             | Per-project, per-environment                              |
| Users         | API keys only              | User accounts, SSO, OIDC                                  |
| Teams         | None                       | Team-based access                                         |
| Audit         | Basic (key ID + timestamp) | Full audit trail with user identity                       |
| Policies      | None                       | Deployment policies (approval gates, branch restrictions) |
| Multi-tenancy | Single tenant              | Multi-tenant with isolation                               |

### RBAC Model (Control Plane)

The control plane introduces:

- **Users** -- Human identities (email, SSO)
- **Teams** -- Groups of users
- **Roles** -- Named permission sets (e.g., "deployer", "viewer", "project-admin")
- **Bindings** -- Role assignments scoped to a resource (project, environment, or global)

```
User "alice@company.com"
  └── Role "deployer" on Project "billing-api"
        ├── Can deploy to staging
        ├── Can deploy to production (with approval)
        ├── Can view all environments
        └── Cannot delete anything

User "bob@company.com"
  └── Role "viewer" on Project "billing-api"
        ├── Can view all environments
        ├── Can view deployment status
        └── Cannot deploy or modify
```

### How Control Plane and Data Plane Interact

The control plane does **not** replace the data plane authentication. Instead:

1. User authenticates with the control plane (SSO, OIDC, email/password)
2. Control plane issues a **scoped API key** with the appropriate data plane access level
3. Client uses that API key against the data plane endpoint as normal
4. Data plane enforces the access level; control plane enforces the scope

```
┌──────────┐     authenticate     ┌───────────────┐
│  Client  │ ──────────────────→ │ Control Plane │
│  (CLI)   │                     │ (managed)     │
│          │ ←────────────────── │               │
│          │   scoped API key    │  RBAC/ACL     │
│          │   (admin or read,   │  evaluation   │
│          │    project-scoped)  │               │
│          │                     └───────────────┘
│          │
│          │     data plane API
│          │ ──────────────────→ ┌───────────────┐
│          │                     │  Cloud Server │
│          │ ←────────────────── │  (data plane) │
└──────────┘                     └───────────────┘
```

This means:

- The data plane API never changes -- it always sees admin or read keys
- The control plane handles the complexity of mapping users/teams/roles to access levels
- Self-hosted installations work fine without the control plane
- The control plane can restrict scope (project-scoped keys) by issuing keys that are scoped at the data plane level

### Scoped Keys

The control plane can issue API keys that are scoped to specific resources:

```typescript
{
  id: 'ak_scoped_123',
  secretHash: '...',
  access: 'admin',
  scope: {                    // optional, control-plane-issued
    projects: ['proj_abc'],   // only these projects
    environments: ['env_xyz'] // only these environments
  }
}
```

The data plane enforces scoping as a simple filter -- if a key has a `scope`, requests for out-of-scope resources return 404 (not 403, to avoid leaking existence).

## Client Authentication Flow

### SDK

```typescript
import { ApplianceClient } from '@appliance.sh/sdk';

// Connect to local daemon (reads token from ~/Appliance/.token automatically)
const local = ApplianceClient.local();

// Or provide the token explicitly
const local2 = new ApplianceClient({
  endpoint: 'http://localhost:7210',
  token: 'a1b2c3...',
});

// Connect to cloud server
const cloud = new ApplianceClient({
  endpoint: 'https://api.mycompany.appliance.sh',
  accessKeyId: 'ak_abc123',
  secretAccessKey: 'sk_xyz789',
});

// Same API, regardless of endpoint
const projects = await local.listProjects();
const envs = await cloud.listEnvironments('proj_abc');
```

### CLI

```bash
# Authenticate with a cloud server (stores credentials)
appliance login --endpoint https://api.mycompany.appliance.sh

# Local daemon works immediately (CLI reads ~/Appliance/.token)
appliance --endpoint local list

# Default endpoint is used when --endpoint is omitted
appliance deploy
```

### Desktop

Desktop maintains connections to all configured endpoints:

- **Local daemon:** Auto-connected on launch using the local token file. No login prompt -- Desktop reads `~/Appliance/.token` directly.
- **Cloud servers:** Connected on launch using stored credentials (OS keychain). Login prompt if credentials are missing or expired.

## Local Daemon Details

### Lifecycle

The local daemon is a lightweight HTTP server that runs in the background:

```bash
# Started automatically by Desktop on launch
# Or manually:
appliance daemon start

# Runs until explicitly stopped or Desktop quits
appliance daemon stop

# Check status
appliance daemon status
```

### API

The daemon implements the same REST API as cloud servers (`/api/v1/projects`, `/api/v1/deployments`, etc.) with additional local-only endpoints:

| Endpoint                   | Description                        |
| -------------------------- | ---------------------------------- |
| `POST /api/v1/local/start` | Start a local appliance            |
| `POST /api/v1/local/stop`  | Stop a local appliance             |
| `GET /api/v1/local/logs`   | Stream logs from a local appliance |
| `GET /api/v1/health`       | Daemon health check                |

### Security

Defense in depth -- multiple layers, not just one:

**1. Loopback binding.** The daemon binds to `127.0.0.1` only. It is not reachable from the network. This is the first barrier but not the only one -- localhost alone is not a sufficient trust boundary (see: browser CSRF, multi-user machines, local malware).

**2. Token authentication (always on).** Every request must include a valid bearer token in the `Authorization` header. The token is generated on first start and stored at `~/Appliance/.token` (mode 0600). This protects against:

- Other users on the same machine (they can't read the token file)
- Browser-based CSRF attacks (websites can't set `Authorization` headers on cross-origin requests)
- Rogue local processes running under a different user

**3. CORS rejection.** The daemon sets `Access-Control-Allow-Origin` to reject all cross-origin requests. Even if a browser somehow obtained the token, the preflight check would block the request.

**4. Origin validation.** For extra protection, the daemon rejects requests with an `Origin` or `Referer` header that doesn't match `localhost` or the Desktop app's origin. This catches edge cases where CORS isn't enforced (e.g., simple GET requests).

**Configuration:**

```json
// ~/Appliance/daemon.json
{
  "bindAddress": "127.0.0.1",
  "port": 7210
}
```

**Token management:**

```bash
# View token (for debugging)
appliance daemon token

# Rotate token (invalidates all existing connections)
appliance daemon rotate-token

# Token file location
cat ~/Appliance/.token   # only readable by owner
```

**Unix socket option (planned).** On macOS and Linux, the daemon can optionally listen on a Unix domain socket (`~/Appliance/daemon.sock`) instead of TCP. This eliminates the network surface entirely -- access is governed purely by filesystem permissions on the socket file. This is the same approach used by Docker Engine.

## Migration from RFC 0005

RFC 0005 describes the current authentication model. This RFC extends it:

| RFC 0005                      | This RFC                                   |
| ----------------------------- | ------------------------------------------ |
| API keys with no access level | API keys with `access: 'admin' \| 'read'`  |
| Single endpoint               | Multiple endpoints (local + cloud)         |
| Cloud-only                    | Local daemon + cloud server                |
| Flat access                   | Data plane (simple) + control plane (RBAC) |

Existing API keys default to `access: 'admin'` for backwards compatibility. The HTTP Message Signatures mechanism (RFC 9421) remains unchanged -- it is the data plane authentication protocol for cloud endpoints.

## Summary Table

| Concern            | Data Plane                                                          | Control Plane                           |
| ------------------ | ------------------------------------------------------------------- | --------------------------------------- |
| **Scope**          | Open source                                                         | Proprietary (managed/enterprise)        |
| **Access model**   | admin / read / none                                                 | RBAC, ACLs, teams, policies             |
| **Auth mechanism** | API keys + HTTP signatures (cloud), local token + loopback (daemon) | SSO, OIDC, email/password               |
| **Endpoint types** | Local daemon, cloud server                                          | Appliance Cloud (managed)               |
| **Who needs it**   | Everyone                                                            | Organizations with multiple users/teams |
| **State**          | Per-endpoint (S3, local disk)                                       | Centralized (Appliance Cloud)           |
