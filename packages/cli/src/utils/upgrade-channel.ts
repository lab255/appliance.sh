// Which distribution channel is this `appliance` process running from?
// Drives `appliance upgrade`'s instructions — print the fix for the
// channel the user actually has, instead of a generic wall of options.

export type UpgradeChannel = 'desktop' | 'source' | 'standalone';

/**
 * Classify by executable path — dumb and honest:
 *  - `desktop`:    the Bun-compiled sidecar bundled inside the desktop
 *                  app (macOS `.app` bundle, or the Tauri install dir on
 *                  Windows). Upgrading the app upgrades this CLI.
 *  - `source`:     running under a `node`/`bun` interpreter (a repo
 *                  checkout or npm install executing dist JS).
 *  - `standalone`: a compiled `appliance` binary anywhere else (npm
 *                  postinstall download, curl install, manual copy).
 */
export function detectUpgradeChannel(execPath: string): UpgradeChannel {
  const p = execPath.replace(/\\/g, '/');
  if (/\.app\/Contents\//.test(p) || /\/(appliance(\s+desktop)?|Appliance)\/appliance(\.exe)?$/i.test(p)) {
    return 'desktop';
  }
  if (/\/(node|bun)(\.exe)?$/i.test(p)) return 'source';
  return 'standalone';
}

/** The instructions per channel, as printable lines. */
export function upgradeInstructions(channel: UpgradeChannel): string[] {
  switch (channel) {
    case 'desktop':
      return [
        'This CLI is bundled with the Appliance desktop app — it updates with the app:',
        '  1. Open the desktop app and accept the update prompt (or reinstall the latest DMG/installer).',
        '  2. Restart the Dev Machine so the guest control plane picks up the new version.',
        '     https://github.com/lab255/appliance.sh/releases',
      ];
    case 'source':
      return [
        'This CLI runs from source / an npm install:',
        '  npm install -g @appliance.sh/cli@latest    (or: pnpm add -g @appliance.sh/cli@latest)',
        'From a repo checkout: git pull && pnpm install && pnpm build.',
      ];
    case 'standalone':
      return [
        'This CLI is a standalone binary:',
        '  npm install -g @appliance.sh/cli@latest    (reinstalls the binary)',
        'or download the latest release binary:',
        '  https://github.com/lab255/appliance.sh/releases',
      ];
  }
}
