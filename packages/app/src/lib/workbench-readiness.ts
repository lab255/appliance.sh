import { useSyncExternalStore } from 'react';
import type { WorkbenchSession } from './host';

/** F3 has no live adapter contract. This source is deliberately fixture-only. */
export interface ReadinessFixture {
  source: 'fixture';
  directory: string;
  proposalId: string;
  /** Host inspection snapshot identity this revision describes. */
  revision: string;
  baselineId: string;
  sessionId: string;
  sessionStatus: 'running' | 'done' | 'error' | 'exited' | 'stopped' | 'dismissed';
  summary: string;
}

export interface ReadinessFixtureSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReadinessFixture | null;
}

const noProposal = () => null;
const noSubscription = () => () => {};

/** Directory scope is checked before a session proposal reaches the human action. */
export function useReadinessFixture(directory: string, source?: ReadinessFixtureSource) {
  const proposal = useSyncExternalStore(
    source?.subscribe ?? noSubscription,
    source?.getSnapshot ?? noProposal,
    noProposal
  );
  return proposal?.source === 'fixture' && proposal.directory === directory ? proposal : null;
}

export interface ReadinessContext {
  directory: string;
  sessions: WorkbenchSession[];
  snapshotId?: string;
  baselineId?: string | null;
}

export function readinessStaleReason(proposal: ReadinessFixture, context?: ReadinessContext): string | undefined {
  switch (proposal.sessionStatus) {
    case 'stopped':
      return 'The source session was stopped.';
    case 'dismissed':
      return 'The source session was dismissed.';
    case 'error':
    case 'exited':
      return 'The source session ended without a successful result.';
    default:
      break;
  }
  if (!context || context.directory !== proposal.directory || !context.snapshotId || !context.baselineId)
    return 'Freshness unknown: host inspection is unavailable. Refresh inspection before reviewing this proposal.';
  const sessions = context.sessions.filter((session) => session.sessionId === proposal.sessionId);
  if (sessions.length !== 1 || sessions[0].status !== proposal.sessionStatus)
    return 'Session unknown: the proposal does not match host-owned session records.';
  if (
    !proposal.revision ||
    !proposal.baselineId ||
    proposal.revision !== context.snapshotId ||
    proposal.baselineId !== context.baselineId
  )
    return 'The workspace baseline or snapshot has advanced beyond this proposal. Review the latest inspection.';
  return undefined;
}
