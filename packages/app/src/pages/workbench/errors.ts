import type { WorkbenchError } from '@/lib/host';

export function isUnreadableWorkbenchFile(
  error: unknown
): error is Extract<WorkbenchError, { kind: 'unreadable-file' }> {
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return value.kind === 'unreadable-file' && typeof value.path === 'string' && typeof value.reason === 'string';
}

export function workbenchErrorMessage(error: unknown): string {
  if (isUnreadableWorkbenchFile(error)) {
    return `${error.path} is unreadable (${error.reason}). Fix or delete it to reset this workspace's view settings. Your project and deploy link are not affected.`;
  }
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
    return error.message;
  return String(error);
}
