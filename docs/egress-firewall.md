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
`boundary` as the stable scalar. The sibling
`enforcement {backend, bypassable, scope}` object describes the effective
backend capability; policy fields are never re-nested under `policy`.

## Windows (WSL backend)

WSL VMs use `netLink: "nat"`, and `appliance vm egress policy` reports
`boundary: "cooperative"` plus
`enforcement:
{"backend":"wsl","bypassable":true,"scope":["http","https","per-app"]}`
and an `apps` block containing each Runtime app's exact host and TCP-port
grants.
Never interpret this as a host-enforced boundary.

Runtime defaults to strict mode:

```sh
appliance vm egress wsl-mode strict
appliance vm egress wsl-mode cooperative
```

Strict refuses Runtime apps whose manifests request any egress grant. Apps
without egress grants may run; the WSL guest chain drops their outbound
traffic. Cooperative is an explicit opt-in: Runtime tasks receive the VM proxy
and CA environment plus a per-start proxy credential. Credential-bearing
requests select only that app's host-and-port policy; stopped, uninstalled, and
VM-deleted apps lose the credential. Runtime proxy requests without a valid app
credential receive `407 Proxy Authentication Required`; there is no VM-wide
union fallback. Cooperative mode is bypassable: an app can ignore the proxy and
use direct TCP, UDP other than DNS, or raw IP. DNS must go through the proxy
using CONNECT by hostname; direct UDP 53 is dropped. `egress list` states the
bypass limitation in its header and shows per-app rows without exposing
credentials.

The per-VM value is persisted as `wslMode` in `vm.json`. New VMs capture the
optional global default from `~/.appliance/settings.json`:

```json
{ "wslMode": "strict" }
```

Missing or invalid values resolve to strict. Changing the global value never
silently widens an existing VM.

For a blocked request, inspect recent denials and allow only the required host:

```sh
appliance vm egress denied --tail 50
appliance vm egress allow api.example.com
```

`appliance vm egress sync` publishes the current development-VM policy to its
cluster workloads.

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
injection rules are separate from packaged-app inspection. Brokered credential
injection is disabled on WSL v1 because exact-lease attribution cannot survive
Runtime SNAT.

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
