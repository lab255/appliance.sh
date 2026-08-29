import { Command } from 'commander';
import { createApplianceClient, DeploymentStatus } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { readLink } from './utils/link.js';
import { extractDeploymentUrl } from './utils/deploy-poll.js';
import { printCliError } from './utils/errors.js';
import { openExternalUrl } from './utils/open-external-url.js';
import chalk from 'chalk';

const program = new Command();

attachProfileOption(program);

program
  .description('open the latest deployment URL in a browser')
  .argument('[project]', 'project name (defaults to the linked project)')
  .argument('[environment]', 'environment name (defaults to the linked environment)')
  .option('--print', 'print the URL instead of opening it', false)
  .action(async (cliProject: string | undefined, cliEnvironment: string | undefined) => {
    const opts = program.opts<{ print: boolean }>();
    const credentials = loadCredentials();
    if (!credentials) {
      console.error(chalk.red('Not logged in. Run `appliance login` first.'));
      process.exit(1);
    }

    const link = readLink();
    const projectName = cliProject ?? link?.projectName;
    const environmentName = cliEnvironment ?? link?.environmentName;
    if (!projectName || !environmentName) {
      console.error(
        chalk.red(
          'No target. Pass `<project> <environment>` or run `appliance setup` / `appliance link` to link this folder.'
        )
      );
      process.exit(1);
    }

    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
      product: 'cli',
    });

    try {
      // Resolve env → list deployments (newest first) → scan for a
      // URL in the message. Caps at 10 to avoid scanning the whole
      // history for old environments.
      const projects = await client.listProjects();
      if (!projects.success) throw new Error(`listProjects: ${projects.error.message}`);
      const project = projects.data.find((p) => p.name === projectName);
      if (!project) throw new Error(`Project "${projectName}" not found.`);

      const envs = await client.listEnvironments(project.id);
      if (!envs.success) throw new Error(`listEnvironments: ${envs.error.message}`);
      const env = envs.data.find((e) => e.name === environmentName);
      if (!env) throw new Error(`Environment "${projectName}/${environmentName}" not found.`);

      // env.url is the canonical address. For environments that
      // predate the field (or where the executor never plumbed one,
      // e.g. cloud deploys today), fall back to scanning the latest
      // successful deployment's message.
      let url = env.url ?? null;
      if (!url) {
        const deployments = await client.listDeployments({ environmentId: env.id, limit: 10 });
        if (!deployments.success) throw new Error(`listDeployments: ${deployments.error.message}`);

        const succeededDeploys = deployments.data.filter(
          (d) => d.action === 'deploy' && d.status === DeploymentStatus.Succeeded
        );
        const latest = succeededDeploys[0];
        if (!latest) {
          console.error(chalk.red(`No successful deployments yet for ${projectName}/${environmentName}.`));
          process.exit(1);
        }

        url = extractDeploymentUrl(latest.message);
        if (!url) {
          console.error(chalk.red(`No URL recorded for ${projectName}/${environmentName}.`));
          console.error(
            chalk.dim(
              '  Cloud deployments do not yet surface their endpoint URL. ' +
                'Check the Appliance Console or the upstream Pulumi outputs.'
            )
          );
          if (latest.message) console.error(chalk.dim(`  message: ${latest.message}`));
          process.exit(1);
        }
      }

      if (opts.print) {
        console.log(url);
        return;
      }

      console.log(chalk.dim(`Opening ${url}`));
      openExternalUrl(url);
    } catch (error) {
      printCliError(error, { apiUrl: credentials.apiUrl });
    }
  });

program.parse(process.argv);
