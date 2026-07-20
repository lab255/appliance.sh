import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createApplianceClient, DeploymentStatus } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { registerManifestOptions } from './utils/common.js';
import { DEFAULT_BUILD_OUTPUT, isPrintedError, runDeploy } from './utils/deploy-core.js';
import { printCliError } from './utils/errors.js';
import chalk from 'chalk';

// Thin commander wrapper around the shared deploy engine in
// utils/deploy-core.ts. In a stack folder (appliance.stack.json) a
// bare `appliance deploy` fans out over every member — one deploy
// command for single apps and multi-service applications alike.

const program = new Command();

attachProfileOption(program);

/** Bare `appliance deploy` in a stack folder deploys the whole stack.
 *  Any explicit target/build flag opts back into single-app mode. */
async function maybeDeployStack(opts: {
  cliProject?: string;
  build: string;
  imageUri?: string;
  envFile?: string;
  file?: string;
}): Promise<boolean> {
  const { STACK_FILENAME, loadStack, resolveStackApps } = await import('./utils/stack.js');
  // `file` carries the manifest default ('appliance.json') — only an
  // explicit override opts out of stack detection.
  if (opts.cliProject || opts.imageUri || opts.envFile || (opts.file && opts.file !== 'appliance.json')) return false;
  if (opts.build !== DEFAULT_BUILD_OUTPUT) return false;
  if (!fs.existsSync(path.join(process.cwd(), STACK_FILENAME))) return false;

  const { deployStackApps, printSummary, requireClient } = await import('./utils/stack-deploy.js');
  const loaded = loadStack(undefined);
  const apps = resolveStackApps(loaded, undefined);
  console.log(
    chalk.dim(`${STACK_FILENAME} found — deploying the whole stack (${apps.length} apps). `) +
      chalk.dim('Target one app by running deploy from its folder.')
  );
  const { client, apiUrl } = requireClient();
  const result = await deployStackApps({ client, apiUrl, apps });
  printSummary(result.rows);
  process.exit(result.failed ? 1 : 0);
}

registerManifestOptions(program)
  .description('deploy the linked (or named) project/environment — or the whole stack in a stack folder')
  .argument('[project]', 'project name (defaults to the linked project, then to the manifest `name`)')
  .argument('[environment]', 'environment name (defaults to the linked environment)')
  .option('-a, --build <path>', 'appliance.zip build to deploy', DEFAULT_BUILD_OUTPUT)
  .option(
    '--image-uri <uri>',
    'reference an already-published image (e.g. ghcr.io/org/app:tag) instead of uploading a build'
  )
  .option('-e, --env-file <path>', 'env file with runtime environment variables')
  .option('-y, --yes', 'skip interactive prompts; fail when input would be needed', false)
  .action(async (cliProject: string | undefined, cliEnvironment: string | undefined) => {
    const opts = program.opts<{
      build: string;
      imageUri?: string;
      envFile?: string;
      file?: string;
      directory?: string;
      variant?: string;
      yes: boolean;
    }>();

    if (opts.imageUri && opts.build !== DEFAULT_BUILD_OUTPUT) {
      console.error(chalk.red('Provide either --image-uri or --build, not both.'));
      process.exit(1);
    }

    await maybeDeployStack({
      cliProject,
      build: opts.build,
      imageUri: opts.imageUri,
      envFile: opts.envFile,
      file: opts.file,
    });

    const credentials = loadCredentials();
    if (!credentials) {
      console.error(chalk.red('Not logged in — no credentials for the active profile.'));
      console.error(
        chalk.dim(
          'Run `appliance login` to authenticate, or start the local runtime with `appliance vm up` ' +
            '(which saves a profile for you). `appliance whoami` shows the active profile; `appliance doctor` checks the host prerequisites.'
        )
      );
      process.exit(1);
    }

    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
      product: 'cli',
    });

    // Ctrl+C only stops WATCHING: the deploy already dispatched and
    // keeps running server-side. Say so, so nobody thinks the abort
    // rolled anything back (and knows where to pick it back up).
    process.on('SIGINT', () => {
      console.error();
      console.error(
        chalk.yellow('Stopped watching — the deployment continues server-side. Check it with `appliance status`.')
      );
      process.exit(130);
    });

    try {
      const outcome = await runDeploy({
        client,
        apiUrl: credentials.apiUrl,
        program,
        cliProject,
        cliEnvironment,
        opts: { build: opts.build, imageUri: opts.imageUri, envFile: opts.envFile, yes: opts.yes },
      });

      if (outcome.deployment.status !== DeploymentStatus.Succeeded) {
        process.exit(1);
      }
    } catch (error) {
      if (isPrintedError(error)) process.exit(1);
      printCliError(error, { apiUrl: credentials.apiUrl });
      process.exit(process.exitCode ?? 1);
    }
  });

program.parse(process.argv);
