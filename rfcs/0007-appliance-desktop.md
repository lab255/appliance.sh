# RFC 0007: Appliance Desktop

- **Status:** Partially implemented — the dev-runtime + agents desktop shipped; the app-store catalog is future work
- **Created:** 2026-03-04

## Summary

Appliance Desktop is a native desktop shell that lets anyone install, run, and manage appliances -- both locally on their own machine and remotely on cloud-hosted Appliance installations. Think of it as a cross between **Docker Desktop** (which hosts and manages container runtimes) and **Tauri** (which lets developers build and distribute applications of any sort as native desktop experiences). It is the "app store" for Appliance.

## Motivation

The CLI is designed for developers. But Appliance aims to make software accessible to everyone -- not just people comfortable with a terminal. Consider these users:

- A small business owner who wants to run an invoicing tool on their laptop
- A team lead who needs to access a staging environment without learning `curl`
- A designer who wants to preview a deployed application without asking a developer to send them a URL
- A sysadmin who manages multiple Appliance installations across regions
- A developer who wants to build a desktop-distributed app without learning Electron

These users need a point-and-click experience that hides infrastructure complexity entirely. And developers need a runtime that can host their applications on end-user machines without requiring those users to install Docker, Node.js, Python, or anything else.

## What Appliance Desktop Is

Appliance Desktop is a **desktop shell** -- a native application (macOS, Windows, Linux) that plays two roles:

1. **For end users:** An app store and runtime. Install appliances, click "Start", use them. No terminal, no Docker, no configuration.
2. **For developers:** A distribution target. Build an appliance, publish it, and users can install it on their machine through Desktop -- regardless of whether the appliance is a container, a framework app, or a native binary.

Like Docker Desktop, it manages runtimes behind the scenes -- containers, processes, networking, storage. Like Tauri, it provides the bridge between web/native applications and the desktop OS, with system tray integration, native notifications, window management, and auto-updates.

Unlike Docker Desktop, the user never sees containers, images, or volumes. Unlike Tauri, the developer doesn't need to learn a new framework -- any appliance manifest works.

```
┌─────────────────────────────────────────────────────────────┐
│  Appliance Desktop                                     _ □ x│
├──────────┬──────────────────────────────────────────────────┤
│          │                                                  │
│  Local   │  My Appliances                                   │
│          │                                                  │
│  ● Notes │  ┌─────────┐  ┌─────────┐  ┌─────────┐         │
│  ● Wiki  │  │  Notes  │  │  Wiki   │  │ Invoices│         │
│  ○ Redis │  │         │  │         │  │         │         │
│          │  │ Running │  │ Running │  │ Stopped │         │
│ ──────── │  └─────────┘  └─────────┘  └─────────┘         │
│          │                                                  │
│  Cloud   │  ┌─────────┐  ┌─────────┐                      │
│  (prod)  │  │ Billing │  │  CRM    │                      │
│          │  │  API    │  │         │                      │
│  ● Billing│  │Deployed │  │Deployed │                      │
│  ● CRM   │  └─────────┘  └─────────┘                      │
│          │                                                  │
│ ──────── │                                                  │
│          │                                                  │
│ + Install│  [Install New Appliance]                         │
│          │                                                  │
└──────────┴──────────────────────────────────────────────────┘
```

### Three Roles

**App launcher and runtime:** Desktop is to appliances what the JRE is to Java apps, or what Electron is to Electron apps -- but universal. If a user has Appliance Desktop installed, they can run _any_ appliance, regardless of what it's built with. Developers target "Appliance" as their runtime, and Desktop handles the rest: process management, networking, storage, updates. Users double-click an `.appliance` file or click "Install" in the catalog, and the app just runs.

This is the core insight: **Appliance Desktop is a universal application runtime for the desktop.** It can run:

- A Node.js web app (framework image) -- Desktop runs `npm start` and opens the browser
- A Docker-based service (container image) -- Desktop manages the container lifecycle
- A native binary (binary image) -- Desktop launches the process and manages its lifecycle
- A multi-service application (appliance stack) -- Desktop orchestrates all the pieces together

The developer doesn't ship an Electron binary, a Docker Compose file, or an installer. They ship an `appliance.json` manifest, and any machine with Desktop installed can run it.

**Local app store:** Browse, install, and manage appliances locally. No cloud account needed. No terminal needed. Click "Install", click "Start".

**Cloud dashboard:** Connect to one or more remote Appliance installations. Browse deployed applications, view their status, open them in a browser, and perform basic management (start, stop, redeploy) -- all through the GUI.

