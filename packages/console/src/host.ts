import type { AddClusterInput, Cluster, ConsoleHost, HostConfig } from '@appliance.sh/app';

const CLUSTERS_KEY = 'appliance:clusters';
const SELECTED_KEY = 'appliance:selectedClusterId';
const apiKeyStorageKey = (clusterId: string) => `appliance:apikey:${clusterId}`;

// Legacy single-cluster keys, migrated to the multi-cluster shape on
// first read.
const LEGACY_API_SERVER_URL_KEY = 'appliance:api-server-url';
const LEGACY_API_KEY_KEY = 'appliance:api-key';

// Web host implementation. Cluster metadata + API keys live in
// localStorage so a teammate stays signed in across tabs and restarts —
// re-pasting a secret on every visit is exactly the friction the invite
// flow removes. (Keys were briefly sessionStorage-scoped; that state is
// migrated forward on first read.) An api-server-served build injects
// runtime config via window.__APPLIANCE_CONFIG__.
declare global {
  interface Window {
    __APPLIANCE_CONFIG__?: {
      apiServerUrl?: string;
      consoleMode?: 'full' | 'bootstrap' | 'off';
      consoleUrl?: string;
    };
  }
}

interface PersistedClusters {
  clusters: Cluster[];
  selectedClusterId: string | null;
}

// One-time migrations into localStorage: (a) the sessionStorage era —
// same keys, tab-scoped; (b) the legacy single-cluster shape. Both are
// deleted after migrating so we don't re-migrate next time.
function migrateOlderStorage(): void {
  if (localStorage.getItem(CLUSTERS_KEY)) return;

  const sessionClusters = sessionStorage.getItem(CLUSTERS_KEY);
  if (sessionClusters) {
    try {
      const parsed = JSON.parse(sessionClusters) as Cluster[];
      if (Array.isArray(parsed)) {
        localStorage.setItem(CLUSTERS_KEY, sessionClusters);
        const selected = sessionStorage.getItem(SELECTED_KEY);
        if (selected) localStorage.setItem(SELECTED_KEY, selected);
        for (const cluster of parsed) {
          const key = sessionStorage.getItem(apiKeyStorageKey(cluster.id));
          if (key) localStorage.setItem(apiKeyStorageKey(cluster.id), key);
        }
      }
    } catch {
      // discard malformed
    }
    sessionStorage.removeItem(CLUSTERS_KEY);
    sessionStorage.removeItem(SELECTED_KEY);
    return;
  }

  const legacyUrl = window.__APPLIANCE_CONFIG__?.apiServerUrl ?? sessionStorage.getItem(LEGACY_API_SERVER_URL_KEY);
  const legacyKeyRaw = sessionStorage.getItem(LEGACY_API_KEY_KEY);
  if (legacyUrl && legacyKeyRaw) {
    try {
      const legacyKey = JSON.parse(legacyKeyRaw) as { id: string; secret: string };
      const id = randomId();
      const cluster: Cluster = {
        id,
        name: deriveNameFromUrl(legacyUrl),
        apiServerUrl: legacyUrl,
        createdAt: new Date().toISOString(),
      };
      localStorage.setItem(apiKeyStorageKey(id), JSON.stringify(legacyKey));
      writePersisted({ clusters: [cluster], selectedClusterId: id });
      sessionStorage.removeItem(LEGACY_API_SERVER_URL_KEY);
      sessionStorage.removeItem(LEGACY_API_KEY_KEY);
    } catch {
      // discard malformed legacy state
    }
  }
}

function readPersisted(): PersistedClusters {
  migrateOlderStorage();

  let clusters: Cluster[] = [];

  const rawClusters = localStorage.getItem(CLUSTERS_KEY);
  if (rawClusters) {
    try {
      const parsed = JSON.parse(rawClusters);
      if (Array.isArray(parsed)) clusters = parsed;
    } catch {
      // discard malformed
    }
  }
  const selectedClusterId = localStorage.getItem(SELECTED_KEY);

  return { clusters, selectedClusterId };
}

function writePersisted(state: PersistedClusters): void {
  localStorage.setItem(CLUSTERS_KEY, JSON.stringify(state.clusters));
  if (state.selectedClusterId) {
    localStorage.setItem(SELECTED_KEY, state.selectedClusterId);
  } else {
    localStorage.removeItem(SELECTED_KEY);
  }
}

function readApiKey(clusterId: string): { id: string; secret: string } | null {
  const raw = localStorage.getItem(apiKeyStorageKey(clusterId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { id: string; secret: string };
  } catch {
    return null;
  }
}

function deriveNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^api\./, '');
  } catch {
    return url;
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const webHost: ConsoleHost = {
  // The web console has no local-machine surface; keep any accidental fallback OS-neutral.
  platform: 'linux',
  async getConfig(): Promise<HostConfig> {
    const { clusters, selectedClusterId } = readPersisted();
    const apiKey = selectedClusterId ? readApiKey(selectedClusterId) : null;
    return { clusters, selectedClusterId, apiKey };
  },

  async addCluster(input: AddClusterInput): Promise<Cluster> {
    const { clusters } = readPersisted();
    const cluster: Cluster = {
      id: randomId(),
      name: input.name,
      apiServerUrl: input.apiServerUrl,
      createdAt: new Date().toISOString(),
    };
    localStorage.setItem(apiKeyStorageKey(cluster.id), JSON.stringify(input.apiKey));
    writePersisted({
      clusters: [...clusters, cluster],
      selectedClusterId: cluster.id,
    });
    return cluster;
  },

  async selectCluster(clusterId: string | null): Promise<void> {
    const { clusters } = readPersisted();
    if (clusterId && !clusters.some((c) => c.id === clusterId)) {
      throw new Error(`cluster not found: ${clusterId}`);
    }
    writePersisted({ clusters, selectedClusterId: clusterId });
  },

  async removeCluster(clusterId: string): Promise<void> {
    const { clusters, selectedClusterId } = readPersisted();
    const next = clusters.filter((c) => c.id !== clusterId);
    if (next.length === clusters.length) {
      throw new Error(`cluster not found: ${clusterId}`);
    }
    localStorage.removeItem(apiKeyStorageKey(clusterId));
    const nextSelected = selectedClusterId === clusterId ? (next[0]?.id ?? null) : selectedClusterId;
    writePersisted({ clusters: next, selectedClusterId: nextSelected });
  },

  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};
