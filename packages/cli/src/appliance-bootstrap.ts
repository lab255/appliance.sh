#!/usr/bin/env node

import { Command, Option } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as prompts from '@inquirer/prompts';
import * as slug from 'random-word-slugs';
import chalk from 'chalk';
import { runBootstrap, type BootstrapEvent, type BootstrapPhase } from '@appliance.sh/bootstrap';
import { ApplianceBaseType, type ApplianceBaseConfigInput } from '@appliance.sh/sdk';
import { getActiveProfileOverride } from './utils/credentials.js';
import { readProfiles, resolveProfile } from './utils/profile-store.js';

const COMMON_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
];

const ALL_PHASES: BootstrapPhase[] = ['phase1', 'phase2', 'phase3'];

const program = new Command();

console.error(
  chalk.yellow(
    'deprecated: legacy 3-phase bootstrap; new installs use appliance cloud install (CloudFormation). Supported for 2 releases.'
  )
);

program
  .option('--name <name>', 'base name (e.g. my-cluster)')
  .option('--region <region>', 'AWS region')
  .option('--domain <domain>', 'domain name for the installation')
  .option('--create-zone', 'create a new Route53 zone for the domain')
  .option('--attach-zone', 'attach an existing Route53 zone')
  .option(
    '--phases <phases>',
    `comma-separated phases to run (${ALL_PHASES.join(',')} or 'all'); default runs the full installation`,
    'all'
  )
  .option('--cache-dir <dir>', 'override ~/.appliance cache directory')
  .option(
    '--image-uri <uri>',
    'override the default api-server image (default: `ghcr.io/appliance-sh/api-server:<version>`)'
  )
  .option('--aws-profile <name>', 'AWS profile to authenticate with (overrides shell env credentials)')
  .addOption(new Option('--profile <name>', 'deprecated alias for --aws-profile').hideHelp())
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(
    async (options: {
      name?: string;
      region?: string;
      domain?: string;
      createZone?: boolean;
      attachZone?: boolean;
      phases: string;
      cacheDir?: string;
      imageUri?: string;
      awsProfile?: string;
      profile?: string;
      yes?: boolean;
    }) => {
      const active = resolveProfile(readProfiles(), { override: getActiveProfileOverride() });
      if (active?.profile.installGeneration === 'cloudformation-v1') {
        throw new Error(
          `Active profile ${active.name} is a CloudFormation install. Refusing to run the legacy three-phase bootstrap against it.`
        );
      }
      // Fail fast on a missing Pulumi CLI — every phase shells out to it,
      // so an actionable pointer beats an ENOENT halfway through.
      ensurePulumiCli();

      // `--profile` collides with the credential-profile meaning every
      // other command uses; `--aws-profile` is the documented flag.
      if (options.profile) {
        console.error(chalk.yellow('--profile here means the AWS profile and is deprecated — use --aws-profile.'));
      }
      const awsProfile = options.awsProfile ?? options.profile;

      const name =
        options.name ??
        (await prompts.input({
          message: 'Base name:',
          default: slug.generateSlug(2, { format: 'kebab' }),
          validate: (v) => /^[a-z][a-z0-9-]*$/.test(v) || 'lowercase letters, digits, and dashes only',
        }));

      const region =
        options.region ??
        (await prompts.select({
          message: 'AWS region:',
          choices: COMMON_REGIONS.map((r) => ({ value: r, name: r })),
          default: 'us-east-1',
        }));

      const domain =
        options.domain ??
        (await prompts.input({
          message: 'Domain name:',
          validate: (v) => v.includes('.') || 'must be a valid domain (e.g. example.com)',
        }));

      let createZone: boolean;
      let attachZone: boolean;
      if (options.createZone !== undefined || options.attachZone !== undefined) {
        createZone = options.createZone ?? false;
        attachZone = options.attachZone ?? !createZone;
      } else {
        createZone = await prompts.confirm({
          message: `Create a new Route53 zone for ${domain}?`,
          default: true,
        });
        attachZone = !createZone;
      }

      const baseConfig: ApplianceBaseConfigInput = {
        type: ApplianceBaseType.ApplianceAwsPublic,
        name,
        region,
        dns: { domainName: domain, createZone, attachZone },
      };

      const phases = parsePhases(options.phases);

      // --image-uri is optional. When absent, phase 2 falls back to
      // the pinned `ghcr.io/appliance-sh/api-server:<version>` default
      // baked into @appliance.sh/bootstrap.
      const imageUri = options.imageUri;

      if (!options.yes) {
        console.log();
        console.log(chalk.bold('Bootstrap plan'));
        console.log(`  Base:    ${name}`);
        console.log(`  Region:  ${region}`);
        console.log(`  Domain:  ${domain}`);
        console.log(`  Zone:    ${createZone ? 'create new' : 'attach existing'}`);
        console.log(`  Phases:  ${phases.join(', ')}`);
        console.log(`  Image:   ${imageUri ?? '(default ghcr.io/appliance-sh/api-server)'}`);
        console.log(`  AWS:     ${awsCredentialsNote(awsProfile)}`);
        if (options.cacheDir) console.log(`  Cache:   ${options.cacheDir}`);
        console.log();
        const ok = await prompts.confirm({ message: 'Proceed?', default: true });
        if (!ok) {
          console.log(chalk.yellow('aborted'));
          process.exit(0);
        }
      }

      try {
        const result = await runBootstrap(
          {
            base: { name, config: baseConfig },
            apiServerImageUri: imageUri,
            aws: awsProfile ? { profile: awsProfile } : undefined,
          },
          {
            phases,
            cacheDir: options.cacheDir,
            onEvent: renderEvent,
          }
        );

        console.log();
        console.log(chalk.green('Bootstrap complete'));
        console.log(`  State backend:  ${result.stateBackendUrl}`);
        if (result.apiServerUrl) {
          console.log(`  API server:     ${result.apiServerUrl}`);
          console.log(`  Web console:    ${chalk.cyan(result.apiServerUrl)}  (open it in a browser)`);
        }
        if (result.apiKey) {
          console.log(`  API key id:     ${result.apiKey.id}`);
          console.log(chalk.yellow(`  API key secret: ${result.apiKey.secret}  (shown once; save it now)`));
        }
        console.log();
        console.log(chalk.bold('Next steps'));
        if (result.apiServerUrl) {
          console.log(
            `  Run ${chalk.cyan('appliance login')} with the API server URL${result.apiKey ? ' and the key above' : ''} to save a profile,`
          );
          console.log(
            `  then ${chalk.cyan('appliance setup')} in your app folder and ${chalk.cyan('appliance deploy')}.`
          );
          console.log(
            `  To onboard teammates, open the web console and use ${chalk.cyan('Settings → Invite teammate')} —`
          );
          console.log('  they get a link that signs them in with their own key, no secrets to paste.');
        } else {
          console.log(
            '  Phase 2 (hoist api-server) has not run yet — re-run with `--phases all` to finish the installation.'
          );
        }
      } catch (e) {
        console.error();
        const msg = e instanceof Error ? e.message : String(e);
        console.error(chalk.red('Bootstrap failed:'), msg);
        if (/ENOENT.*pulumi|pulumi.*ENOENT|spawn pulumi/i.test(msg)) {
          console.error(
            chalk.yellow('\nThe Pulumi CLI is not on PATH. Install it from https://www.pulumi.com/docs/install/')
          );
        }
        process.exit(1);
      }
    }
  );

