#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import chalk from 'chalk';
import { createApplianceClient, SelfUpdateStartError } from '@appliance.sh/sdk';
import { resolveReleaseEvidence, SELF_UPDATE_DISABLED_AP226 } from '@appliance.sh/bootstrap';
import {
  createAwsCloudInstallDependencies,
  defaultSourceImage,
  runCloudRouteUpdate,
  runCloudSystemUpdate,
} from '@appliance.sh/install-aws';
import { getActiveProfileOverride } from './utils/credentials.js';
import { resolveProfileSecret } from './utils/credential-store.js';
import { readProfiles, resolveProfile } from './utils/profile-store.js';
import {
  cloudUpdateJson,
  cloudUpdateExitCode,
  createPhaseLineFormatter,
  terminalFailureMessage,
} from './utils/cloud-update-output.js';

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
  if (options.local && options.json) throw new Error('--local has no job record; omit --json');
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
  const formatPhaseLines = createPhaseLineFormatter();
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
      onPhase: options.json
        ? undefined
        : (job) => {
            for (const line of formatPhaseLines(job)) console.log(chalk.cyan(line));
          },
    },
    client
  );

  if (options.json) {
    process.stdout.write(`${cloudUpdateJson(result)}\n`);
    process.exitCode = cloudUpdateExitCode(result);
    return;
  }
  if (result.outcome === 'conflict') {
    console.log(chalk.yellow(`A self-update is already running: ${result.start.statusUrl}`));
    console.log(chalk.yellow(`Follow it with: appliance cloud update --follow ${result.start.jobId}`));
    process.exitCode = cloudUpdateExitCode(result);
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
  if (result.job.recovered) {
    console.log(
      chalk.yellow(
        `Update rolled back — v${result.previousServerVersion ?? 'unknown'} is serving and healthy after the target failed.`
      )
    );
    process.exitCode = 1;
    return;
  }
  throw new Error(terminalFailureMessage(result.job));
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(chalk.red(userFacingError(error)));
  if (!process.exitCode) process.exitCode = 1;
});

function userFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === SELF_UPDATE_DISABLED_AP226 ||
    (error instanceof SelfUpdateStartError && error.code === 'trust-not-provisioned')
  ) {
    return 'Self-update is disabled until the production release key is pinned — use appliance cloud update --local as the break-glass path until then.';
  }
  return message;
}
