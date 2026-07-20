# RFC 0009: Appliance Stacks

- **Status:** Implemented — see docs/stacks.md and the README stacks section
- **Created:** 2026-03-04

## Summary

An **Appliance Stack** is a manifest that describes a group of appliances that are deployed and managed together as a unit. It is the `docker-compose.yml` of the Appliance world -- but for any deployment target (cloud, desktop, local development).

This is distinct from the Pulumi stack used internally by the Appliance infrastructure layer. An Appliance Stack is a user-facing concept that describes application composition.

## Motivation

Real applications are rarely a single service. A typical web application might consist of:

- A frontend (static site or web app)
- A backend API (server)
- A database (container)
- A background worker (worker)
- A cache (container)

Today, each of these would be a separate appliance with a separate manifest, deployed independently. This works, but:

- There's no way to express that they belong together
- Dependency ordering (database must start before API) is manual
- Shared configuration (database URL used by both API and worker) is duplicated
- Deploying the whole thing requires multiple `appliance deploy` commands
- On Desktop, the user has to start each service individually

An Appliance Stack solves this by letting developers describe the complete application topology in a single file.

## Stack Manifest

The stack manifest lives alongside individual appliance manifests, typically as `appliance-stack.json` or `stack.appliance.json`:

```json
{
  "stack": "v1",
  "name": "my-saas",
  "description": "Full-stack SaaS application",
  "appliances": {
    "db": {
      "manifest": "v2",
      "name": "postgres",
      "type": "server",
      "image": {
        "format": "container",
        "image": "postgres:16",
        "port": 5432,
        "volumes": ["pg-data:/var/lib/postgresql/data"]
      }
    },
    "cache": {
      "manifest": "v2",
      "name": "redis",
      "type": "server",
      "image": {
        "format": "container",
        "image": "redis:7",
        "port": 6379
      }
    },
    "api": {
      "path": "./api/appliance.json",
      "dependsOn": ["db", "cache"],
      "env": {
        "DATABASE_URL": "postgres://postgres:postgres@${db.host}:${db.port}/app",
        "REDIS_URL": "redis://${cache.host}:${cache.port}"
      }
    },
    "worker": {
      "path": "./worker/appliance.json",
      "dependsOn": ["db", "cache"],
      "env": {
        "DATABASE_URL": "postgres://postgres:postgres@${db.host}:${db.port}/app",
        "REDIS_URL": "redis://${cache.host}:${cache.port}"
      }
    },
    "web": {
      "path": "./web/appliance.json",
      "dependsOn": ["api"]
    }
  }
}
```

## Schema

### Top-Level Fields

| Field         | Type                         | Required | Description                |
| ------------- | ---------------------------- | -------- | -------------------------- |
| `stack`       | `"v1"`                       | Yes      | Stack schema version       |
| `name`        | `string`                     | Yes      | Stack name                 |
| `description` | `string`                     | No       | Human-readable description |
| `appliances`  | `Record<string, StackEntry>` | Yes      | Named appliance entries    |

### Stack Entry

Each entry in `appliances` is either an **inline manifest** or a **reference to an external manifest**, plus stack-specific configuration.

#### Reference Entry

Points to an existing `appliance.json` file:

```json
{
  "path": "./api/appliance.json",
  "dependsOn": ["db"],
  "env": {
    "DATABASE_URL": "postgres://${db.host}:${db.port}/app"
  }
}
```

| Field       | Type                     | Required | Description                                                               |
| ----------- | ------------------------ | -------- | ------------------------------------------------------------------------- |
| `path`      | `string`                 | Yes      | Relative path to appliance manifest                                       |
| `dependsOn` | `string[]`               | No       | Names of appliances that must start first                                 |
| `env`       | `Record<string, string>` | No       | Environment variables (supports interpolation)                            |
| `expose`    | `boolean`                | No       | Whether this appliance is externally accessible (default: kind-dependent) |
| `replicas`  | `number`                 | No       | Number of instances (default: 1)                                          |

#### Inline Entry

Embeds the full appliance manifest directly in the stack:

