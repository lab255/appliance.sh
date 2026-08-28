import { ClusterSwitcher, useCurrentWorkspace } from './cluster-switcher';

export { useCurrentWorkspace };

export function WorkspaceSwitcher({ onSetup }: { onSetup: () => void }) {
  return <ClusterSwitcher presentation="workspace" onSetupWorkspace={onSetup} />;
}
