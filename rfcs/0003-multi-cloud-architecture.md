# RFC 0003: Multi-Cloud Architecture

- **Status:** Draft — only the aws-public base is implemented so far
- **Created:** 2026-03-04

## Summary

This RFC describes how Appliance achieves multi-cloud support through the Appliance Base abstraction layer, enabling applications to deploy to AWS, GCP, Azure, bare-metal servers, and local/desktop environments without changes to the application manifest.

## Motivation

Cloud lock-in is a real concern. Organizations want the flexibility to:

- Run the same application on different providers for redundancy or compliance
- Migrate between providers without rewriting deployment infrastructure
- Develop locally with a setup that mirrors production
- Deploy to edge locations, on-premise servers, or desktop environments

Appliance solves this by separating **what** an application is (the manifest) from **where** it runs (the base).

## Architecture

### The Abstraction Boundary

```
                Provider-Agnostic                    Provider-Specific
          ┌─────────────────────────┐          ┌──────────────────────────┐
          │                         │          │                          │
          │   appliance.json        │          │   Appliance Base         │
          │   (manifest)            │──deploy──│   (infrastructure)       │
          │                         │    to    │                          │
          │   Project               │          │   CDN, DNS, Compute,     │
          │   Environment           │          │   Networking, Storage    │
          │   Deployment            │          │                          │
          └─────────────────────────┘          └──────────────────────────┘
```

The manifest describes the application. The base provides the infrastructure. Deployments connect them.

### Appliance Base Interface

Every base type must implement a common contract:

```typescript
interface ApplianceBaseProvider {
  // Provision the base infrastructure (CDN, DNS, networking)
  deploy(config: ApplianceBaseConfig): Promise<BaseDeployResult>;

  // Tear down the base infrastructure
  destroy(config: ApplianceBaseConfig): Promise<BaseDestroyResult>;

  // Deploy an application stack onto this base
  deployStack(env: Environment, appliance: Appliance): Promise<StackDeployResult>;

  // Tear down an application stack
  destroyStack(env: Environment): Promise<StackDestroyResult>;

  // Return the URL where the application is accessible
  getEndpoint(env: Environment): Promise<string>;
}
```

### Current Base Types

#### `appliance-base-aws-public`

Public-facing applications on AWS using serverless infrastructure.

**Components provisioned:**

- Route53 hosted zone for DNS
- ACM certificate for TLS
- CloudFront distribution for CDN and edge routing
- Lambda@Edge function for request signing and routing
- S3 buckets for state and data
- SSM Parameter Store for configuration

**Per-environment stack:**

- Lambda function (application runtime)
- Lambda Function URL (HTTP endpoint)
- IAM roles and policies
- CloudFront origin routing rules

**Routing model:**
Requests hit CloudFront, which invokes a Lambda@Edge function. The edge function signs the request using SigV4 and forwards it to the appropriate Lambda Function URL based on the hostname. This enables multiple environments to share a single CloudFront distribution while each getting their own subdomain.

```
client ──→ CloudFront ──→ Lambda@Edge (SigV4 sign) ──→ Lambda Function URL
                              │
                              ├── app.example.com      → prod Lambda
                              ├── staging.example.com   → staging Lambda
                              └── pr-42.example.com     → preview Lambda
```

#### `appliance-base-aws-vpc` (Planned)

VPC-based applications for workloads requiring private networking.

**Additional components:**

- VPC with configurable CIDR and availability zones
- Private/public subnets
- NAT gateways
- Application Load Balancer
- ECS Fargate or EC2 instances

### Planned Base Types

#### `appliance-base-gcp-public`

Public-facing applications on Google Cloud Platform.

**Likely components:**

- Cloud DNS for DNS
- Cloud CDN for edge caching
- Cloud Run for serverless compute
- Cloud Load Balancing for routing
- Certificate Manager for TLS

#### `appliance-base-azure-public`

Public-facing applications on Microsoft Azure.

**Likely components:**

