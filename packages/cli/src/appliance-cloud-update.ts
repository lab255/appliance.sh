#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { createAwsCloudInstallDependencies, defaultSourceImage, runCloudSystemUpdate } from '@appliance.sh/install-aws';
import { getActiveProfileOverride } from './utils/credentials.js';
import { resolveProfileSecret } from './utils/credential-store.js';
import { readProfiles, resolveProfile } from './utils/profile-store.js';

const program = new Command();
program
  .description('update CFN-owned system api-server and worker Lambdas')
  .option('--image <reference>', 'public GHCR or same-account ECR image', defaultSourceImage())
  .option('--arch <architecture>', 'amd64 or arm64')
  .option('--aws-profile <name>', 'AWS credential profile')
  .action(async (options: { image: string; arch?: string; awsProfile?: string }) => {
    const resolved = resolveProfile(readProfiles(), { override: getActiveProfileOverride() });
    if (!resolved) throw new Error('No active Appliance profile');
    const profile = resolved.profile;
    if (profile.installGeneration !== 'cloudformation-v1')
      throw new Error('Legacy Pulumi installs must use the deprecated legacy api-server update path');
    if (!profile.cloudFormationStackName || !profile.awsAccountId || !profile.awsRegion)
      throw new Error('CFN profile is missing stack/account/region metadata');
    if (profile.stateBackendUrl || profile.lastBootstrapInput)
      throw new Error('Profile mixes legacy and CFN ownership metadata; refusing update');
    if (options.arch && options.arch !== 'amd64' && options.arch !== 'arm64')
      throw new Error('--arch must be amd64 or arm64');
    const secret = resolveProfileSecret(resolved.name, profile);
    const deps = createAwsCloudInstallDependencies({
      region: profile.awsRegion,
      awsProfile: options.awsProfile,
      writeProfile: () => undefined,
      log: (message) => console.log(chalk.dim(message)),
    });
    await runCloudSystemUpdate(
      {
        profile: { ...profile, keyId: secret.keyId, secret: secret.secret } as never,
        installationName: resolved.name,
        sourceImage: options.image,
        architecture: options.arch === 'arm64' ? 'arm64' : options.arch === 'amd64' ? 'x86_64' : undefined,
        awsProfile: options.awsProfile,
      },
      deps
    );
    console.log(chalk.green('System update complete. Both Lambdas now use the shared CFN ImageUri.'));
  });
program.parse(process.argv);
