#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import {
  createAwsCloudInstallDependencies,
  runCloudBaselineUpdate,
  type SystemRoleMode,
} from '@appliance.sh/install-aws';
import { getActiveProfileOverride } from './utils/credentials.js';
import { resolveProfileSecret } from './utils/credential-store.js';
import { readProfiles, resolveProfile } from './utils/profile-store.js';

const program = new Command();
program
  .description('apply the current CloudFormation baseline while preserving the running ImageUri')
  .option('--system-role-mode <mode>', 'system Lambda role mode: scoped or admin', 'scoped')
  .option('--aws-profile <name>', 'AWS credential profile')
  .action(async (options: { systemRoleMode: string; awsProfile?: string }) => {
    if (options.systemRoleMode !== 'scoped' && options.systemRoleMode !== 'admin') {
      throw new Error('--system-role-mode must be scoped or admin');
    }
    const resolved = resolveProfile(readProfiles(), { override: getActiveProfileOverride() });
    if (!resolved) throw new Error('No active Appliance profile');
    const profile = resolved.profile;
    if (profile.installGeneration !== 'cloudformation-v1') {
      throw new Error('Legacy Pulumi installs do not support CloudFormation baseline updates');
    }
    if (!profile.cloudFormationStackName || !profile.awsAccountId || !profile.awsRegion) {
      throw new Error('CFN profile is missing stack/account/region metadata');
    }
    if (profile.stateBackendUrl || profile.lastBootstrapInput) {
      throw new Error('Profile mixes legacy and CFN ownership metadata; refusing update');
    }
    const secret = resolveProfileSecret(resolved.name, profile);
    const deps = createAwsCloudInstallDependencies({
      region: profile.awsRegion,
      awsProfile: options.awsProfile,
      writeProfile: () => undefined,
      log: (message) => console.log(chalk.dim(message)),
    });
    await runCloudBaselineUpdate(
      {
        profile: { ...profile, keyId: secret.keyId, secret: secret.secret } as never,
        installationName: resolved.name,
        systemRoleMode: options.systemRoleMode as SystemRoleMode,
      },
      deps
    );
    console.log(
      chalk.green(
        `Baseline update complete. System Lambda roles are in ${options.systemRoleMode} mode; ImageUri was preserved.`
      )
    );
  });
program.parse(process.argv);
