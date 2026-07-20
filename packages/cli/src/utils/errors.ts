import chalk from 'chalk';

/** True when the error is @inquirer/prompts' Ctrl-C cancellation —
 *  cosmetically an abort, not a failure worth a red stack trace. */
export function isPromptCancel(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError';
}

/** One-line remediation hint for the most common API/network failure
 *  shapes, or null when the raw message has to speak for itself. Order
 *  matters: more specific shapes are matched before the broad network
 *  catch-all so each failure points at the exact fix. */
export function remediationHint(message: string, apiUrl?: string): string | null {
  if (/not logged in|no credentials|no active profile|credentials not found/i.test(message)) {
    return 'Not logged in — run `appliance login` (or `appliance vm up` for the local runtime), then retry.';
  }
  if (/\b401\b|unauthoriz|signature|invalid key/i.test(message)) {
    return 'Authentication failed — run `appliance login` to refresh credentials, or check the active profile with `appliance whoami`.';
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return 'This API key is not allowed to do that — check which profile is active with `appliance whoami`.';
  }
  if (/kubeconfig/i.test(message)) {
    return 'No kubeconfig for this runtime — bring it up with `appliance vm up`, which writes the kubeconfig.';
  }
  if (/no such (host|cluster)|cluster .*not (found|exist|running)|does not exist/i.test(message)) {
    return 'The local runtime is not running — start it with `appliance vm up` (`appliance vm status` shows what is missing).';
  }
  if (/buildkit|buildctl/i.test(message)) {
    return 'The BuildKit builder is not reachable — is the microVM up? `appliance vm up` brings it back (first-time setup: `appliance init`).';
  }
  if (/docker|container runtime|daemon|colima/i.test(message)) {
    const start = process.platform === 'win32' ? 'open Docker Desktop' : '`colima start`, or open Docker Desktop';
    return `The container runtime is not reachable — start it (${start}), then re-run (\`appliance doctor\` checks the host prerequisites).`;
  }
  if (/\b5\d\d\b|bad gateway|gateway timeout|service unavailable/i.test(message)) {
    return `The api-server${apiUrl ? ` at ${apiUrl}` : ''} returned a server error — it may still be starting; wait a moment and retry, or check it with \`appliance test\`.`;
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up|abort|not reachable/i.test(message)) {
    return `Could not reach the api-server${apiUrl ? ` at ${apiUrl}` : ''} — is it running? \`appliance test\` runs connection diagnostics.`;
  }
  return null;
}

/** Print an error in the CLI's standard shape (red message + dim
 *  remediation hint) and set a non-zero exit code. Prompt
 *  cancellations get a quiet "Cancelled." and the conventional 130. */
export function printCliError(error: unknown, opts?: { apiUrl?: string }): void {
  if (isPromptCancel(error)) {
    console.error(chalk.dim('Cancelled.'));
    process.exitCode = 130;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(message));
  const hint = remediationHint(message, opts?.apiUrl);
  if (hint) console.error(chalk.dim(hint));
  process.exitCode = 1;
}