```json
{
  "manifest": "v2",
  "name": "redis",
  "type": "server",
  "image": {
    "format": "container",
    "image": "redis:7",
    "port": 6379
  }
}
```

Inline entries support the same `dependsOn`, `env`, `expose`, and `replicas` fields alongside the manifest fields.

## Variable Interpolation

Stack entries can reference other appliances using `${name.property}` syntax:

| Variable      | Resolves To                                    |
| ------------- | ---------------------------------------------- |
| `${db.host}`  | Hostname of the `db` appliance                 |
| `${db.port}`  | Port of the `db` appliance                     |
| `${db.url}`   | Full URL of the `db` appliance (if applicable) |
| `${api.host}` | Hostname of the `api` appliance                |

This enables appliances to discover each other without hardcoding addresses. The resolution differs by deployment target:

| Target                   | `${db.host}` resolves to               |
| ------------------------ | -------------------------------------- |
| Desktop (local)          | `localhost` or container network alias |
| Cloud (same environment) | Internal service DNS name              |
| Cloud (shared base)      | `db.app.example.com`                   |

## Dependency Ordering

The `dependsOn` field defines startup order. When deploying or starting a stack:

1. Build a dependency graph from all `dependsOn` declarations
2. Detect cycles (error if found)
3. Start appliances in topological order
4. Wait for each appliance's health check before starting its dependents
5. If an appliance fails to start, do not start its dependents

```
db ─────────┐
             ├──→ api ──→ web
cache ──────┘
             └──→ worker
```

In this graph, `db` and `cache` start first (in parallel), then `api` and `worker` (in parallel), then `web`.

## Lifecycle Operations

### Deploy Stack

```bash
appliance stack deploy --env production
```

Deploys all appliances in the stack to the specified environment, respecting dependency order. Each appliance gets its own infrastructure (Lambda, container, etc.) but they share the environment's base.

### Start Stack (Desktop)

In Appliance Desktop, starting a stack starts all its appliances in dependency order. The stack appears as a single entry in the sidebar with expandable sub-items:

```
● My SaaS
  ├── ● db (running)
  ├── ● cache (running)
  ├── ● api (running)
  ├── ● worker (running)
  └── ● web (running)
```

Clicking "Stop" on the stack stops all appliances in reverse dependency order.

### Destroy Stack

```bash
appliance stack destroy --env production
```

Destroys all appliances in reverse dependency order.

### Partial Operations

Individual appliances within a stack can be restarted independently:

```bash
appliance stack restart api --env production
```

Desktop shows per-appliance controls within the stack view.

## Stack on Desktop vs Cloud

The same stack manifest works in both contexts:

### Desktop (Local)

- Appliances run as containers or processes on the user's machine
- Networking is handled via localhost with unique port assignments
- `${name.host}` resolves to `localhost` or a Docker network alias
- Volumes are mapped to `~/Appliance/data/<stack>/<appliance>/`
- The user sees one "app" in the sidebar, not five separate services

### Cloud

- Each appliance is deployed as a separate infrastructure stack
- Networking depends on the base type (CloudFront routing, ALB, VPC networking)
- `${name.host}` resolves to internal DNS names or service endpoints
- Volumes are mapped to EBS, EFS, or equivalent cloud storage
- The environment dashboard shows the stack as a group

## Relationship to Docker Compose

Appliance Stacks are conceptually similar to Docker Compose but differ in important ways:

|                | Docker Compose                  | Appliance Stack                               |
| -------------- | ------------------------------- | --------------------------------------------- |
| **Scope**      | Local containers only           | Local, cloud, desktop -- any target           |
| **Runtime**    | Containers only                 | Containers, frameworks, binaries, zips        |
| **Deployment** | `docker compose up`             | `appliance stack deploy` or Desktop click     |
| **Networking** | Docker networks                 | Target-dependent (localhost, cloud DNS, etc.) |
| **State**      | Local only                      | Managed across environments                   |
| **User**       | Developer with Docker installed | Anyone with Appliance Desktop or CLI          |

A key difference: Docker Compose files describe _how to run containers_. Appliance Stacks describe _what the application consists of_. The runtime figures out how to run it.

