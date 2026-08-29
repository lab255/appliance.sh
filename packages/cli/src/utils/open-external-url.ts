import { spawn } from 'node:child_process';

export interface ExternalUrlCommand {
  command: string;
  args: string[];
}

export function externalUrlCommand(url: string, platform: NodeJS.Platform): ExternalUrlCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    // Windows: rundll32's FileProtocolHandler takes the URL as a plain
    // argument. `cmd /c start` re-parses its command line, so URLs containing
    // shell metacharacters or `%VAR%` pairs can be split or rewritten.
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
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
