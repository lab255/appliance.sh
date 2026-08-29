import { spawn } from 'node:child_process';

export interface ExternalUrlCommand {
  command: string;
  args: string[];
}

export function externalUrlCommand(url: string, platform: NodeJS.Platform): ExternalUrlCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    // cmd.exe parses `&` even when Node supplies the URL as one argv entry.
    // Escape it before handing the command line to `start`.
    return { command: 'cmd.exe', args: ['/C', 'start', '', url.replace(/&/g, '^&')] };
  }
  return { command: 'xdg-open', args: [url] };
}

/** Open a URL in the OS default browser, printing it if launching fails. */
export function openExternalUrl(url: string): void {
  const launch = externalUrlCommand(url, process.platform);
  try {
    const child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log(url));
    child.unref();
  } catch {
    console.log(url);
  }
}
