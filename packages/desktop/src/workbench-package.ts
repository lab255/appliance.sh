import { Channel, invoke } from '@tauri-apps/api/core';
import type { WorkbenchPackageEvent, WorkbenchPackageHost } from '@appliance.sh/app';

/** Workbench Package — separate from session observation and deployment. */
export const workbenchPackageHost: WorkbenchPackageHost = {
  package(directory, onEvent) {
    const channel = new Channel<WorkbenchPackageEvent>();
    channel.onmessage = onEvent;
    return invoke('workbench_package', { directory, onEvent: channel });
  },
};
