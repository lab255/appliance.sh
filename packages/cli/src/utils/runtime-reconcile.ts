import { spawnSync } from 'node:child_process';
import { resolveVmBinary } from './microvm-up.js';
import type { RuntimeRecord, RuntimeState } from './runtime-registry.js';

export interface RuntimeSupervisorStatus extends Record<string, unknown> {
  state?: unknown;
  exitCode?: unknown;
  services?: unknown[];
}

export interface RuntimeStatusBackend {
  poolRunning(poolVm: string): boolean;
  appStatus(poolVm: string, appId: string): RuntimeSupervisorStatus | null;
}

export interface RuntimeReconciliation {
  record: RuntimeRecord;
  status: RuntimeSupervisorStatus | null;
}

export function isWarmRuntimeState(state: RuntimeState): boolean {
  return state === 'starting' || state === 'running' || state === 'degraded';
}

/**
 * Reconcile a registry claim against both resident-process and supervisor
 * truth. Runtime pools deliberately do not auto-start apps after a restart;
 * an absent pool or supervisor row therefore becomes a durable stopped row.
 */
export function reconcileRuntimeRecord(
  record: RuntimeRecord,
  backend: RuntimeStatusBackend,
  now = new Date().toISOString()
): RuntimeReconciliation {
  if (!isWarmRuntimeState(record.state)) return { record, status: null };
  if (!backend.poolRunning(record.poolVm)) {
    return { record: stoppedRecord(record, now), status: null };
  }
  const status = backend.appStatus(record.poolVm, record.appId);
  const state = runtimeState(status?.state);
  if (!state || state === 'stopped' || state === 'missing') {
    return { record: stoppedRecord(record, now), status };
  }
  return {
    record: {
      ...record,
      state,
      ...(numberOrUndefined(status?.exitCode) == null ? {} : { exitCode: numberOrUndefined(status?.exitCode) }),
      updatedAt: now,
    },
    status,
  };
}

export const engineRuntimeStatusBackend: RuntimeStatusBackend = {
  poolRunning(poolVm) {
    const status = runEngineJson(['status', poolVm]);
    return status?.running === true;
  },
  appStatus(poolVm, appId) {
    return runEngineJson(['runtime', 'status', poolVm, appId]);
  },
};

function stoppedRecord(record: RuntimeRecord, now: string): RuntimeRecord {
  return { ...record, state: 'stopped', exitCode: undefined, updatedAt: now };
}

function runtimeState(value: unknown): RuntimeState | 'missing' | undefined {
  return typeof value === 'string' &&
    ['starting', 'running', 'degraded', 'stopped', 'exited', 'failed', 'missing'].includes(value)
    ? (value as RuntimeState | 'missing')
    : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function runEngineJson(args: string[]): RuntimeSupervisorStatus | null {
  const binary = resolveVmBinary();
  if (!binary) return null;
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as RuntimeSupervisorStatus) : null;
  } catch {
    return null;
  }
}
