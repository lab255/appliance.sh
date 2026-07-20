# RFC 0008: Manifest v2 -- Appliance Types and Image Formats

- **Status:** Draft — not implemented (the manifest remains v1)
- **Created:** 2026-03-04

## Summary

This RFC proposes a restructured appliance manifest (`v2`) that separates two orthogonal concerns:

1. **Type** -- What the appliance _is_ (server, desktop, worker, static site, etc.)
2. **Image** -- How the appliance is _packaged_ (container, zip, framework-built, etc.)

This replaces the v1 manifest where `type` conflated both concerns (e.g., `"type": "container"` described packaging, not purpose).

## Motivation

The v1 manifest has a single `type` field that mixes what an appliance does with how it's packaged:

```json
{ "type": "container" }   // packaging format, not purpose
{ "type": "framework" }   // build strategy, not purpose
{ "type": "other" }       // undefined
```

This breaks down when we consider:

- A **server** appliance could be packaged as a container _or_ a zip
- A **desktop** appliance could be packaged as a container (for Appliance Desktop to run) _or_ a native binary
- A **worker** appliance could be a container _or_ a Lambda zip
- The same codebase might produce both a server and a desktop appliance

In v2, `type` describes the appliance's purpose, and `image.format` describes its packaging. The v1 packaging-oriented values (`container`, `framework`, `other`) move into the `image` object.

## Manifest v2 Schema

```json
{
  "manifest": "v2",
  "name": "my-app",
  "type": "server",
  "image": {
    "format": "container",
    "port": 8080
  }
}
```

### Top-Level Fields

| Field         | Type                     | Required | Description                   |
| ------------- | ------------------------ | -------- | ----------------------------- |
| `manifest`    | `"v2"`                   | Yes      | Schema version                |
| `name`        | `string`                 | Yes      | Appliance name (kebab-case)   |
| `type`        | `string`                 | Yes      | What the appliance is         |
| `image`       | `object`                 | Yes      | How the appliance is packaged |
| `version`     | `string`                 | No       | Semantic version              |
| `description` | `string`                 | No       | Human-readable description    |
| `scripts`     | `Record<string, string>` | No       | Lifecycle hooks               |

## Types

The `type` field describes the appliance's purpose and runtime characteristics.

### `server`

A long-running process that serves HTTP requests. This is the most common type -- web applications, APIs, microservices.

```json
{
  "manifest": "v2",
  "name": "billing-api",
  "type": "server",
  "image": {
    "format": "container",
    "port": 3000
  }
}
```

**Runtime contract:**

- Must bind to a port and serve HTTP
- Runs continuously until stopped
- Deployed to cloud compute (Lambda, ECS, Cloud Run) or locally via Desktop

### `desktop`

An application intended to be run on a user's local machine through Appliance Desktop. Desktop appliances are presented in the Desktop UI with install/start/stop controls.

```json
{
  "manifest": "v2",
  "name": "notes",
  "type": "desktop",
  "image": {
    "format": "container",
    "port": 8080
  },
  "desktop": {
    "displayName": "Notes",
    "icon": "icon.png",
    "category": "productivity",
    "openOnStart": true
  }
}
```

**Runtime contract:**