/** Fail fast when the Pulumi CLI is missing — probe it before any
 *  prompting or provisioning work. */
function ensurePulumiCli(): void {
  const probe = spawnSync('pulumi', ['version'], { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) return;
  console.error(chalk.red('The Pulumi CLI is required to provision AWS infrastructure, but it was not found on PATH.'));
  console.error(
    chalk.dim('Install it from https://www.pulumi.com/docs/install/ (macOS: `brew install pulumi`), then re-run.')
  );
  process.exit(1);
}

/** Which AWS credentials phase 1 will authenticate with — the explicit
 *  --aws-profile, the AWS_PROFILE env var, or the default chain when
 *  ~/.aws credentials exist. Cosmetic; shown in the plan so the target
 *  account is visible before confirming. */
function awsCredentialsNote(awsProfile?: string): string {
  if (awsProfile) return `profile ${awsProfile}`;
  if (process.env.AWS_PROFILE) return `profile ${process.env.AWS_PROFILE} (from AWS_PROFILE)`;
  const awsDir = path.join(os.homedir(), '.aws');
  if (fs.existsSync(path.join(awsDir, 'credentials')) || fs.existsSync(path.join(awsDir, 'config'))) {
    return 'default profile (~/.aws)';
  }
  return '(shell env credentials)';
}

function parsePhases(raw: string): BootstrapPhase[] {
  const normalized = raw === 'all' ? ALL_PHASES.join(',') : raw;
  const parts = normalized
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (!ALL_PHASES.includes(p as BootstrapPhase)) {
      throw new Error(`unknown phase '${p}'. valid: ${ALL_PHASES.join(', ')}`);
    }
  }
  return parts as BootstrapPhase[];
}

function renderEvent(e: BootstrapEvent): void {
  switch (e.type) {
    case 'phase-started':
      console.log();
      console.log(chalk.bold.cyan(`▸ ${phaseLabel(e.phase)}`));
      break;
    case 'phase-completed':
      console.log(chalk.green(`✓ ${phaseLabel(e.phase)}`));
      break;
    case 'phase-failed':
      console.log(chalk.red(`✗ ${phaseLabel(e.phase)}: ${e.error}`));
      break;
    case 'phase-skipped':
      console.log(chalk.dim(`⚬ ${phaseLabel(e.phase)} skipped (${e.reason})`));
      break;
    case 'resource': {
      if (e.op === 'same') return;
      const glyph = e.op === 'create' ? '+' : e.op === 'delete' ? '-' : e.op === 'replace' ? '↻' : '·';
      const color =
        e.op === 'create' ? chalk.green : e.op === 'delete' ? chalk.red : e.op === 'replace' ? chalk.yellow : chalk.dim;
      console.log(`  ${color(glyph)} ${e.resourceType.padEnd(44)} ${e.name}`);
      break;
    }
    case 'log':
      if (e.level === 'warn') console.log(chalk.yellow(e.message));
      if (e.level === 'error') console.log(chalk.red(e.message));
      break;
  }
}

function phaseLabel(p: BootstrapPhase): string {
  switch (p) {
    case 'phase1':
      return 'Phase 1 — base infrastructure';
    case 'phase2':
      return 'Phase 2 — hoist api-server';
    case 'phase3':
      return 'Phase 3 — promote state to S3';
  }
}

program.parse(process.argv);