### Comparison to Existing Runtimes

| Runtime               | What it runs      | Developer must                    | User must install     |
| --------------------- | ----------------- | --------------------------------- | --------------------- |
| JRE                   | Java apps         | Target JVM                        | JRE                   |
| Electron              | Electron apps     | Bundle Chromium + Node.js per app | Nothing (bundled)     |
| Docker Desktop        | Containers        | Write Dockerfile                  | Docker Desktop        |
| **Appliance Desktop** | **Any appliance** | **Write appliance.json**          | **Appliance Desktop** |

The advantage over Electron: developers don't bundle a 200MB runtime per app. The advantage over JRE: not limited to one language. The advantage over Docker Desktop: users never see containers.

### File Association

Desktop registers `.appliance` as a file type on the OS. Double-clicking an `.appliance` file (which is just a renamed `appliance.json`) installs and launches the appliance. Developers can distribute their app as a single file:

```
my-app.appliance    →  double-click  →  Appliance Desktop installs and starts it
```

For more complex appliances (with assets, binaries, etc.), the distribution format is an `.appliance.zip` archive containing the manifest and all required files.

## Local Appliance Management

### Installing Appliances Locally

Users browse or search a catalog of available appliances and click "Install". Under the hood:

1. Desktop downloads the appliance manifest and build artifacts
2. Pulls or builds the required container image
3. Stores the appliance configuration in `~/Appliance/` (or platform equivalent)
4. The appliance appears in the sidebar as "Stopped"

```
┌──────────────────────────────────────────┐
│  Install Appliance                       │
│                                          │
│  🔍 Search appliances...                 │
│                                          │
│  ┌──────────────────────────────────┐    │
│  │ Baserow           ★ 4.8         │    │
│  │ Open-source Airtable alternative │    │
│  │                     [Install]    │    │
│  ├──────────────────────────────────┤    │
│  │ Plausible          ★ 4.9        │    │
│  │ Privacy-friendly analytics       │    │
│  │                     [Install]    │    │
│  ├──────────────────────────────────┤    │
│  │ Gitea              ★ 4.7        │    │
│  │ Self-hosted Git service          │    │
│  │                     [Install]    │    │
│  └──────────────────────────────────┘    │
│                                          │
└──────────────────────────────────────────┘
```

### Running Appliances Locally

Click "Start" on an installed appliance. Desktop:

1. Starts the container (or process) in the background
2. Waits for the health check to pass
3. Assigns a local URL (e.g., `http://notes.appliance.local:7200`)
4. Updates the sidebar indicator to "Running" (green dot)
5. Optionally opens the appliance in the user's default browser

Click "Stop" to shut it down. Click "Open" to visit it in the browser. Click "Uninstall" to remove it and clean up its data (with confirmation).

### Data Persistence

Local appliance data is stored in `~/Appliance/data/<appliance-name>/`. This directory persists across start/stop cycles. Uninstalling prompts the user to keep or delete their data.

### Local Runtime

Appliance Desktop is a **universal runtime** -- it can host any appliance regardless of image format (see [RFC 0008](./0008-manifest-v2.md)). The runtime strategy depends on the image format:

| Image Format | Runtime Strategy                                | User Sees                |
| ------------ | ----------------------------------------------- | ------------------------ |
| `container`  | Managed container via bundled engine            | Nothing -- it just works |
| `framework`  | Built-in process runner (Node.js, Python, etc.) | Nothing -- it just works |
| `binary`     | Direct native process execution                 | Nothing -- it just works |
| `zip`        | Unpack + framework-appropriate runner           | Nothing -- it just works |

The key insight from Docker Desktop: users don't care how things run. They care that they run. The key insight from Tauri: developers don't want to learn a new framework to distribute their app. They want to describe what they built and have the platform figure out the rest.

**Runtime architecture:**

