#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import chalk from 'chalk';
import { createApplianceClient } from '@appliance.sh/sdk';
import {
  createAwsCloudInstallDependencies,
  defaultSourceImage,
  runCloudRouteUpdate,
  runCloudSystemUpdate,
} from '@appliance.sh/install-aws';
import { getActiveProfileOverride } from './utils/credentials.js';
import { resolveProfileSecret } from './utils/credential-store.js';
import { readProfiles, resolveProfile } from './utils/profile-store.js';
import { resolveReleaseEvidence } from './utils/release-evidence.js';
import { phaseMessage, terminalFailureMessage } from './utils/cloud-update-output.js';

interface Options {
  version?: string;
  image?: string;
  local: boolean;
  follow?: string;
  json: boolean;
  arch?: string;
  awsProfile?: string;
}

const program = new Command();
program
  .description('update the Appliance control plane through its signed in-server self-update route')
  .option('--version <version>', 'signed release version (default: latest semver release)')
  .option('--follow <jobId>', 'follow an existing self-update job without starting a new one')
  .option('--local', 'break glass: mirror and update CloudFormation from this operator machine', false)
  .option('--image <reference>', 'source image for --local only')
  .option('--arch <architecture>', 'amd64 or arm64 for --local')
  .option('--aws-profile <name>', 'AWS credential profile for --local')
  .option('--json', 'print the terminal job including per-phase durations as JSON', false)
  .action(run);

async function run(options: Options): Promise<void> {
  if (options.local && options.follow) throw new Error('--follow cannot be combined with --local');
  if (options.local && options.version)
    throw new Error('--version selects signed route evidence; use --image with --local');
  if (!options.local && options.image)
    throw new Error('--image is a --local break-glass option; use --version for self-update');
  if (!options.local && options.arch) throw new Error('--arch is a --local break-glass option');
  if (!options.local && options.awsProfile) throw new Error('--aws-profile is a --local break-glass option');
  if (options.follow && options.version) throw new Error('--follow cannot be combined with --version');
  if (options.arch && options.arch !== 'amd64' && options.arch !== 'arm64') {
    throw new Error('--arch must be amd64 or arm64');
  }

  const resolved = resolveProfile(readProfiles(), { override: getActiveProfileOverride() });
  if (!resolved) throw new Error('No active Appliance profile');
  const profile = resolved.profile;
  if (profile.installGeneration !== 'cloudformation-v1') {
    throw new Error('Legacy Pulumi installs must use the deprecated legacy api-server update path');
  }
  if (!profile.cloudFormationStackName || !profile.awsAccountId || !profile.awsRegion) {
    throw new Error('CFN profile is missing stack/account/region metadata');
  }
  if (profile.stateBackendUrl || profile.lastBootstrapInput) {
    throw new Error('Profile mixes legacy and CFN ownership metadata; refusing update');
  }
  const secret = resolveProfileSecret(resolved.name, profile);
  const lifecycleProfile = { ...profile, keyId: secret.keyId, secret: secret.secret } as never;

  if (options.local) {
    const deps = createAwsCloudInstallDependencies({
      region: profile.awsRegion,
      awsProfile: options.awsProfile,
      writeProfile: () => undefined,
      log: (message) => console.log(chalk.dim(message)),
    });
    await runCloudSystemUpdate(
      {
        profile: lifecycleProfile,
        installationName: resolved.name,
        sourceImage: options.image ?? defaultSourceImage(),
        architecture: options.arch === 'arm64' ? 'arm64' : options.arch === 'amd64' ? 'x86_64' : undefined,
        awsProfile: options.awsProfile,
      },
      deps
    );
    console.log(chalk.green('Local break-glass update complete. Both Lambdas now use the shared CFN ImageUri.'));
    return;
  }

  const client = createApplianceClient({
    baseUrl: profile.apiUrl,
    credentials: { keyId: secret.keyId, secret: secret.secret },
    product: 'cli',
    timeout: 30_000,
  });
  const evidence = options.follow ? undefined : await resolveReleaseEvidence({ version: options.version });
  const result = await runCloudRouteUpdate(
    {
      ...(options.follow ? { followJobId: options.follow } : {}),
      ...(evidence
        ? {
            targetDigest: evidence.targetDigest,
            release: evidence.release,
            idempotencyKey: `cloud-update-${randomUUID()}`,
          }
        : {}),
      onPhase: options.json ? undefined : (job) => console.log(chalk.dim(phaseMessage(job))),
    },
    client
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.outcome === 'terminal' && result.job.status === 'failed') process.exitCode = 1;
    return;
  }
  if (result.outcome === 'conflict') {
    console.log(chalk.yellow(`A self-update is already running: ${result.start.statusUrl}`));
    console.log(chalk.yellow(`Follow it with: appliance cloud update --follow ${result.start.jobId}`));
    return;
  }
  if (result.job.status === 'succeeded') {
    console.log(
      chalk.green(
        `System update complete: ${result.previousServerVersion ?? 'unknown'} → ${result.currentServerVersion ?? result.job.target.version}.`
      )
    );
    return;
  }
  throw new Error(terminalFailureMessage(result.job));
}

program.parse(process.argv);
