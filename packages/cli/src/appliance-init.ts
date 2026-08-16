import { Command } from 'commander';
import { confirm, input, password } from '@inquirer/prompts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplianceClient } from '@appliance.sh/sdk';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';
import { saveCredentials } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { DEFAULT_PROFILE_NAME } from './utils/profile-store.js';
import { runFixes, runPreflight } from './utils/preflight.js';
import type { CheckResult, FixOutcome, PreflightReport } from './utils/preflight.js';
import { DEFAULT_VM_NAME, profileForVm, resolveVmBinary, runUp } from './utils/microvm-up.js';
import { printCliError } from './utils/errors.js';
import chalk from 'chalk';

// `appliance init` — one command from nothing to a reachable runtime.
//
// Bare `appliance init` runs LOCAL microVM onboarding (the default):
//   doctor preflight + safe auto-fixes  →  boot the default microVM and
//   reach core sandbox readiness (the shared runUp)  →  guide the first
//   deploy, which lazily provisions the cluster and local profile.
//
// The historical remote/cloud (BYO api-server) credential setup is
// preserved behind `appliance init --remote <url>` (and `appliance
// login` for plain credential entry). Local-first: cloud provisioning
// stays `appliance bootstrap`; `init` does not subsume it.

ensureHelperBinOnPath();

const program = new Command();

attachProfileOption(program);

program
  .description('one command from nothing to a reachable runtime: boot the local microVM and guide your first deploy')
  .option(
    '--remote <url>',
    'set up credentials for a remote/cloud api-server instead of booting the local microVM runtime'
  )
  .option('--name <name>', 'microVM to boot (local onboarding)', DEFAULT_VM_NAME)
  .option('--no-deploy', 'skip the first-deploy hand-off (local onboarding)')
  .option('-y, --yes', 'skip interactive prompts (CI/non-TTY safe)', false)
  .option('--timeout <seconds>', 'seconds to wait for the platform to be ready', '900')
  .action(
    async (opts: {
      profile?: string;
      remote?: string;
      name: string;
      deploy: boolean;
      yes: boolean;
      timeout: string;
    }) => {
      // `--remote <url>` selects the legacy cloud/BYO credential flow;
      // bare `init` is local microVM onboarding.
      if (opts.remote !== undefined) {
        await runRemoteInit(opts.remote, opts.profile);
        return;
      }
      await runLocalInit({
        name: opts.name,
        deploy: opts.deploy,
        yes: opts.yes,
        timeout: Number.parseInt(opts.timeout, 10),
        profile: opts.profile,
      });
    }
  );

program.parse(process.argv);

// ---- local microVM onboarding ------------------------------------------

interface LocalInitOptions {
  name: string;
  deploy: boolean;
  yes: boolean;
  timeout: number;
  profile?: string;
}

async function runLocalInit(opts: LocalInitOptions): Promise<void> {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  // `--profile` only steers the remote/cloud credential flow; local
  // onboarding always adopts the microVM's own profile, so a passed
  // `--profile` is a no-op here — say so rather than silently ignore it.
  if (opts.profile !== undefined) {
    console.log(
      chalk.dim(
        `Note: --profile is ignored in local onboarding — the microVM owns the ${profileForVm(opts.name)} profile.`
      )
    );
  }

  // 1. Preflight + safe auto-fixes (pull api-server image for the host
  //    arch, start a stopped colima, install missing helper binaries).
  console.log(chalk.bold('Appliance doctor — fixing what’s safe…'));
  let report = await runPreflight();
  printChecklist(report);
  const fixes = await runFixes(report);
  printFixes(fixes);
  if (fixes.some((f) => f.status === 'fixed')) {
    // Re-run so the gate below reflects the post-fix state.
    report = await runPreflight();
  }

  // 2. Fail-fast on any hard failure auto-fix couldn't clear — BEFORE we
  //    prompt to sign or touch the VM, so signing is only ever offered
  //    once bring-up will actually proceed.
  if (!report.ok) {
    console.log();
    console.error(
      chalk.red('Preflight has unresolved failures — fix the items marked → above, then re-run `appliance init`.')
    );
    process.exit(1);
  }

  // 3. macOS dev-binary signing — PROMPTED, not blind. A published
  //    binary is already signed (no-op); only a repo build is unsigned.
  await maybeSignDevBinary({ yes: opts.yes, isTTY });

  // 4. Boot the core sandbox — the same runUp `appliance vm up` uses, with its
  //    closing deploy hint suppressed so the hand-off below is the single
  //    next command. Idempotent: re-running keeps existing credentials
  //    when they still authenticate.
  console.log();
  console.log(chalk.bold(`Starting microVM '${opts.name}'…`));
  try {
    await runUp(opts.name, undefined, opts.timeout, {}, { showDeployHint: false });
  } catch (err) {
    printCliError(err);
    process.exit(1);
  }

  // 5. Hand off into the first deploy.
  await handOff({ name: opts.name, deploy: opts.deploy, yes: opts.yes, isTTY });
}