## Examples

### Simple Web App with Database

```json
{
  "stack": "v1",
  "name": "blog",
  "appliances": {
    "db": {
      "manifest": "v2",
      "name": "postgres",
      "type": "server",
      "image": {
        "format": "container",
        "image": "postgres:16",
        "port": 5432,
        "volumes": ["pg-data:/var/lib/postgresql/data"]
      },
      "env": {
        "POSTGRES_DB": "blog",
        "POSTGRES_USER": "blog",
        "POSTGRES_PASSWORD": "localdev"
      }
    },
    "app": {
      "path": "./appliance.json",
      "dependsOn": ["db"],
      "env": {
        "DATABASE_URL": "postgres://blog:localdev@${db.host}:${db.port}/blog"
      }
    }
  }
}
```

### Microservices

```json
{
  "stack": "v1",
  "name": "ecommerce",
  "appliances": {
    "postgres": {
      "manifest": "v2",
      "name": "postgres",
      "type": "server",
      "image": { "format": "container", "image": "postgres:16", "port": 5432 }
    },
    "redis": {
      "manifest": "v2",
      "name": "redis",
      "type": "server",
      "image": { "format": "container", "image": "redis:7", "port": 6379 }
    },
    "auth": {
      "path": "./services/auth/appliance.json",
      "dependsOn": ["postgres", "redis"]
    },
    "catalog": {
      "path": "./services/catalog/appliance.json",
      "dependsOn": ["postgres"]
    },
    "orders": {
      "path": "./services/orders/appliance.json",
      "dependsOn": ["postgres", "redis", "auth"]
    },
    "gateway": {
      "path": "./services/gateway/appliance.json",
      "dependsOn": ["auth", "catalog", "orders"],
      "expose": true
    }
  }
}
```

### Desktop Application with Backend

A desktop app that needs a local database and API:

```json
{
  "stack": "v1",
  "name": "note-taking-app",
  "description": "A local-first note-taking app",
  "appliances": {
    "db": {
      "manifest": "v2",
      "name": "sqlite-server",
      "type": "server",
      "image": {
        "format": "container",
        "image": "litestream/litestream",
        "port": 8081,
        "volumes": ["notes-data:/data"]
      }
    },
    "app": {
      "manifest": "v2",
      "name": "notes",
      "type": "desktop",
      "image": {
        "format": "framework",
        "framework": "node",
        "port": 3000
      },
      "desktop": {
        "displayName": "Notes",
        "icon": "icon.png",
        "openOnStart": true
      },
      "dependsOn": ["db"],
      "env": {
        "DB_URL": "http://${db.host}:${db.port}"
      }
    }
  }
}
```

On Desktop, this shows up as a single "Notes" app. The user clicks "Start", Desktop launches the database first, waits for its health check, then starts the frontend and opens it in the browser. The user has no idea there are two processes running.

## Zod Schema (Sketch)

```typescript
const StackEntryRef = z.object({
  path: z.string(),
  dependsOn: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  expose: z.boolean().optional(),
  replicas: z.number().min(1).optional(),
});

const StackEntryInline = ApplianceV2.extend({
  dependsOn: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  expose: z.boolean().optional(),
  replicas: z.number().min(1).optional(),
});

const StackEntry = z.union([StackEntryRef, StackEntryInline]);

const ApplianceStack = z.object({
  stack: z.literal('v1'),
  name: z.string(),
  description: z.string().optional(),
  appliances: z.record(StackEntry),
});
```

## Open Questions

1. **Secrets in stacks?** The `env` field in stack entries is committed to source control. Secrets should go through `appliance secret` or a `.env` file. How do these interact with stack-level env?
2. **Shared volumes?** Should two appliances in a stack be able to share a volume? This is common (e.g., a sidecar reading logs from the main app).
3. **Stack registry?** Should stacks be publishable to the catalog, so users can install a complete multi-service app with one click?
4. **Partial cloud deploy?** In a stack, some appliances might be cloud-only (e.g., the production database is RDS, not a container). How do we express "use this for local, use that for cloud"?
