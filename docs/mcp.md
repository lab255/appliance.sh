# The Appliance MCP server

`appliance mcp` serves Appliance's deploy/debug surface over the [Model Context Protocol](https://modelcontextprotocol.io) on stdio, so any MCP-capable agent — Claude Code, GitHub Copilot, OpenAI Codex, or your own tooling — can deploy applications and diagnose failures without screen-scraping the human-facing CLI output.

## Registering the server

Claude Code:

```bash
claude mcp add appliance -- appliance mcp
```

Generic MCP client configuration:

```json
{
  "mcpServers": {
    "appliance": { "command": "appliance", "args": ["mcp"] }
  }
}
```

Pass `--profile <name>` after `mcp` to pin the default credential profile; every tool also accepts a per-call `profile` argument.

## Tools

| Tool                | What it does                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overview`          | The "where am I" call: credential profiles (no secrets), api-server reachability, every project/environment with status and the latest deployed URL. Agents start here.         |
| `deploy`            | Deploy the app in a directory — or the whole stack when it carries an `appliance.stack.json`. Uploads source, builds server-side, waits for a terminal status, returns the URL. |
| `deployment_status` | Fetch one deployment record by id (status, message, timing, URL).                                                                                                               |
| `health`            | Live workload health: healthy/degraded/unhealthy, replica readiness, restart counts, and per-pod failure reasons (`CrashLoopBackOff`, `ImagePullBackOff`, …).                   |
| `logs`              | Recent container logs per pod, fetched through the api-server (local VM + BYO Kubernetes bases).                                                                                |
| `destroy`           | Tear down an environment's workload. Requires `confirm: true`.                                                                                                                  |
| `doctor`            | The `appliance doctor` diagnostics as structured JSON: host preflight + runtime findings, each with a remediation. Read-only.                                                   |
| `vm`                | Local VM lifecycle: `status`, `up` (first boot can take minutes), `stop`.                                                                                                       |

## Design notes

- **Everything flows through the api-server SDK client** where an API exists, so a tool behaves identically against the local microVM and a cloud installation — the same base-URL contract the web console uses. Logs and health ride the `/api/v1/workloads`, `/api/v1/pods/:pod/logs`, and environment-health endpoints rather than shelling out to `kubectl`, so the agent's machine needs nothing beyond the `appliance` binary.
- **Results are compact JSON** (or labeled plain text for logs) — no ANSI, no progress lines.
- **Errors carry remediations.** Tool failures return `isError` results with the same remediation hints the CLI prints (`Not logged in — run \`appliance login\`…`), so an agent can self-correct instead of stalling.
- **stdout is protected.** The stdio channel is the JSON-RPC transport; the server rebinds `process.stdout` to stderr before any reused CLI helper can print, and hands the transport a private handle to the real stdout. Chatty helpers land in the client's server-log view instead of corrupting frames.
- **Deploys serialize.** `deploy`/`destroy` calls run through a mutex — stack deploys switch the process working directory per member, so they must never interleave.
- **VM lifecycle self-invokes.** The `vm` tool re-runs this same `appliance` executable (`appliance vm up|stop|status`) as a child and returns the combined output, because the engine helpers are written to print + exit rather than throw — the MCP process must outlive any one failed call.

## Trying it without an agent

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"overview","arguments":{}}}' \
  | appliance mcp
```
