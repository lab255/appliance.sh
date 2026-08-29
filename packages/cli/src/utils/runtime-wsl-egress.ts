import { runVmCapture } from './sandbox.js';
import { WSL_COOPERATIVE_WARNING } from './settings.js';

const RUNTIME_POOL_VM = 'appliance-runtime';

export interface RuntimeEgressCapability {
  enforcement?: { backend?: string; bypassable?: boolean; scope?: string[] };
  wslMode?: 'strict' | 'cooperative';
}

export type RuntimeWslEgressDecision =
  | { action: 'allow'; warning?: string; firstRunNotice?: string }
  | { action: 'refuse'; message: string };

/** Pure AP-205 start gate. Backend and policy lookup stay outside so the CLI
 *  and fake-backend tests exercise the exact same decision. */
export function decideRuntimeWslEgress(
  appId: string,
  capability: RuntimeEgressCapability,
  requestsEgress: boolean,
  platform = process.platform
): RuntimeWslEgressDecision {
  const backend = capability.enforcement?.backend;
  if (backend !== 'wsl') {
    if (platform !== 'win32' || (typeof backend === 'string' && backend.length > 0)) return { action: 'allow' };
    return {
      action: 'refuse',
      message:
        `Runtime start refused on WSL: '${appId}' cannot verify wsl-mode because the engine is too old for wsl-mode; ` +
        'update appliance-vm.',
    };
  }
  const mode = capability.wslMode === 'cooperative' ? 'cooperative' : 'strict';
  if (mode === 'strict' && requestsEgress) {
    return {
      action: 'refuse',
      message:
        `Runtime start refused on WSL: '${appId}' requests egress grants, but wsl-mode is strict. ` +
        'Opt in to bypassable proxy enforcement with `appliance vm egress wsl-mode cooperative`.',
    };
  }
  if (mode === 'cooperative') return { action: 'allow', warning: WSL_COOPERATIVE_WARNING };
  return {
    action: 'allow',
    firstRunNotice:
      'WSL strict mode: this app requests no egress grants, so it may run; its outbound traffic is dropped.',
  };
}

export function runtimeEgressCapability(platform = process.platform): RuntimeEgressCapability {
  if (platform !== 'win32') return {};
  const result = runVmCapture(['egress', 'policy', RUNTIME_POOL_VM]);
  if (result.status !== 0) throw new Error(`could not read wsl-mode for '${RUNTIME_POOL_VM}'`);
  try {
    return JSON.parse(result.stdout) as RuntimeEgressCapability;
  } catch {
    throw new Error(`could not read wsl-mode for '${RUNTIME_POOL_VM}': engine returned malformed policy JSON`);
  }
}

export function wslModeCommandArgs(mode: 'strict' | 'cooperative' | undefined, name = RUNTIME_POOL_VM): string[] {
  return ['egress', 'wsl-mode', ...(mode ? [mode] : []), '--name', name];
}
