import * as path from 'node:path';
import * as os from 'node:os';
import { runWorkspaceEngine, runDownloadEngine } from './engines/workspace';
import type { BootstrapInput, BootstrapOptions, BootstrapResult } from './types';
import { assertLegacyInstallation, emitLegacyDeprecation } from './deprecation';

/**
 * Public entry point. Both `@appliance.sh/cli` (for
 * `appliance bootstrap`) and `@appliance.sh/desktop` (for the
 * setup wizard) drive bootstrap through this function. The engine
 * option decides whether the Pulumi program runs from the
 * in-repo workspace or from a downloaded artifact — the result
 * and event shapes are identical either way.
 */
export async function runBootstrap(input: BootstrapInput, options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const emit = options.onEvent ?? (() => undefined);
  emitLegacyDeprecation(emit);
  if (options.prior?.phase1?.baseConfig) {
    assertLegacyInstallation(options.prior.phase1.baseConfig, 'runBootstrap');
  }
  const cacheDir = options.cacheDir ?? path.join(os.homedir(), '.appliance');
  const engine = options.engine ?? 'workspace';

  if (engine === 'download') {
    return runDownloadEngine(input, { ...options, cacheDir });
  }

  return runWorkspaceEngine(input, {
    cacheDir,
    onEvent: options.onEvent,
    phases: options.phases,
    prior: options.prior,
  });
}