- Runs locally via Appliance Desktop
- Typically serves a web UI on a local port (opened in the user's browser or an embedded webview)
- May also package as a native binary for standalone distribution

**Desktop-specific fields (`desktop` object):**

| Field         | Type      | Required | Description                                             |
| ------------- | --------- | -------- | ------------------------------------------------------- |
| `displayName` | `string`  | No       | Human-friendly name (defaults to `name`)                |
| `icon`        | `string`  | No       | Path to icon file (relative to manifest)                |
| `category`    | `string`  | No       | Catalog category (productivity, dev-tools, media, etc.) |
| `openOnStart` | `boolean` | No       | Open in browser automatically when started              |
| `singleton`   | `boolean` | No       | Only allow one instance (default: true)                 |

### `worker`

A background process that does not serve HTTP. Queue consumers, cron jobs, data pipelines.

```json
{
  "manifest": "v2",
  "name": "email-sender",
  "type": "worker",
  "image": {
    "format": "zip",
    "handler": "dist/handler.process"
  },
  "worker": {
    "schedule": "rate(5 minutes)"
  }
}
```

**Runtime contract:**

- Does not bind to a port
- May run continuously (queue consumer) or on a schedule (cron)
- Deployed to cloud compute (Lambda, ECS) or locally

### `static`

A static site with no server-side runtime. HTML, CSS, JS, images -- served directly from a CDN.

```json
{
  "manifest": "v2",
  "name": "docs",
  "type": "static",
  "image": {
    "format": "zip",
    "buildDir": "dist/"
  },
  "scripts": {
    "build": "npm run build"
  }
}
```

**Runtime contract:**

- No server process
- Served directly from object storage + CDN
- Build produces a directory of static files

### `task`

A one-shot process that runs to completion. Database migrations, batch jobs, setup scripts.

```json
{
  "manifest": "v2",
  "name": "db-migrate",
  "type": "task",
  "image": {
    "format": "container"
  }
}
```

**Runtime contract:**

- Runs once and exits
- Exit code indicates success (0) or failure (non-zero)
- Can be triggered by deployments, schedules, or manually

## Image Formats

The `image` field describes how the appliance is packaged and distributed. The `format` discriminator determines the schema.

### `container`

An OCI container image. The most portable format -- runs anywhere that supports containers.

```json
{
  "format": "container",
  "port": 8080,
  "dockerfile": "Dockerfile",
  "buildArgs": {
    "NODE_ENV": "production"
  }
}
```

| Field        | Type                     | Required                 | Description                                                |
| ------------ | ------------------------ | ------------------------ | ---------------------------------------------------------- |
| `format`     | `"container"`            | Yes                      | Discriminator                                              |
| `port`       | `number`                 | For server/desktop types | Port the container exposes                                 |
| `dockerfile` | `string`                 | No                       | Path to Dockerfile (default: `Dockerfile`)                 |
| `image`      | `string`                 | No                       | Pre-built image reference (e.g., `ghcr.io/org/app:latest`) |
| `buildArgs`  | `Record<string, string>` | No                       | Docker build arguments                                     |
| `volumes`    | `string[]`               | No                       | Named volumes for persistent data                          |

**When to use:** Applications with complex dependencies, polyglot stacks, or existing Docker workflows. Required for most `desktop` type appliances running in Appliance Desktop.

### `zip`

A zip archive of application code and dependencies. Lightweight, no container runtime needed.

```json
{
  "format": "zip",
  "handler": "dist/index.handler",
  "runtime": "node20",
  "includes": ["dist/**", "node_modules/**", "package.json"],
  "excludes": ["**/*.test.js", "**/*.map"]
}
```

| Field      | Type       | Required | Description                                   |
| ---------- | ---------- | -------- | --------------------------------------------- |
| `format`   | `"zip"`    | Yes      | Discriminator                                 |
| `handler`  | `string`   | No       | Entry point (e.g., `dist/index.handler`)      |
| `runtime`  | `string`   | No       | Target runtime (`node20`, `python3.12`, etc.) |
| `includes` | `string[]` | No       | Glob patterns to include                      |
| `excludes` | `string[]` | No       | Glob patterns to exclude                      |
| `buildDir` | `string`   | No       | Directory to zip (for static sites)           |

**When to use:** Lambda deployments, static sites, simple applications without native dependencies.

### `framework`

Auto-detected framework build. Appliance inspects the project and applies framework-specific build and packaging logic.

```json
{
  "format": "framework",
  "framework": "node",
  "port": 3000
}
```

| Field       | Type          | Required | Description                                     |
| ----------- | ------------- | -------- | ----------------------------------------------- |
| `format`    | `"framework"` | Yes      | Discriminator                                   |
| `framework` | `string`      | No       | `auto`, `node`, `python`, `go`, `rust`, `other` |
| `port`      | `number`      | No       | Override detected port                          |
| `includes`  | `string[]`    | No       | Additional files to include                     |
| `excludes`  | `string[]`    | No       | Files to exclude                                |

**When to use:** Standard web applications where Appliance can handle the build. Simplest path -- often zero-config.

### `binary`

A pre-compiled native binary. For applications distributed as standalone executables.

```json
{
  "format": "binary",
  "platforms": {
    "darwin-arm64": "bin/app-macos-arm64",
    "darwin-x64": "bin/app-macos-x64",
    "linux-x64": "bin/app-linux-x64",
    "win32-x64": "bin/app-win-x64.exe"
  },
  "port": 4000
}
```

| Field       | Type                     | Required | Description                     |
| ----------- | ------------------------ | -------- | ------------------------------- |
| `format`    | `"binary"`               | Yes      | Discriminator                   |
| `platforms` | `Record<string, string>` | Yes      | Platform -> binary path mapping |
| `port`      | `number`                 | No       | Port for server/desktop types   |

**When to use:** Go, Rust, or C++ applications compiled to native binaries. Desktop appliances that don't need containers.

## Type + Image Compatibility

Not every combination makes sense. This matrix shows which are valid:

| Type / Image | `container` | `zip` | `framework` | `binary` |
| :----------- | :---------: | :---: | :---------: | :------: |
| `server`     |     Yes     |  Yes  |     Yes     |   Yes    |
| `desktop`    |     Yes     |  No   |     Yes     |   Yes    |
| `worker`     |     Yes     |  Yes  |     Yes     |   Yes    |
| `static`     |     No      |  Yes  |     No      |    No    |
| `task`       |     Yes     |  Yes  |     Yes     |   Yes    |

## Examples

### Server as container

```json
{
  "manifest": "v2",
  "name": "billing-api",
  "type": "server",
  "image": {
    "format": "container",
    "port": 3000,
    "dockerfile": "Dockerfile"
  },
  "scripts": {
    "test": "npm test"
  }
}
```

### Server as framework (zero-config Node.js)

```json
{
  "manifest": "v2",
  "name": "marketing-site",
  "type": "server",
  "image": {
    "format": "framework",
    "framework": "node"
  }
}
```

### Desktop app as container

```json
{
  "manifest": "v2",
  "name": "baserow",
  "type": "desktop",
  "image": {
    "format": "container",
    "port": 80,
    "image": "baserow/baserow:latest",
    "volumes": ["baserow-data:/baserow/data"]
  },
  "desktop": {
    "displayName": "Baserow",
    "icon": "baserow-icon.png",
    "category": "productivity",
    "openOnStart": true
  }
}
```

### Desktop app as native binary

```json
{
  "manifest": "v2",
  "name": "code-editor",
  "type": "desktop",
  "image": {
    "format": "binary",
    "platforms": {
      "darwin-arm64": "bin/editor-macos-arm64",
      "darwin-x64": "bin/editor-macos-x64",
      "linux-x64": "bin/editor-linux-x64",
      "win32-x64": "bin/editor-win-x64.exe"
    },
    "port": 9000
  },
  "desktop": {
    "displayName": "Code Editor",
    "icon": "editor-icon.png",
    "category": "dev-tools"
  }
}
```

### Worker as zip (Lambda cron)

```json
{
  "manifest": "v2",
  "name": "report-generator",
  "type": "worker",
  "image": {
    "format": "zip",
    "handler": "dist/reports.generate",
    "runtime": "node20"
  },
  "worker": {
    "schedule": "cron(0 8 * * ? *)"
  },
  "scripts": {
    "build": "npm run build"
  }
}
```

### Static site

```json
{
  "manifest": "v2",
  "name": "docs",
  "type": "static",
  "image": {
    "format": "zip",
    "buildDir": "public/"
  },
  "scripts": {
    "build": "hugo --minify"
  }
}
```

### Server that also works as a desktop app

An appliance can be deployed to the cloud as a server _and_ installed locally via Desktop. The same manifest serves both:

```json
{
  "manifest": "v2",
  "name": "wiki",
  "type": "server",
  "image": {
    "format": "container",
    "port": 3000,
    "volumes": ["wiki-data:/data"]
  },
  "desktop": {
    "displayName": "Wiki",
    "icon": "wiki-icon.png",
    "category": "productivity",
    "openOnStart": true
  }
}
```

When `desktop` metadata is present on a `server` type, Appliance Desktop knows how to present and run it locally. The type remains `server` because the runtime contract is the same -- it serves HTTP. The `desktop` block is purely presentational metadata for the Desktop UI.

## Migration from v1

v1 manifests continue to work. The mapping:

| v1                                 | v2                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `{ type: "container", port }`      | `{ type: "server", image: { format: "container", port } }`               |
| `{ type: "framework", framework }` | `{ type: "server", image: { format: "framework", framework } }`          |
| `{ type: "other" }`                | `{ type: "server", image: { format: "framework", framework: "other" } }` |

The SDK will accept both `manifest: "v1"` and `manifest: "v2"` and normalize v1 to v2 internally. In v1, `type` referred to packaging format. In v2, `type` refers to the appliance's purpose, and packaging moves to `image.format`.

## Zod Schema (Sketch)

```typescript
const ImageContainer = z.object({
  format: z.literal('container'),
  port: z.number().min(1).max(65535).optional(),
  dockerfile: z.string().optional(),
  image: z.string().optional(),
  buildArgs: z.record(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
});

const ImageZip = z.object({
  format: z.literal('zip'),
  handler: z.string().optional(),
  runtime: z.string().optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
  buildDir: z.string().optional(),
});

const ImageFramework = z.object({
  format: z.literal('framework'),
  framework: z.enum(['auto', 'node', 'python', 'go', 'rust', 'other']).optional(),
  port: z.number().min(1).max(65535).optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
});

const ImageBinary = z.object({
  format: z.literal('binary'),
  platforms: z.record(z.string()),
  port: z.number().min(1).max(65535).optional(),
});

const Image = z.discriminatedUnion('format', [ImageContainer, ImageZip, ImageFramework, ImageBinary]);

const DesktopConfig = z.object({
  displayName: z.string().optional(),
  icon: z.string().optional(),
  category: z.string().optional(),
  openOnStart: z.boolean().optional(),
  singleton: z.boolean().optional(),
});

const WorkerConfig = z.object({
  schedule: z.string().optional(),
});

const ApplianceV2 = z.object({
  manifest: z.literal('v2'),
  name: z.string(),
  type: z.enum(['server', 'desktop', 'worker', 'static', 'task']),
  image: Image,
  version: z.string().optional(),
  description: z.string().optional(),
  scripts: z.record(z.string()).optional(),
  desktop: DesktopConfig.optional(),
  worker: WorkerConfig.optional(),
});
```
