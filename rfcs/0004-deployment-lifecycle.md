# RFC 0004: Deployment Lifecycle

- **Status:** Draft
- **Created:** 2026-03-04

## Summary

This RFC describes the end-to-end lifecycle of a deployment in Appliance, from the developer running `appliance deploy` to the application serving traffic. It covers the state machine, async execution model, error handling, and rollback strategy.

## Deployment State Machine

### Environment States

```
                    deploy
  ┌─────────┐    ──────────→    ┌───────────┐    success    ┌──────────┐
  │ pending  │                  │ deploying  │ ────────────→ │ deployed │
  └─────────┘                  └───────────┘               └──────────┘
                                     │                          │
                                     │ failure                  │ destroy
                                     ▼                          ▼
                                ┌────────┐              ┌─────────────┐
                                │ failed │              │ destroying  │
                                └────────┘              └─────────────┘
                                     │                     │         │
                                     │ deploy (retry)      │         │
                                     ▼                     │         │
                                ┌───────────┐    success   │  failure │
                                │ deploying  │ ←───────────┘         │
                                └───────────┘                        │
                                                                     ▼
                                                              ┌──────────┐
                                                              │  failed  │
                                                              └──────────┘
                                                                     │
                                                                     │ destroy
                                                                     │ (retry)
                                                                     ▼
                                                              ┌─────────────┐
                                                              │ destroying  │
                                                              └─────────────┘
                                                                     │
                                                                     │ success
                                                                     ▼
                                                              ┌───────────┐
                                                              │ destroyed │
                                                              └───────────┘
```

### Deployment States

```
  ┌─────────┐     ┌─────────────┐     ┌───────────┐
  │ pending │ ──→ │ in_progress │ ──→ │ succeeded │
  └─────────┘     └─────────────┘     └───────────┘
                        │
                        │
                        ▼
                  ┌──────────┐
                  │  failed  │
                  └──────────┘
```

A deployment also tracks:

- `idempotentNoop: boolean` -- true if no infrastructure changes were needed
- `message: string` -- human-readable status or error description

## Execution Flow

### 1. Initiation

```
POST /api/v1/deployments
{
  "environmentId": "env-abc123",
  "action": "deploy"
}
```

The API server:

1. Validates the environment exists and is in a deployable state
2. Creates a deployment record with `status: pending`
3. Transitions the deployment to `status: in_progress`
4. Updates the environment to `status: deploying`
5. Invokes the infrastructure layer

### 2. Infrastructure Execution

The `DeploymentService` calls `ApplianceDeploymentService`, which uses Pulumi's Automation API:

1. Creates or selects the Pulumi stack (named `{projectId}-{environmentId}`)
2. Sets stack configuration (region, base config, etc.)
3. Runs `pulumi up` (deploy) or `pulumi destroy` (destroy)
4. Captures the result: resources created/updated/deleted, outputs, errors

### 3. Completion

On success:

- Deployment transitions to `status: succeeded`
- Environment transitions to `status: deployed` (or `destroyed` for destroy actions)
- `completedAt` timestamp is recorded
- If no changes were needed, `idempotentNoop: true`

On failure:

- Deployment transitions to `status: failed`
- Environment transitions to `status: failed`
- Error message captured in `deployment.message`

### 4. Client Polling

The CLI polls `GET /api/v1/deployments/:id` until a terminal state is reached:

```
pending → in_progress → succeeded
                      → failed
```

Polling interval: start at 1s, back off to 5s, with a configurable timeout.

## Idempotency

Deployments are idempotent. Deploying the same application to the same environment with no changes results in `idempotentNoop: true`. The infrastructure layer (Pulumi) computes a diff and only applies changes when necessary.

This means developers can safely run `appliance deploy` repeatedly without side effects.

## Error Handling

### Transient Failures

Cloud API rate limits, temporary network issues, or eventual consistency delays. Pulumi handles retries for most transient failures internally.

### Infrastructure Failures

Resource creation fails (e.g., IAM policy limit reached, region capacity). The deployment fails, but Pulumi's state tracks what was partially created. A subsequent deploy attempt will reconcile.

### Application Failures

The application deploys but doesn't start correctly (e.g., crash loop, bad config). The deployment succeeds (infrastructure was provisioned) but the application may be unhealthy. Future work: health checks as part of the deployment.

## Rollback Strategy

### Current Approach

Rollback is achieved by redeploying a previous version. Since Appliance tracks the application manifest and the infrastructure is declarative, deploying a known-good version converges the infrastructure to the desired state.

### Future: Automatic Rollback

Planned enhancement:

1. Deploy new version
2. Run health checks against the new deployment
3. If health checks fail, automatically redeploy the previous version
4. Mark the deployment as `rolled_back` with a reference to the rollback deployment

## Concurrent Deployments

Only one deployment can be active per environment at a time. If a deployment is `in_progress` for an environment, subsequent deployment requests are rejected with a `409 Conflict` status.

## Deployment History

All deployments are persisted and queryable. This provides:

- Audit trail of who deployed what and when
- Ability to correlate issues with specific deployments
- Input for automatic rollback decisions

## Future Considerations

### Blue/Green Deployments

Provision a parallel environment, switch traffic atomically, then tear down the old one. This requires CDN-level traffic management in the base.

### Canary Deployments

Route a percentage of traffic to the new version. Requires weighted routing at the CDN or load balancer level.

### Preview Environments

Ephemeral environments created per pull request. Create on PR open, destroy on PR merge/close. Requires CI/CD integration (GitHub Actions, etc.).

### Deployment Hooks

User-defined scripts that run at specific points in the lifecycle:

```json
{
  "scripts": {
    "predeploy": "npm run migrate",
    "postdeploy": "npm run seed",
    "predestroy": "npm run backup"
  }
}
```
