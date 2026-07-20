# RFC 0006: Application Types and Build System

- **Status:** Partially implemented — v1 manifest shipped; remote/cloud builds continue in RFC 0011
- **Created:** 2026-03-04

## Summary

This RFC describes the v1 manifest format, build process, and application packaging. For the proposed v2 manifest that separates appliance type (server, desktop, worker) from image format (container, zip, framework, binary), see [RFC 0008: Manifest v2](./0008-manifest-v2.md). For composing multiple appliances into a single deployable unit, see [RFC 0009: Appliance Stacks](./0009-appliance-stacks.md).

## Application Types

The Appliance manifest (`appliance.json`) supports three application types, each targeting a different developer workflow.

### Container

For applications already packaged as container images.

```json
{
  "manifest": "v1",
  "type": "container",
  "name": "my-api",
  "port": 8080,
  "scripts": {
    "build": "docker build -t my-api ."
  }
}
```

**Use cases:**

- Dockerized microservices
- Applications with complex native dependencies
- Teams with existing container workflows

**Build process:**

1. Run the `build` script (typically `docker build`)
2. Tag and push the image to a registry (ECR, GCR, Docker Hub)
3. Deploy by pointing the infrastructure at the image

### Framework

For web applications using a known framework. Appliance auto-detects the framework and applies appropriate build and runtime configuration.

```json
{
  "manifest": "v1",
  "type": "framework",
  "name": "my-web-app",
  "framework": "node"
}
```

**Supported frameworks:**

| Framework | Detection                              | Build                | Runtime              |
| --------- | -------------------------------------- | -------------------- | -------------------- |
| `node`    | `package.json` present                 | `npm run build`      | `npm start`          |
| `python`  | `requirements.txt` or `pyproject.toml` | `pip install`        | gunicorn/uvicorn     |
| `auto`    | Inspects project files                 | Framework-specific   | Framework-specific   |
| `other`   | Manual specification                   | User-defined scripts | User-defined scripts |

**Auto-detection (`framework: "auto"`):**

1. Check for `package.json` → Node.js
2. Check for `requirements.txt` / `pyproject.toml` / `Pipfile` → Python
3. Check for `go.mod` → Go (planned)
4. Check for `Cargo.toml` → Rust (planned)
5. Fall back to `other`

**Includes/Excludes:**

Control which files are packaged for deployment:

```json
{
  "type": "framework",
  "name": "my-app",
  "framework": "node",
  "includes": ["dist/**", "package.json", "node_modules/**"],
  "excludes": ["**/*.test.ts", "src/**"]
}
```

### Other

For applications that don't fit the container or framework patterns. The developer provides all build and run logic via scripts.

```json
{
  "manifest": "v1",
  "type": "other",
  "name": "my-static-site",
  "scripts": {
    "build": "hugo --minify",
    "start": "caddy file-server --root public/"
  }
}
```

**Use cases:**

- Static site generators (Hugo, Eleventy, Jekyll)
- Custom build pipelines
- Non-web applications (workers, cron jobs, desktop apps)

## Build Process

### Local Build (`appliance build`)

Runs the build locally on the developer's machine:

1. Read `appliance.json`
2. Execute the `build` script (if defined)
3. Package the output according to type-specific rules
4. Produce a deployable artifact

### Remote Build (Planned)

Build in the cloud for consistency and reproducibility:

1. Upload source to the API server
2. Server runs the build in a clean environment (container)
3. Produce and store the artifact
4. Deploy from the artifact

### Build Artifacts

The output of a build depends on the deployment target:

| Target                     | Artifact                             |
| -------------------------- | ------------------------------------ |
| AWS Lambda                 | Zip file with handler + dependencies |
| Container (ECS, Cloud Run) | Container image                      |
| Bare metal                 | Tarball with application + runtime   |
| Desktop                    | Platform-specific installer          |

## Scripts

The `scripts` field in the manifest defines lifecycle hooks:

```json
{
  "scripts": {
    "prebuild": "npm run generate",
    "build": "npm run build",
    "postbuild": "npm run optimize",
    "start": "node dist/server.js",
    "test": "npm test",
    "migrate": "npm run db:migrate"
  }
}
```

**Script execution order during deploy:**

1. `prebuild` (if defined)
2. `build` (if defined)
3. `postbuild` (if defined)
4. Package artifact
5. Upload and deploy
6. `start` (used as the runtime command)

## Manifest Versioning

The `manifest` field enables future schema changes:

- `v1` -- Current schema (container, framework, other)
- Future versions can add new types, fields, or restructure without breaking existing manifests
- The platform will support multiple manifest versions simultaneously during migration periods

## Environment Variables and Secrets

Applications receive configuration through environment variables at runtime:

```json
{
  "type": "framework",
  "name": "my-api",
  "framework": "node",
  "env": {
    "NODE_ENV": "production",
    "LOG_LEVEL": "info"
  }
}
```

Sensitive values (database URLs, API keys) should use the `appliance secret` command rather than the manifest, so they aren't committed to source control.

## Port Configuration

- **Container type:** Port is required -- the container must expose this port
- **Framework type:** Port is optional -- detected from the framework or defaults to 3000
- **Other type:** No port -- may not be an HTTP service

The infrastructure layer maps the application's port to the external endpoint (e.g., Lambda Function URL proxies to the application port).

## Future Application Types

### `static`

Purpose-built for static sites with no server-side runtime:

```json
{
  "manifest": "v1",
  "type": "static",
  "name": "my-docs",
  "buildDir": "dist/",
  "scripts": {
    "build": "npm run build"
  }
}
```

Deploys directly to S3 + CloudFront without a Lambda function.

### `worker`

Background job processors, queue consumers, cron jobs:

```json
{
  "manifest": "v1",
  "type": "worker",
  "name": "email-sender",
  "schedule": "rate(5 minutes)",
  "scripts": {
    "build": "npm run build",
    "handler": "dist/handler.process"
  }
}
```

### `desktop`

See [RFC 0007: Appliance Desktop](./0007-appliance-desktop.md) for the full design. Appliance Desktop is a desktop shell application that allows non-technical users to install and run appliances locally, and to connect to cloud-hosted Appliance installations. It is not an application type in the manifest -- it is a standalone product that consumes appliances.
