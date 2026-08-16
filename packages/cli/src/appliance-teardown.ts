#!/usr/bin/env node

import * as os from 'node:os';
import * as path from 'node:path';
import { Command, Option } from 'commander';
import * as prompts from '@inquirer/prompts';
import chalk from 'chalk';
import { runTeardown, type BootstrapEvent } from '@appliance.sh/bootstrap';
import { createAwsCloudLifecycleDependencies, runCloudTeardown } from '@appliance.sh/install-aws';
import { getActiveProfileOverride } from './utils/credentials.js';
import { resolveProfileSecret } from './utils/keychain.js';
import { readProfiles, resolveProfile } from './utils/profile-store.js';

const program = new Command();

program
  .description('destroy a cloud installation using its recorded ownership generation')
  .option('--cache-dir <dir>', 'override ~/.appliance cache directory (legacy only)')
  .option('--aws-profile <name>', 'AWS profile to authenticate with')
  .addOption(new Option('--profile <name>', 'deprecated alias for --aws-profile').hideHelp())
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (options: { cacheDir?: string; awsProfile?: string; profile?: string; yes?: boolean }) => {
    if (options.profile) console.error(chalk.yellow('--profile here is deprecated — use --aws-profile.'));
    const awsProfile = options.awsProfile ?? options.profile;
    const resolved = resolveProfile(readProfiles(), { override: getActiveProfileOverride() });
    const profile = resolved?.profile;
    const isCloudFormation = profile?.installGeneration === 'cloudformation-v1';

    if (!options.yes) {
      console.log(
        chalk.yellow(
          isCloudFormation
            ? '\n⚠  This destroys the endpoint edge first, then deletes the CloudFormation substrate. State/data buckets and ECR are retained.'
            : '\n⚠  This runs the deprecated legacy Pulumi teardown. User appliance stacks are not destroyed.'
        )
      );
      if (!(await prompts.confirm({ message: 'Proceed with teardown?', default: false }))) return;
    }

    try {
      if (isCloudFormation) {
        if (!resolved || !profile.cloudFormationStackName || !profile.awsAccountId || !profile.awsRegion)
          throw new Error('CFN profile is missing stack/account/region metadata');
        if (profile.stateBackendUrl || profile.lastBootstrapInput)
          throw new Error('Profile mixes legacy bootstrap metadata with cloudformation-v1; refusing teardown');
        const secret = resolveProfileSecret(resolved.name, profile);
        const deps = createAwsCloudLifecycleDependencies({
          region: profile.awsRegion,
          awsProfile,
          log: (message) => console.log(chalk.dim(message)),
        });
        const result = await runCloudTeardown(
          { ...profile, keyId: secret.keyId, secret: secret.secret } as never,
          deps
        );
        console.log(chalk.green('\nCloudFormation teardown complete. Retained resources:'));
        for (const item of result.retained) console.log(`  ${item.kind}: ${item.value}`);
        console.log(
          chalk.yellow(
            'Delete these manually with AWS tooling only when you no longer need their data or rollback history.'
          )
        );
      } else {
        if (profile?.installGeneration)
          throw new Error(`Unknown install generation ${profile.installGeneration}; refusing legacy teardown`);
        console.log(
          chalk.yellow(
            `\n${'deprecated: legacy 3-phase bootstrap; new installs use appliance cloud install (CloudFormation). Supported for 2 releases.'}`
          )
        );
        const secret = resolved && profile ? resolveProfileSecret(resolved.name, profile) : undefined;
        await runTeardown({
          cacheDir: options.cacheDir ?? path.join(os.homedir(), '.appliance'),
          awsProfile,
          ...(profile && secret
            ? { cluster: { apiServerUrl: profile.apiUrl, apiKey: { id: secret.keyId, secret: secret.secret } } }
            : {}),
          emit: renderEvent,
        });
        console.log(chalk.green('\nLegacy teardown complete'));
      }
    } catch (error) {
      console.error(chalk.red('\nTeardown failed:'), error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

function renderEvent(event: BootstrapEvent): void {
  if (event.type === 'log')
    console.log(event.level === 'warn' ? chalk.yellow(event.message) : chalk.dim(event.message));
  if (event.type === 'resource' && event.op !== 'same')
    console.log(`  ${event.op} ${event.resourceType} ${event.name}`);
}

program.parse(process.argv);
