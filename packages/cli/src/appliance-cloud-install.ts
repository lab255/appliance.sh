#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { createApplianceClient } from '@appliance.sh/sdk';
import {
  createAwsCloudInstallDependencies,
  defaultSourceImage,
  runCloudInstall,
  type CloudInstallProfile,
  type ImageArchitecture,
} from '@appliance.sh/install-aws';
import { readProfiles, upsertProfile } from './utils/profile-store.js';

const program = new Command();

program
  .description('install the Appliance control plane in AWS with CloudFormation')
  .option('--name <name>', 'installation name', 'appliance')
  .option('--stack-name <name>', 'CloudFormation stack name')
  .option('--region <region>', 'AWS region', process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1')
  .option('--aws-profile <name>', 'AWS credential profile')
  .option('--profile-name <name>', 'Appliance credential profile name')
  .option('--image <reference>', 'source image in public GHCR or this account ECR', defaultSourceImage())
  .option('--arch <architecture>', 'image architecture: amd64 (default) or arm64', 'amd64')
  .action(async (options: CloudInstallCommandOptions) => {
    if (!/^[a-z][a-z0-9-]{2,31}$/.test(options.name)) {
      throw new Error('--name must be 3-32 lowercase letters, digits, or dashes and start with a letter');
    }
    if (options.arch !== 'amd64' && options.arch !== 'arm64') throw new Error('--arch must be amd64 or arm64');
    const architecture: ImageArchitecture = options.arch === 'amd64' ? 'x86_64' : 'arm64';
    const stackName = options.stackName ?? `appliance-${options.name}`;
    const profileName = options.profileName ?? options.name;
    const existing = readProfiles().profiles[profileName];
    if (
      existing &&
      existing.installGeneration !== 'cloudformation-v1' &&
      (existing.stateBackendUrl || existing.lastBootstrapInput)
    ) {
      throw new Error(
        `Profile ${profileName} belongs to a legacy Pulumi bootstrap install. Refusing to overlay a CloudFormation install; no automatic migration is supported.`
      );
    }
    const existingProfile =
      existing?.installGeneration === 'cloudformation-v1' &&
      existing.cloudFormationStackName &&
      existing.awsAccountId &&
      existing.awsRegion
        ? ({ ...existing } as CloudInstallProfile)
        : undefined;

    console.log(chalk.bold(`Installing Appliance ${options.name} in ${options.region}`));
    const deps = createAwsCloudInstallDependencies({
      region: options.region,
      awsProfile: options.awsProfile,
      log: (message) => console.log(chalk.dim(`  ${message}`)),
      validateExistingProfile: async (profile) => {
        const result = await createApplianceClient({
          baseUrl: profile.apiUrl,
          credentials: { keyId: profile.keyId, secret: profile.secret },
          product: 'cli',
        }).whoami();
        return result.success;
      },
      writeProfile: (name, profile) => {
        upsertProfile(name, { ...profile, managed: 'cli' }, { makeActive: true });
      },
    });
    const profile = await runCloudInstall(
      {
        installationName: options.name,
        stackName,
        region: options.region,
        architecture,
        sourceImage: options.image,
        awsProfile: options.awsProfile,
        profileName,
        existingProfile,
        existingLegacyProfile: Boolean(
          existing &&
            existing.installGeneration !== 'cloudformation-v1' &&
            (existing.stateBackendUrl || existing.lastBootstrapInput)
        ),
      },
      deps
    );
    console.log(chalk.green(`✓ Installed. Profile ${profileName} points to ${profile.apiUrl}`));
    console.log(chalk.dim('  Next: deploy the typed edge target to attach https://api.<domain>.'));
  });

interface CloudInstallCommandOptions {
  name: string;
  stackName?: string;
  region: string;
  awsProfile?: string;
  profileName?: string;
  image: string;
  arch: string;
}

program.parse(process.argv);
