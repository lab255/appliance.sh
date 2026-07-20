# RFC 0005: Authentication and API Design

- **Status:** Draft
- **Created:** 2026-03-04

## Summary

This RFC describes the authentication mechanism (HTTP Message Signatures) and API design for the Appliance platform. For the broader access model (data plane vs control plane, local daemon vs cloud server, admin/read access levels), see [RFC 0010: Data Plane and Control Plane](./0010-data-plane-and-control-plane.md).

## Authentication Model

### API Keys

Every API client authenticates with a key pair:

- **Access Key ID** (`ak_{uuid}`) -- identifies the client
- **Secret Access Key** (`sk_{random}`) -- proves identity

Secrets are hashed with SHA-256 before storage. The plaintext secret is returned exactly once at creation and never stored or logged.

### HTTP Message Signatures (RFC 9421)

Requests are authenticated using HTTP Message Signatures, a standard for signing HTTP messages. This provides:

- **Integrity** -- The request body cannot be tampered with in transit
- **Authentication** -- Only the holder of the secret can produce a valid signature
- **Replay protection** -- Signatures include a creation timestamp and expiry (300s window)

**Signed components:**

- `@method` -- HTTP method (GET, POST, etc.)
- `@path` -- Request path
- `@authority` -- Host header
- `content-digest` -- SHA-256 hash of the request body (for requests with bodies)
- `content-type` -- Content type header

**Signature parameters:**

- `keyid` -- The Access Key ID
- `alg` -- `hmac-sha256`
- `created` -- Unix timestamp of signature creation
- `expires` -- Unix timestamp of signature expiry

### Why Not Bearer Tokens?

Bearer tokens (JWTs, opaque tokens) are simpler but have drawbacks:

- They don't protect request integrity -- a MITM can modify the body
- They're vulnerable to replay attacks without additional measures
- They require a separate mechanism for request validation

HTTP Message Signatures provide authentication and integrity in a single mechanism, with replay protection built in.

## Bootstrap Flow

The platform starts with no API keys. The bootstrap flow creates the first one:

```
1. Admin sets BOOTSTRAP_TOKEN environment variable on the API server
2. Admin calls POST /bootstrap/create-key with X-Bootstrap-Token header
3. Server validates the token and creates an API key
4. Server returns the key pair (only time the secret is shown)
5. Admin stores the credentials securely
```

The bootstrap endpoint is disabled once API keys exist (checked via `GET /bootstrap/status`).

The CLI implements this flow in `appliance login`:

```bash
$ appliance login
? Server URL: https://api.appliance.sh
No API keys found. Creating initial key...
? Bootstrap token: ********
API key created successfully.
Access Key ID: ak_abc123
Secret Access Key: sk_xyz789  # shown once, never again
Credentials saved to ~/.appliance/credentials.json
```

## API Design

### Versioning

All authenticated endpoints are versioned under `/api/v1/`. This allows breaking changes in future versions without disrupting existing clients.

### Resource Hierarchy

```
/api/v1/
  projects/
    {projectId}/
      environments/
        {environmentId}/
  deployments/
    {deploymentId}/
```

Projects contain environments. Deployments are top-level because they span concerns (they reference both a project and an environment but have their own lifecycle).

### Request/Response Format

All requests and responses use JSON. Zod schemas in the SDK validate both client-side (before sending) and server-side (on receipt).

**Create Project:**

```http
POST /api/v1/projects
Content-Type: application/json

{
  "name": "my-app",
  "description": "My web application"
}
```

```http
HTTP/1.1 201 Created

{
  "id": "proj_abc123",
  "name": "my-app",
  "description": "My web application",
  "status": "active",
  "createdAt": "2026-03-04T12:00:00Z",
  "updatedAt": "2026-03-04T12:00:00Z"
}
```

**Execute Deployment:**

```http
POST /api/v1/deployments
Content-Type: application/json

{
  "environmentId": "env_xyz789",
  "action": "deploy"
}
```

```http
HTTP/1.1 202 Accepted

{
  "id": "dep_def456",
  "projectId": "proj_abc123",
  "environmentId": "env_xyz789",
  "action": "deploy",
  "status": "pending",
  "startedAt": "2026-03-04T12:00:00Z"
}
```

### Error Responses

Errors follow a consistent format:

```json
{
  "error": {
    "code": "ENVIRONMENT_NOT_FOUND",
    "message": "Environment env_xyz789 not found",
    "status": 404
  }
}
```

### Pagination (Planned)

List endpoints will support cursor-based pagination:

```http
GET /api/v1/projects?limit=20&cursor=eyJpZCI6InByb2pfYWJjMTIzIn0
```

```json
{
  "items": [...],
  "cursor": "eyJpZCI6InByb2pfeHl6Nzg5In0",
  "hasMore": true
}
```

## SDK Client

The `ApplianceClient` in the SDK handles authentication transparently:

```typescript
import { ApplianceClient } from '@appliance.sh/sdk';

const client = new ApplianceClient({
  serverUrl: 'https://api.appliance.sh',
  accessKeyId: 'ak_abc123',
  secretAccessKey: 'sk_xyz789',
});

// Requests are automatically signed
const project = await client.createProject({ name: 'my-app' });
const envs = await client.listEnvironments(project.id);
```

The client automatically:

- Computes the Content-Digest for request bodies
- Generates the Signature and Signature-Input headers per RFC 9421
- Includes the creation and expiry timestamps

## Security Considerations

### Credential Storage

CLI credentials are stored at `~/.appliance/credentials.json` with mode `0600` (owner read/write only). The file contains:

```json
{
  "serverUrl": "https://api.appliance.sh",
  "accessKeyId": "ak_abc123",
  "secretAccessKey": "sk_xyz789"
}
```

### Timing-Safe Comparison

API key validation uses `crypto.timingSafeEqual()` to prevent timing attacks that could leak information about valid key hashes.

### Access Levels

API keys carry an access level (`admin` or `read`). See [RFC 0010](./0010-data-plane-and-control-plane.md) for the full access model.

### Key Rotation (Planned)

Future support for:

- Creating multiple API keys per installation
- Revoking individual keys
- Key expiry with automatic rotation

### Audit Logging (Planned)

All authenticated API calls will be logged with:

- Timestamp
- Key ID used
- Action performed
- Source IP
- Request/response status
