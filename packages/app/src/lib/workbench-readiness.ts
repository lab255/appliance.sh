import { useSyncExternalStore } from 'react';

/** F3 has no live adapter contract. This source is deliberately fixture-only. */
export interface ReadinessFixture {
  source: 'fixture';
  directory: string;
  proposalId: string;
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

export function readinessStaleReason(proposal: ReadinessFixture): string | undefined {
  switch (proposal.sessionStatus) {
    case 'stopped':
      return 'The source session was stopped.';
    case 'dismissed':
      return 'The source session was dismissed.';
    case 'error':
    case 'exited':
      return 'The source session ended without a successful result.';
    default:
      return undefined;
  }
}
