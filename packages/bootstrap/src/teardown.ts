import * as fs from 'node:fs';
import * as path from 'node:path';
import * as auto from '@pulumi/pulumi/automation';
import type { BootstrapEvent } from './types';
import { awsCredsFromEnv, forwardPulumiEvent, homeEnv } from './phases/helpers';
import { emitLegacyDeprecation } from './deprecation';
import { verifyLegacyCluster, type ClusterRef } from './cluster-verify';

export interface TeardownOptions {
  /** Cache dir that holds the local Pulumi state + promoted-backend marker. */
  cacheDir: string;
  /** AWS profile to authenticate the destroy with (matches BootstrapInput.aws.profile). */
  awsProfile?: string;
  /** Stream of progress events. */
  emit?: (event: BootstrapEvent) => void;
  /** Endpoint ownership check. Generation-aware callers must supply this. */
  cluster?: ClusterRef;
}

const PROJECT_NAME = 'appliance-installer';
const STACK_NAME = 'bootstrap';

// Pulumi destroys via the state graph alone; the program closure
// isn't invoked. A no-op satisfies LocalWorkspace's signature without
// requiring us to reconstruct the original applianceInfra inputs.
const trivialProgram = async () => ({});

interface PromotedConfig {
  backend: string;
  promotedAt: string;
}

/**
 * Destroy the installer stack created by `runBootstrap`. Idempotent
 * with respect to repeated runs — once the stack is gone, calling
 * teardown again is a no-op (Pulumi reports "not found"). Local
 * Pulumi state is archived (renamed to `pulumi-state.bak-<ts>`)
 * after destroy succeeds so the operation is reversible if the
 * operator notices something was incorrectly torn down.
 *
 * Out of scope (v1): destroying user-deployed appliances on the
 * cluster. Those live in a separate Pulumi project
 * (`appliance-api-managed-proj`) and need to be destroyed via the
 * api-server's deploy API (or `appliance destroy`) before tearing
 * down the cluster — otherwise their resources will be orphaned in
 * AWS when the state bucket goes away.
 */
export async function runTeardown(opts: TeardownOptions): Promise<void> {
  const emit = opts.emit ?? (() => {});
  emitLegacyDeprecation(emit);
  await verifyLegacyCluster(opts.cluster);
  const localStateDir = path.join(opts.cacheDir, 'pulumi-state');
  const workDir = path.join(opts.cacheDir, 'pulumi-workdir');
  const pulumiHome = path.join(opts.cacheDir, 'pulumi-home');
  const configPath = path.join(opts.cacheDir, 'config.json');

  // Determine which backend the installer stack lives in. After
  // phase 3 the state has been promoted to S3 and a config marker is
  // written; before phase 3 the stack is in the local file backend.
  let backendUrl: string;
  let stateWasPromoted = false;
  if (fs.existsSync(configPath)) {
    const promoted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as PromotedConfig;
    backendUrl = promoted.backend;
    stateWasPromoted = true;
    emit({ type: 'log', level: 'info', message: `state backend (promoted): ${backendUrl}` });
  } else if (fs.existsSync(localStateDir)) {
    backendUrl = `file://${localStateDir}`;
    emit({ type: 'log', level: 'info', message: `state backend (local): ${backendUrl}` });
  } else {
    emit({
      type: 'log',
      level: 'warn',
      message: `no installer state found in ${opts.cacheDir}; nothing to tear down`,
    });
    return;
  }

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(pulumiHome, { recursive: true });

  emit({ type: 'log', level: 'info', message: 'opening installer stack…' });
  const stack = await auto.LocalWorkspace.createOrSelectStack(
    { projectName: PROJECT_NAME, stackName: STACK_NAME, program: trivialProgram },
    {
      workDir,
      envVars: {
        PULUMI_BACKEND_URL: backendUrl,
        PULUMI_HOME: pulumiHome,
        PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? '',
        ...awsCredsFromEnv(opts.awsProfile),
        ...homeEnv(),
      },
    }
  );

  emit({ type: 'log', level: 'info', message: 'destroying installer stack…' });
  const result = await stack.destroy({
    onEvent: (e) => forwardPulumiEvent(e, emit),
    onOutput: (line) => emit({ type: 'log', level: 'info', message: line.trimEnd() }),
  });
  if (result.summary.result !== 'succeeded') {
    throw new Error(`pulumi destroy failed: ${result.summary.result}`);
  }
  emit({ type: 'log', level: 'info', message: 'stack destroyed' });

  // Remove the stack record so a subsequent bootstrap starts fresh
  // rather than picking up an empty stack and erroring on duplicate
  // stack-name conflicts later.
  await stack.workspace.removeStack(STACK_NAME).catch(() => {
    // Non-fatal: the stack record may already be gone.
  });

  // Archive whatever local state exists. Even if state was promoted
  // to S3, the original local backup may still be on disk from
  // phase 3 — leave those backups alone (they're already
  // dated-suffixed) but rename the live `pulumi-state` dir if it
  // somehow lingered.
  if (fs.existsSync(localStateDir)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archived = `${localStateDir}.bak-${ts}`;
    fs.renameSync(localStateDir, archived);
    emit({ type: 'log', level: 'info', message: `archived local state → ${archived}` });
  }

  if (stateWasPromoted) {
    // The S3 state bucket was just destroyed along with the stack
    // (it's an installer-stack resource). The promoted-config marker
    // now points at a bucket that doesn't exist, so remove it.
    fs.unlinkSync(configPath);
    emit({ type: 'log', level: 'info', message: `removed ${configPath}` });
  }
}
