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
  .option('--system-role-mode <mode>', 'system Lambda role mode: scoped or admin')
  .option('-y, --yes', 'confirm the AdministratorAccess break-glass mode', false)
  .option('--aws-profile <name>', 'AWS credential profile')
  .action(async (options: { systemRoleMode?: string; yes: boolean; awsProfile?: string }) => {
    if (options.systemRoleMode && options.systemRoleMode !== 'scoped' && options.systemRoleMode !== 'admin') {
      throw new Error('--system-role-mode must be scoped or admin');
    }
    if (options.systemRoleMode === 'admin') {
      console.error(chalk.red.bold('WARNING: AdministratorAccess break-glass mode requested.'));
      console.error(chalk.yellow('Both system Lambda execution roles will regain account-wide administrator access.'));
      console.error(chalk.yellow('Restore with: appliance cloud baseline-update --system-role-mode scoped'));
      if (!options.yes) throw new Error('Refusing AdministratorAccess without --yes confirmation');
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
    const updated = await runCloudBaselineUpdate(
      {
        profile: { ...profile, keyId: secret.keyId, secret: secret.secret } as never,
        installationName: resolved.name,
        systemRoleMode: options.systemRoleMode as SystemRoleMode | undefined,
      },
      deps
    );
    const resultingMode = updated.parameters.SystemRoleMode === 'admin' ? 'admin' : 'scoped';
    console.log(
      chalk.green(`Baseline update complete. System Lambda roles are in ${resultingMode} mode; ImageUri was preserved.`)
    );
    if (resultingMode === 'admin') {
      console.error(chalk.yellow('Restore with: appliance cloud baseline-update --system-role-mode scoped'));
    }
  });
program.parse(process.argv);
