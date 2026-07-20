# RFC 0001: Platform Overview

- **Status:** Historical — original vision; the shipped onboarding flow differs (see README and docs/onboarding.md)
- **Created:** 2026-03-04

## Summary

Appliance is a multi-cloud application platform that makes it easy to develop, deploy, and manage services across cloud providers. It provides a consistent developer experience regardless of target infrastructure, abstracting away provider-specific details while preserving full control when needed.

## Motivation

Deploying applications to the cloud remains unnecessarily complex. Developers must learn provider-specific tools, manage infrastructure configurations, handle networking, DNS, TLS certificates, and more -- all before their application serves a single request. This complexity multiplies across environments (dev, staging, production) and cloud providers.

Appliance reduces this to a simple workflow: describe your application, pick a target, and deploy.

## Core Concepts

### Appliance (Application Manifest)

An **Appliance** is a declarative description of an application. It lives alongside the source code (typically as `appliance.json`) and describes what the application is, how to build it, and how to run it.

Appliance supports three application types:

- **Container** -- A pre-built container image with an exposed port
- **Framework** -- A web application using a known framework (Node.js, Python, etc.) that Appliance can auto-detect and build
- **Other** -- Anything else, driven entirely by user-defined scripts

```json
{
  "manifest": "v1",
  "type": "framework",
  "name": "my-web-app",
  "framework": "node",
  "scripts": {
    "build": "npm run build",
    "start": "npm start"
  }
}
```

### Appliance Base (Infrastructure Foundation)

An **Appliance Base** is the foundational infrastructure that hosts applications. It is provider-specific and encapsulates networking, DNS, CDN, and routing concerns. A single base can host multiple projects and environments.

Current base types:

| Base Type                   | Description                                                                |
| --------------------------- | -------------------------------------------------------------------------- |
| `appliance-base-aws-public` | Public-facing: CloudFront CDN + Lambda@Edge router + Route53 DNS + ACM TLS |
| `appliance-base-aws-vpc`    | VPC-based: Private networking with optional public ingress (planned)       |

Future base types could include `appliance-base-gcp-public`, `appliance-base-azure-public`, bare-metal, or even desktop/local targets.

### Project

A **Project** groups related environments under a single name. It maps to a logical application or service -- e.g., "marketing-site" or "billing-api".

### Environment

An **Environment** is a deployable instance of a project on a specific base. Each environment has its own infrastructure stack, domain, and lifecycle. Common examples: `production`, `staging`, `dev`, `pr-42`.

### Deployment

A **Deployment** is a single execution of a deploy or destroy action against an environment. Deployments are asynchronous -- they are initiated, then polled for completion.

## How It Links Up

```
  Developer
     |
     v
  [CLI / appliance.json]
     |
     v
  [API Server]  <-- authenticated via HTTP Message Signatures (RFC 9421)
     |
     +-- ProjectService      -- CRUD for projects
     +-- EnvironmentService   -- CRUD for environments (each tied to a base)
     +-- DeploymentService    -- Orchestrates deploy/destroy
            |
            v
      [Infrastructure Layer]  -- Pulumi Automation API
            |
            +-- ApplianceBase (foundation: CDN, DNS, networking)
            +-- ApplianceStack (per-environment: Lambda, IAM, routing)
            |
            v
      [Cloud Provider]  -- AWS (Lambda, CloudFront, Route53, S3, etc.)
```

### Data Flow: From Code to Running Service

1. Developer runs `appliance configure` to create an `appliance.json` manifest
2. Developer runs `appliance login` to authenticate against the API server
3. Developer runs `appliance link` to associate the local directory with a project
4. Developer runs `appliance deploy` to push code to an environment
5. The API server creates a deployment record and invokes the infrastructure layer
6. Pulumi provisions or updates the cloud resources (Lambda function, routing rules, DNS)
7. The CLI polls until the deployment succeeds, then reports the live URL

### State Management

All state (projects, environments, deployments, API keys) is stored as JSON objects in S3 via the `ObjectStore` abstraction. Pulumi state is stored separately in an S3-backed state backend. This means the entire platform can run statelessly -- the API server is just a Lambda function itself.

## Design Principles

1. **Convention over configuration** -- Sensible defaults for common patterns. A Node.js app should deploy with zero config beyond a name.
2. **Progressive disclosure** -- Simple things are simple; complex things are possible. Start with `appliance deploy`, customize with full Pulumi access when needed.
3. **Multi-cloud by abstraction** -- The Appliance manifest is provider-agnostic. Provider specifics live in the base configuration, not the application.
4. **Infrastructure as cattle** -- Environments are cheap to create and destroy. Spin up a preview environment per PR, tear it down on merge.
5. **Self-hosting** -- The Appliance platform itself runs on Appliance. The API server is a Lambda deployed via the same infrastructure it manages.