function marker(status: CheckResult['status']): string {
  if (status === 'pass') return chalk.green('✓');
  if (status === 'warn') return chalk.yellow('!');
  return chalk.red('✗');
}

function printChecklist(report: PreflightReport): void {
  for (const r of report.results) {
    const detail = r.detail ? chalk.dim(` — ${r.detail}`) : '';
    console.log(`  ${marker(r.status)} ${r.label}${detail}`);
    // Only hard failures need their remediation up front; warnings are
    // non-blocking and stay quiet so the happy path reads cleanly.
    if (r.status === 'fail' && r.remediation) {
      console.log(`    ${chalk.cyan('→')} ${r.remediation}`);
    }
  }
}

function printFixes(fixes: FixOutcome[]): void {
  for (const f of fixes) {
    const tag =
      f.status === 'fixed'
        ? chalk.green('fixed  ')
        : f.status === 'failed'
          ? chalk.red('failed ')
          : chalk.yellow('skipped');
    console.log(`  ${tag} ${f.label} ${chalk.dim(`— ${f.detail}`)}`);
  }
}

/**
 * On macOS, booting a microVM needs the
 * `com.apple.security.virtualization` entitlement, which requires a code
 * signature. A published/installed binary already ships signed (no-op);
 * only a repo-built `appliance-vm` is unsigned. Signing forks a
 * trust/identity decision, so we PROMPT before running the dev signer
 * (and in CI / non-TTY / `-y` we only print the command, never sign
 * behind the user's back).
 */
async function maybeSignDevBinary(ctx: { yes: boolean; isTTY: boolean }): Promise<void> {
  if (process.platform !== 'darwin') return;
  const bin = resolveVmBinary();
  // A missing binary surfaces at runUp with build guidance — nothing to
  // sign here.
  if (!bin) return;
  // Only the repo build is unsigned; the installed/published binary ships
  // signed.
  if (!/packages\/vm\/target\/(?:debug|release)\/appliance-vm$/.test(bin)) return;
  if (hasVirtualizationEntitlement(bin)) return;
  // Derive the signer from the binary, not the cwd: `init` runs from the
  // user's app dir, so a cwd-relative resolve would silently miss the
  // repo build's sibling script. bin is .../packages/vm/target/<profile>/
  // appliance-vm → script is .../packages/vm/scripts/sign-dev.sh.
  const signScript = path.resolve(path.dirname(bin), '..', '..', 'scripts', 'sign-dev.sh');
  // Not in a repo checkout (or the script moved) — nothing we can run.
  if (!fs.existsSync(signScript)) return;
  const profileFlag = bin.includes('/release/') ? ['--release'] : [];
  const manualCmd = `bash ${signScript}${profileFlag.length ? ' --release' : ''}`;

  console.log();
  console.log(chalk.yellow('The local appliance-vm is a repo build and isn’t signed to boot a microVM.'));
  console.log(chalk.dim('  Booting needs the com.apple.security.virtualization entitlement (ad-hoc dev signature).'));

  if (ctx.yes || !ctx.isTTY) {
    console.log(chalk.dim(`  Sign it with: ${manualCmd}`));
    return;
  }
  const ok = await confirm({ message: 'Sign the dev appliance-vm binary now?', default: true });
  if (!ok) {
    console.log(chalk.dim(`  Skipped — boot may fail until you run: ${manualCmd}`));
    return;
  }
  const r = spawnSync('bash', [signScript, ...profileFlag], { stdio: 'inherit' });
  if (r.status === 0) {
    console.log(`${chalk.green('✓')} signed the dev appliance-vm binary`);
  } else {
    console.log(chalk.red(`signing failed — re-run manually: ${manualCmd}`));
  }
}

/** Whether the binary already carries the virtualization entitlement
 *  (i.e. it's signed for booting microVMs). `codesign -d --entitlements`
 *  dumps the entitlements; an unsigned binary prints nothing useful. */