```
┌──────────────────────────────────────────────┐
│  Appliance Desktop Runtime                   │
│                                              │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Process Mgr  │  │ Container Engine     │  │
│  │              │  │ (bundled, lightweight)│  │
│  │ - binary     │  │                      │  │
│  │ - framework  │  │ - OCI containers     │  │
│  │ - zip        │  │ - Volume management  │  │
│  └──────┬───────┘  └──────────┬───────────┘  │
│         │                     │              │
│  ┌──────┴─────────────────────┴───────────┐  │
│  │ Networking Layer                       │  │
│  │ - Port allocation & mapping            │  │
│  │ - Local DNS (*.appliance.local)        │  │
│  │ - Health checking                      │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Storage Layer                          │  │
│  │ - ~/Appliance/data/<name>/             │  │
│  │ - Automatic backup on uninstall        │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**Container engine options:**

| Approach                                  | Pros                                 | Cons                  |
| ----------------------------------------- | ------------------------------------ | --------------------- |
| Bundle a minimal OCI runtime              | No external deps, full control       | Build complexity      |
| Detect Docker/Podman, fallback to bundled | Leverage existing installs           | Inconsistent behavior |
| Use Lima (macOS) / WSL (Windows)          | Lightweight VMs for Linux containers | OS-specific           |

**Recommended approach:** Bundle a minimal container runtime that Desktop manages entirely. The user never interacts with it. If Docker or Podman is already installed, Desktop can optionally use it, but it should never _require_ it. For `framework` and `binary` image formats, Desktop runs processes directly -- no container overhead.

## Cloud Connection

### Connecting to an Installation

Users add cloud connections by entering the server URL and credentials:

```
┌────────────────────────────────────────┐
│  Connect to Cloud                      │
│                                        │
│  Server URL:                           │
│  ┌────────────────────────────────┐    │
│  │ https://api.appliance.sh       │    │
│  └────────────────────────────────┘    │
│                                        │
│  Access Key ID:                        │
│  ┌────────────────────────────────┐    │
│  │ ak_abc123                      │    │
│  └────────────────────────────────┘    │
│                                        │
│  Secret Access Key:                    │
│  ┌────────────────────────────────┐    │
│  │ ••••••••••••••••               │    │
│  └────────────────────────────────┘    │
│                                        │
│           [Test Connection]  [Save]    │
│                                        │
└────────────────────────────────────────┘
```

Or, a developer can generate an **invite link** from the CLI:

```bash
appliance invite --env production --expires 24h
# → https://appliance.sh/join/abc123
```

The non-technical user pastes this link into Desktop, which auto-configures the connection.

### Browsing Cloud Appliances

Once connected, Desktop lists the projects and environments on that installation. The user sees:

- Which appliances are deployed
- Their current status (deployed, deploying, failed)
- The live URL for each environment
- Basic health/uptime information

### Cloud Actions

Non-technical users can perform safe actions through the GUI:

| Action      | Description                         | Requires confirmation |
| ----------- | ----------------------------------- | --------------------- |
| Open        | Open the appliance URL in a browser | No                    |
| View status | See deployment status and health    | No                    |
| Restart     | Redeploy the current version        | Yes                   |
| View logs   | See recent application logs         | No                    |

Destructive actions (destroy, delete, configuration changes) are not exposed in Desktop. Those require the CLI or API.

### Multiple Connections

Desktop supports connecting to multiple Appliance installations simultaneously. Each appears as a separate section in the sidebar:

```
Local
  ● Notes
  ● Wiki

Cloud (Production)
  ● Billing API
  ● Marketing Site

Cloud (Staging)
  ● Billing API (staging)
  ○ New Feature (failed)
```

## Architecture

### Technology

| Component       | Choice                                                       | Rationale                                      |
| --------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| Shell framework | Electron or Tauri                                            | Cross-platform native desktop apps             |
| UI              | React or Svelte                                              | Component-based, fast rendering                |
| Local runtime   | Docker/Podman (containers), direct process (framework/other) | Flexible, covers all appliance types           |
| API client      | `@appliance.sh/sdk`                                          | Reuse existing SDK with HTTP message signing   |
| Local state     | SQLite                                                       | Lightweight, no server needed                  |
| Auto-update     | Electron autoUpdater / Tauri updater                         | Keep Desktop current without user intervention |

### Package Structure

Appliance Desktop would be a new package in the monorepo:

```
packages/
  desktop/
    src/
      main/             # Electron/Tauri main process
        runtime/         # Local container/process management
        connections/     # Cloud connection management
        store/           # SQLite local state
      renderer/          # UI components
        views/
          appliances/    # Appliance grid/list
          install/       # Install catalog
          connect/       # Cloud connection setup
          settings/      # Preferences
        components/      # Shared UI components
      preload/           # Secure bridge between main and renderer
    resources/           # Icons, assets
    electron-builder.yml # Packaging config