- Azure DNS for DNS
- Azure Front Door for CDN and routing
- Azure Container Apps for compute
- Azure Key Vault for secrets

#### `appliance-base-local`

Local development environment that mirrors cloud behavior.

**Likely components:**

- Docker Compose for container orchestration
- Local DNS via `/etc/hosts` or dnsmasq
- mkcert for local TLS
- File-based state storage

This enables `appliance deploy --env local` to spin up a production-like environment on the developer's machine.

#### `appliance-base-bare-metal`

Direct deployment to servers via SSH.

**Likely components:**

- SSH-based provisioning
- systemd services or Docker containers
- Caddy or nginx for reverse proxy and TLS
- File-based or SQLite state storage

#### `appliance-base-desktop`

Desktop application packaging and distribution.

**Likely components:**

- Electron or Tauri wrapper generation
- Auto-update server
- Platform-specific installers (DMG, MSI, AppImage)
- Code signing

## Base Configuration

Each base type has its own configuration schema, validated by Zod:

```typescript
// AWS Public Base
{
  type: 'appliance-base-aws-public',
  name: 'prod-us-east',
  region: 'us-east-1',
  dns: {
    domainName: 'apps.example.com',
    createZone: true
  }
}

// GCP Public Base (planned)
{
  type: 'appliance-base-gcp-public',
  name: 'prod-us-central',
  region: 'us-central1',
  projectId: 'my-gcp-project',
  dns: {
    domainName: 'apps.example.com'
  }
}

// Local Base (planned)
{
  type: 'appliance-base-local',
  name: 'local-dev',
  dns: {
    domainName: 'apps.local'
  }
}
```

## Base Output Configuration

After a base is provisioned, it produces a `ApplianceBaseConfig` that environments reference:

```typescript
{
  name: 'prod-us-east',
  type: 'appliance-base-aws-public',
  stateBackendUrl: 's3://appliance-state-abc123',
  domainName: 'apps.example.com',
  aws: {
    region: 'us-east-1',
    zoneId: 'Z1234567890',
    cloudfrontDistributionId: 'E1234567890',
    cloudfrontDistributionDomainName: 'd111111abcdef8.cloudfront.net',
    edgeRouterRoleArn: 'arn:aws:iam::123456789:role/edge-router',
    dataBucketName: 'appliance-data-abc123'
  }
}
```

Each provider will have its own output shape nested under a provider key (`aws`, `gcp`, `azure`, etc.).

## Infrastructure-as-Code Strategy

Appliance uses Pulumi with the Automation API, which allows programmatic infrastructure management without requiring the Pulumi CLI. This is critical for:

- **Serverless execution:** The API server runs as a Lambda; it can't shell out to `pulumi up`
- **Multi-cloud:** Pulumi supports all major cloud providers with the same programming model
- **TypeScript native:** Infrastructure code is TypeScript, same as the rest of the platform

Each base type is implemented as a Pulumi `ComponentResource`. The `ApplianceDeploymentService` wraps the Automation API to provide a clean deploy/destroy interface.

## Cross-Provider Concerns

### DNS

Every base type must support DNS management. The abstraction is:

- Base creates/manages a DNS zone for its domain
- Each environment gets a subdomain (e.g., `staging.apps.example.com`)
- Custom domains can be added via CNAME or ALIAS records

### TLS

All bases must provision and manage TLS certificates:

- Cloud bases use provider-managed certificates (ACM, Certificate Manager, etc.)
- Local bases use mkcert or similar
- Bare-metal bases use Let's Encrypt via Caddy or certbot

### State Storage

Each base manages its own state backend:

- Cloud bases use provider object storage (S3, GCS, Azure Blob)
- Local/bare-metal bases use file-based or SQLite storage

## Migration Path

Moving an application between providers:

1. Create a new base on the target provider
2. Create a new environment on that base
3. Deploy the same application (same `appliance.json`) to the new environment
4. Update DNS to point to the new environment
5. Destroy the old environment

The application manifest doesn't change. Only the base configuration differs.