function hasVirtualizationEntitlement(bin: string): boolean {
  const r = spawnSync('codesign', ['-d', '--entitlements', ':-', bin], { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return out.includes('com.apple.security.virtualization');
}

// ---- first-deploy hand-off ---------------------------------------------

/** A directory is deployable when `appliance deploy` has something to
 *  build from: an appliance manifest or a Dockerfile. */
function isDeployableDir(cwd: string): boolean {
  return ['appliance.json', 'appliance.ts', 'appliance.js', 'Dockerfile'].some((f) => fs.existsSync(path.join(cwd, f)));
}

/** A human label for the deploy target: the manifest `name` when a JSON
 *  manifest exposes one, else the directory basename. Best-effort and
 *  cosmetic — used only to make the deploy prompt concrete. */
function detectTargetName(cwd: string): string {
  try {
    const manifestPath = path.join(cwd, 'appliance.json');
    if (fs.existsSync(manifestPath)) {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
    }
  } catch {
    // Unreadable/invalid manifest — fall back to the basename.
  }
  return path.basename(cwd);
}

async function handOff(ctx: { name: string; deploy: boolean; yes: boolean; isTTY: boolean }): Promise<void> {
  // The deploy subprocess pins the VM's future profile explicitly; its
  // lazy cluster bring-up creates and activates that profile.
  const profile = profileForVm(ctx.name);
  const deployCmd = 'appliance deploy';
  const deployable = isDeployableDir(process.cwd());

  console.log();
  // Not a deployable directory: point at the exact next command.
  if (!deployable) {
    console.log(chalk.bold('Next — deploy your first app:'));
    console.log(`  ${chalk.cyan('→')} from your app's directory, run ${chalk.bold(deployCmd)}`);
    return;
  }

  // Deployable, but the offer is off (--no-deploy) or we can't prompt
  // (CI / non-TTY / -y): print-only, mirroring deploy's own non-TTY
  // discipline.
  if (!ctx.deploy || ctx.yes || !ctx.isTTY) {
    console.log(chalk.bold('Next — deploy this project:'));
    console.log(`  ${chalk.cyan('→')} ${chalk.bold(deployCmd)}`);
    return;
  }

  // Interactive + deployable: offer to run the first deploy now, naming
  // the target so the prompt is concrete.
  const go = await confirm({ message: `Deploy ${detectTargetName(process.cwd())} now?`, default: true });
  if (!go) {
    console.log(`  ${chalk.cyan('→')} when you're ready: ${chalk.bold(deployCmd)}`);
    return;
  }
  // Spawn `appliance deploy` so its banner + URL print verbatim.
  process.exit(spawnDeploy(profile));
}

/** Re-invoke this CLI's `deploy` subcommand as a subprocess so its
 *  output (build log, banner, live URL) prints exactly as a direct
 *  `appliance deploy` would. Works in both the single-binary build
 *  (process.execPath IS the appliance binary) and Node/dev (spawn the
 *  sibling dispatcher entry). */
function spawnDeploy(profile: string): number {
  const args = ['deploy', '--profile', profile];
  const moduleUrl = import.meta.url;
  const compiled = moduleUrl.includes('$bunfs') || moduleUrl.includes('~BUN');
  try {
    if (compiled) {
      const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
      return r.status ?? 1;
    }
    const entry = path.join(path.dirname(fileURLToPath(moduleUrl)), 'appliance.js');
    const r = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' });
    return r.status ?? 1;
  } catch {
    console.error(chalk.red('Could not launch deploy — run `appliance deploy` yourself.'));
    return 1;
  }
}

// ---- remote / cloud credential setup (legacy `init`) -------------------

/**
 * The historical interactive cloud / BYO-api-server credential flow,
 * now gated behind `--remote <url>`: check the server, bootstrap it (or
 * accept an existing API key), verify, and save the profile. `appliance
 * login` remains the lower-ceremony credential-entry path.
 */
async function runRemoteInit(apiUrl: string, profileOverride?: string): Promise<void> {
  // Profile to save credentials under. Picks up --profile / env /
  // active. Prompts only when nothing else has chosen a name, with
  // "default" as the default — matching the legacy single-profile UX.
  let profileName = profileOverride ?? process.env.APPLIANCE_PROFILE ?? null;
  if (!profileName) {
    profileName = await input({
      message: 'Profile name:',
      default: DEFAULT_PROFILE_NAME,
    });
  }

  const client = createApplianceClient({ baseUrl: apiUrl, product: 'cli' });

  // Check server connectivity and bootstrap status
  console.log(chalk.dim('Checking server status...'));
  const statusResult = await client.getBootstrapStatus();
  if (!statusResult.success) {
    console.error(chalk.red(`Server unreachable at ${apiUrl}: ${statusResult.error.message}`));
    process.exit(1);
  }

  let keyId: string;
  let secret: string;

  if (!statusResult.data.initialized) {
    // Bootstrap flow — server has no API keys yet
    console.log(chalk.yellow('Server is not initialized. Starting bootstrap flow.'));

    const token = await password({
      message: 'Bootstrap token:',
    });

    const keyName = await input({
      message: 'API key name:',
      default: 'cli',
    });

    const result = await client.bootstrap(token, keyName);
    if (!result.success) {
      console.error(chalk.red(`Bootstrap failed: ${result.error.message}`));
      process.exit(1);
    }

    keyId = result.data.id;
    secret = result.data.secret;
    console.log(chalk.green(`API key created: ${keyId}`));
  } else {
    // Existing key flow — server already initialized
    console.log(chalk.dim('Server is initialized. Enter your existing API key.'));

    keyId = await input({
      message: 'API key ID (ak_...):',
    });

    secret = await password({
      message: 'API key secret (sk_...):',
    });
  }

  // Verify credentials with a signed request
  const verifyClient = createApplianceClient({
    baseUrl: apiUrl,
    credentials: { keyId, secret },
    product: 'cli',
  });

  const testResult = await verifyClient.listProjects();
  if (!testResult.success) {
    console.error(chalk.red(`Credential verification failed: ${testResult.error.message}`));
    process.exit(1);
  }

  saveCredentials({ apiUrl, keyId, secret }, profileName);
  console.log(chalk.green(`Credentials saved to profile "${profileName}". You are now logged in.`));
}
