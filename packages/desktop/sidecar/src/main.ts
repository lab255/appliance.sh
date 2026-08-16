import * as os from 'node:os';
import * as path from 'node:path';
import {
  latestGhcrTag,
  runApiServerUpdate,
  runBaselineUpdate,
  runStateDemotion,
  runStatePromotion,
  runTeardown,
  type ApiServerUpdateInput,
  type ApiServerUpdateOptions,
  type BaselineUpdateInput,
  type BaselineUpdateOptions,
  type BootstrapEvent,
  type BootstrapInput,
  type BootstrapOptions,
  type LatestGhcrTagInput,
  type StateDemotionInput,
  type StateDemotionOptions,
  type StatePromotionInput,
  type StatePromotionOptions,
} from '@appliance.sh/bootstrap';
import {
  createAwsCloudInstallDependencies,
  createAwsCloudLifecycleDependencies,
  runCloudBaselineUpdate,
  runCloudInstall,
  runCloudSystemUpdate,
  runCloudTeardown,
  type CloudLifecycleProfile,
} from '@appliance.sh/install-aws';
import { resolveInstallGeneration } from './generation.js';

// The Tauri side spawns this sidecar for any operation that needs the
// bootstrap package's local-machine capabilities (Pulumi automation,
// docker shell-out, AWS SDK with the operator's profile). Each
// invocation reads one JSON object from stdin and emits NDJSON on
// stdout: progress events, then a final `{type: "result", ...}` or
// `{type: "error", ...}` line. The Rust side forwards every
// non-result/non-error line to the frontend via a Tauri Channel.
//
// The `kind` discriminator lets one sidecar binary serve multiple
// operations (full bootstrap vs post-hoc state promotion). New
// operations land here as additional cases.
type SidecarInput =
  | {
      kind: 'bootstrap';
      bootstrapInput: BootstrapInput;
      options?: BootstrapOptions;
    }
  | {
      kind: 'promote-state';
      input: StatePromotionInput;
      options?: StatePromotionOptions;
    }
  | {
      kind: 'demote-state';
      input: StateDemotionInput;
      options?: StateDemotionOptions;
    }
  | {
      kind: 'update-api-server';
      input: ApiServerUpdateInput;
      options?: ApiServerUpdateOptions;
    }
  | {
      kind: 'update-baseline';
      input: BaselineUpdateInput;
      options?: BaselineUpdateOptions;
    }
  | {
      kind: 'latest-version';
      input?: LatestGhcrTagInput;
    }
  | {
      kind: 'teardown';
      // Teardown operates on the installer state in the cache dir, not
      // on a specific cluster record — the only knob is the AWS profile
      // to authenticate the destroy with. `cacheDir` defaults to
      // ~/.appliance (the desktop never overrides it).
      input?: {
        awsProfile?: string;
        cacheDir?: string;
        cluster?: {
          name: string;
          apiServerUrl: string;
          installGeneration?: 'cloudformation-v1';
          cloudFormationStackName?: string;
          awsAccountId?: string;
          awsRegion?: string;
        };
        apiKey?: { id: string; secret: string };
      };
    };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main(): Promise<void> {
  let parsed: SidecarInput;
  try {
    const raw = await readStdin();
    parsed = JSON.parse(raw) as SidecarInput;
  } catch (e) {
    emit({ type: 'error', error: `invalid sidecar input: ${e instanceof Error ? e.message : e}` });
    process.exit(1);
    return;
  }

  const onEvent = (event: BootstrapEvent): void => emit(event);

  try {
    switch (parsed.kind) {
      case 'bootstrap': {
        const config = parsed.bootstrapInput.base.config;
        if (!('region' in config)) throw new Error('CloudFormation installer currently supports AWS bases only');
        onEvent({ type: 'phase-started', phase: 'phase1' });
        const deps = createAwsCloudInstallDependencies({
          region: config.region,
          awsProfile: parsed.bootstrapInput.aws?.profile,
          writeProfile: () => undefined,
          log: (message) => onEvent({ type: 'log', level: 'info', message }),
        });
        const stackName = `appliance-${parsed.bootstrapInput.base.name}`;
        const profile = await runCloudInstall(
          {
            installationName: parsed.bootstrapInput.base.name,
            stackName,
            region: config.region,
            architecture: 'x86_64',
            sourceImage: parsed.bootstrapInput.apiServerImageUri,
            awsProfile: parsed.bootstrapInput.aws?.profile,
            profileName: parsed.bootstrapInput.base.name,
          },
          deps
        );
        onEvent({ type: 'phase-completed', phase: 'phase1' });
        onEvent({
          type: 'log',
          level: 'info',
          message: 'CloudFormation substrate installed. Provision the typed edge target to attach the chosen domain.',
        });
        emit({
          type: 'result',
          result: {
            stateBackendUrl: '',
            apiServerUrl: profile.apiUrl,
            apiKey: { id: profile.keyId, secret: profile.secret },
            statePromoted: true,
            installGeneration: profile.installGeneration,
            cloudFormationStackName: profile.cloudFormationStackName,
            awsAccountId: profile.awsAccountId,
            awsRegion: profile.awsRegion,
          },
        });
        break;
      }
      case 'promote-state': {
        await runStatePromotion(parsed.input, {
          ...(parsed.options ?? {}),
          onEvent,
        });
        // promote-state has no structured result; the frontend just
        // cares about success vs error. Emit an empty object so the
        // Rust side has a result line to settle on.
        emit({ type: 'result', result: {} });
        break;
      }
      case 'demote-state': {
        await runStateDemotion(parsed.input, {
          ...(parsed.options ?? {}),
          onEvent,
        });
        emit({ type: 'result', result: {} });
        break;
      }
      case 'update-api-server': {
        const install = parsed.input.installation;
        if (resolveInstallGeneration(install?.installGeneration) === 'cloudformation-v1') {
          if (!install) throw new Error('CloudFormation update is missing installation metadata');
          const deps = createAwsCloudInstallDependencies({
            region: install.awsRegion,
            awsProfile: parsed.input.awsProfile,
            writeProfile: () => undefined,
            log: (message) => onEvent({ type: 'log', level: 'info', message }),
          });
          await runCloudSystemUpdate(
            {
              profile: {
                ...install,
                apiUrl: parsed.input.apiServerUrl,
                keyId: parsed.input.apiKey.id,
                secret: parsed.input.apiKey.secret,
              },
              installationName: install.cloudFormationStackName.replace(/^appliance-/, ''),
              sourceImage: `${parsed.input.imageBase ?? 'ghcr.io/appliance-sh/api-server'}:${parsed.input.targetVersion}`,
              awsProfile: parsed.input.awsProfile,
            },
            deps
          );
        } else {
          await runApiServerUpdate(parsed.input, { ...(parsed.options ?? {}), onEvent });
        }
        emit({ type: 'result', result: {} });
        break;
      }
      case 'update-baseline': {
        const install = parsed.input.installation;
        if (resolveInstallGeneration(install?.installGeneration) === 'cloudformation-v1') {
          if (!install) throw new Error('CloudFormation update is missing installation metadata');
          const deps = createAwsCloudInstallDependencies({
            region: install.awsRegion,
            awsProfile: parsed.input.awsProfile,
            writeProfile: () => undefined,
            log: (message) => onEvent({ type: 'log', level: 'info', message }),
          });
          await runCloudBaselineUpdate(
            {
              profile: {
                ...install,
                apiUrl: parsed.input.cluster?.apiServerUrl ?? '',
                keyId: parsed.input.cluster?.apiKey.id ?? '',
                secret: parsed.input.cluster?.apiKey.secret ?? '',
              },
              installationName: install.cloudFormationStackName.replace(/^appliance-/, ''),
            },
            deps
          );
        } else {
          await runBaselineUpdate(parsed.input, { ...(parsed.options ?? {}), onEvent });
        }
        emit({ type: 'result', result: {} });
        break;
      }
      case 'latest-version': {
        const version = await latestGhcrTag(parsed.input ?? {});
        emit({ type: 'result', result: { version } });
        break;
      }
      case 'teardown': {
        const cluster = parsed.input?.cluster;
        if (resolveInstallGeneration(cluster?.installGeneration) === 'cloudformation-v1') {
          if (!cluster) throw new Error('CloudFormation teardown is missing cluster metadata');
          if (!cluster.cloudFormationStackName || !cluster.awsAccountId || !cluster.awsRegion || !parsed.input?.apiKey)
            throw new Error('CFN teardown requires stack/account/region metadata and the selected API key');
          const profile: CloudLifecycleProfile = {
            installGeneration: 'cloudformation-v1',
            cloudFormationStackName: cluster.cloudFormationStackName,
            awsAccountId: cluster.awsAccountId,
            awsRegion: cluster.awsRegion,
            apiUrl: cluster.apiServerUrl,
            keyId: parsed.input.apiKey.id,
            secret: parsed.input.apiKey.secret,
          };
          const deps = createAwsCloudLifecycleDependencies({
            region: cluster.awsRegion,
            awsProfile: parsed.input.awsProfile,
            log: (message) => onEvent({ type: 'log', level: 'info', message }),
          });
          const result = await runCloudTeardown(profile, deps);
          for (const retained of result.retained) {
            onEvent({ type: 'log', level: 'warn', message: `retained ${retained.kind}: ${retained.value}` });
          }
          emit({ type: 'result', result });
        } else {
          await runTeardown({
            cacheDir: parsed.input?.cacheDir ?? path.join(os.homedir(), '.appliance'),
            awsProfile: parsed.input?.awsProfile,
            ...(cluster && parsed.input?.apiKey
              ? { cluster: { apiServerUrl: cluster.apiServerUrl, apiKey: parsed.input.apiKey } }
              : {}),
            emit: onEvent,
          });
          emit({ type: 'result', result: {} });
        }
        break;
      }
      default: {
        const _exhaustive: never = parsed;
        throw new Error(`unknown sidecar input kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
    process.exit(0);
  } catch (e) {
    emit({ type: 'error', error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}

main();