```

### Communication Between Main and Renderer

```
┌──────────────────────────────┐
│  Renderer (UI)               │
│  - React/Svelte components   │
│  - Displays appliance state  │
│  - User interactions         │
│          │  IPC              │
├──────────┼───────────────────┤
│  Main Process                │
│  - Container runtime mgmt   │
│  - ApplianceClient (SDK)     │
│  - SQLite state              │
│  - File system access        │
│  - System tray               │
└──────────────────────────────┘
```

The renderer never talks to Docker or the cloud directly. All actions go through IPC to the main process, which manages the runtime and API connections.

## Local-to-Cloud Continuum

A key design goal: an appliance running locally can be deployed to the cloud without friction, and vice versa.

### Promote Local to Cloud

A user has been running an invoicing app locally. Their business grows and they want their team to access it:

1. Click "Deploy to Cloud" on the local appliance
2. Select (or create) a cloud connection
3. Desktop uses the SDK to create a project, environment, and deployment
4. The same appliance is now running in the cloud with a public URL
5. Local instance can be kept running or stopped

### Pull Cloud to Local

A developer deployed an app to staging. A designer wants to run it locally for testing:

1. Browse the cloud connection's appliances
2. Click "Run Locally" on the staging app
3. Desktop downloads the appliance manifest and artifacts
4. Starts it locally with the same configuration
5. Designer can test without affecting the shared environment

## System Tray

When minimized, Desktop lives in the system tray (macOS menu bar, Windows system tray, Linux notification area). The tray menu shows:

```
● Notes (running)
● Wiki (running)
○ Invoices (stopped)
──────────────
Start All
Stop All
──────────────
Open Appliance Desktop
Quit
```

Local appliances continue running when the window is closed (until the user explicitly stops them or quits Desktop entirely).

## Appliance Catalog

### Where Appliances Come From

The install catalog can pull from multiple sources:

1. **Official catalog** -- Curated appliances hosted at `registry.appliance.sh` (planned)
2. **Cloud installation** -- Appliances available on a connected cloud installation
3. **Local file** -- An `appliance.json` file on disk (for developers testing locally)
4. **URL** -- Direct link to an appliance manifest

### Catalog Entry

Each catalog entry includes:

```json
{
  "name": "baserow",
  "displayName": "Baserow",
  "description": "Open-source Airtable alternative for creating databases without code",
  "version": "1.24.0",
  "icon": "https://registry.appliance.sh/icons/baserow.png",
  "category": "productivity",
  "tags": ["database", "spreadsheet", "no-code"],
  "manifest": {
    "manifest": "v1",
    "type": "container",
    "name": "baserow",
    "port": 80
  },
  "requirements": {
    "runtime": "container",
    "memory": "2GB",
    "storage": "1GB"
  }
}
```

## User Experience Principles

1. **No jargon** -- The UI says "Install", "Start", "Stop", "Open" -- not "deploy", "provision", "container", "environment"
2. **No configuration required** -- Sensible defaults for everything. Advanced settings exist but are hidden behind a "gear" icon
3. **Status is always visible** -- Green dot = running, gray dot = stopped, red dot = error. No ambiguity
4. **Errors are actionable** -- "Notes failed to start. [View Details] [Try Again] [Get Help]" -- not stack traces
5. **Offline-capable** -- Local appliances work without internet. Cloud features degrade gracefully when offline
6. **Respect the platform** -- Native window chrome, native notifications, system tray integration, dark mode support, keyboard shortcuts follow OS conventions

## Security Considerations

- Cloud credentials are stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) -- not in plain files
- Local appliances run in containers with limited permissions (no host network, no privileged mode)
- Auto-updates are signed and verified
- The renderer process has no direct access to the file system, network, or container runtime -- all access goes through the main process IPC bridge

## Relationship to Other Components

| Component                  | Relationship                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `@appliance.sh/sdk`        | Desktop uses the SDK's `ApplianceClient` for all cloud communication                 |
| `@appliance.sh/cli`        | Desktop and CLI are peers -- both talk to the same API, neither depends on the other |
| `@appliance.sh/api-server` | Desktop connects to api-server instances as a client                                 |
| Appliance manifest         | Desktop reads and interprets `appliance.json` to run appliances locally              |

## Open Questions

1. **Electron vs Tauri?** Electron is more mature and has a larger ecosystem. Tauri produces smaller binaries and uses the system webview. Tauri aligns better with the "lightweight" philosophy.
2. **Container runtime bundling?** Shipping a container runtime increases the download size significantly. Could start with framework/other types only and add container support as an optional install.
3. **Catalog hosting?** An official registry (`registry.appliance.sh`) requires infrastructure, curation, and trust. Could start with cloud-installation-only catalog and add the public registry later.
4. **Monetization?** Desktop could be free for local use and require a subscription for cloud connections, or free entirely with cloud subscriptions handled at the installation level.
