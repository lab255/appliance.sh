# Egress controls

Appliance routes Netstack-VM outbound traffic through a host-enforced network
boundary. These VMs use default-deny policy: a connection is forwarded only
when its destination host and port are allowed. DNS answers for private,
link-local, loopback, and host-LAN addresses are rejected, and unclassified or
unsupported traffic is dropped. The WSL boundary on Windows is cooperative,
as described below.

Packaged apps use separate per-app policies. See the [runtime guide](runtime.md)
for running and managing packaged apps.

## View and change a VM policy

Commands default to the `appliance` VM. Use `--name <vm>` for another managed
VM.

```sh
appliance vm egress policy
appliance vm egress list
appliance vm egress default deny
appliance vm egress allow api.example.com
appliance vm egress deny uploads.example.com
appliance vm egress remove uploads.example.com
appliance vm egress reset
```

`policy` prints the effective JSON policy. `list` separates built-in and
operator rules. Host rules match the named host and its subdomains; a deny rule
wins over an allow rule. `remove` deletes one exact operator rule, while `reset`
clears all operator rules.

The policy JSON contract keeps policy fields flattened at the top level, with
`boundary` as the stable scalar. Future work may add a sibling
`enforcement {backend, bypassable, scope}` object; it will never re-nest the
policy fields under `policy`.

## Windows (WSL backend)

WSL VMs use `netLink: "nat"`, and `appliance vm egress policy` reports
`boundary: "cooperative"`. Their rules are enforced by the WSL proxy, not by a
host-owned network route, so software in the guest can bypass the proxy. The F4
flip does not change Windows: WSL VMs stay `nat` and their proxy default stays
`allow` until you run `appliance vm egress default deny`, which is still
cooperative. Here, F4 refers to the Netstack-default rollout for supported
non-WSL backends.

For a blocked request, inspect recent denials and allow only the required host:

```sh
appliance vm egress denied --tail 50
appliance vm egress allow api.example.com
```

`appliance vm egress sync` publishes the current development-VM policy to its
cluster workloads.

Windows agent credentials remain host-global in Credential Manager and are
resolved by the absolute argv `appliance agent print-key --type <agent>` path;
default generated rules use `capture:false`. Per-VM broker rules remain
ACL-reset files. Explicit capture writes a cleartext header to
`egress-secrets.json`, retaining backup, same-user, Administrator/SYSTEM, and
WSL file-access residuals. [`creds.rs`](../packages/vm/src/creds.rs) covers the
argv, ACL, capture, and no-capture paths. The managed distro disables drive
automount and Windows interop in [`wsl.rs`](../packages/vm/src/backend/wsl.rs),
but that does not constrain other distros or same-user Windows execution.

## TLS inspection

TLS inspection lets the host record request metadata after destination policy
allows the connection, without persisting secrets or bodies.

```sh
appliance vm egress mitm on
appliance vm egress mitm off
appliance vm egress ca
appliance vm egress gateway
```

`ca` prints the generated CA certificate path. `gateway` prints the
`HTTPS_PROXY` and CA values used by guest workloads. Credential capture and
injection rules are separate from packaged-app inspection.

## Development-VM traffic log

Print recent traffic events or the blocked-host summary:

```sh
appliance vm egress log --tail 100
appliance vm egress denied --tail 100
```

The JSONL log is stored under the VM state directory as
`egress-events.jsonl`. Each event contains the decision available at that point:

```json
{
  "ts": 1787875200000,
  "host": "api.example.com",
  "port": 443,
  "method": "GET",
  "path": "/v1/items",
  "decision": "mitm",
  "transport": "tcp"
}
```

`decision` is `allow`, `deny`, or `mitm`. Blind tunnels normally record
`CONNECT` without a path; inspected HTTPS and plain HTTP can record the request
method and sanitized path.

## Packaged-app policy

A manifest v2 app declares outbound hosts and TCP ports under
`network.egress`:

```json
{
  "network": {
    "egress": [{ "host": "api.example.com", "ports": [443] }]
  }
}
```

Hosts must be lowercase DNS names, optionally beginning with `*.`, and cannot
be IP literals or public suffixes. The runtime converts accepted grants into a
default-deny policy for the app's stable runtime principal. An undeclared host,
an ungranted control, a missing policy, or an unknown principal fails closed.
Compound services share the root app's principal and egress declaration;
service-level egress declarations are rejected.

Only manifest ports marked `expose: "host"` are published. For compound apps,
the port must also be `primary: true`. Published ports and egress grants are
independent.

## Packaged-app inspection log

Each app has a separate bounded log at
`~/.appliance/runtime/<app>/egress-events.jsonl`. It is maintained as a
newest-records 512 KiB ring. App records use this schema, with fields omitted
when they are unavailable:

```json
{
  "ts": 1787875200000,
  "app": "notes-suite",
  "service": "api",
  "principal": "notes-suite",
  "decision": "mitm",
  "host": "api.example.com",
  "port": 443,
  "transport": "tcp",
  "sni": "api.example.com",
  "tlsVersion": "TLSv1.3",
  "method": "POST",
  "path": "/v1/items",
  "status": 200,
  "bytesIn": 245,
  "bytesOut": 918,
  "durationMs": 84
}
```

Paths have query strings and fragments removed. Headers, cookies,
authorization values, query values, and request or response bodies are never
persisted. Inspection observes one request and response per connection and does
not capture or inject credentials for packaged apps.
