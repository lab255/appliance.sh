import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import type { ApplianceV2, EntitlementGrant, EntitlementRecord } from '@appliance.sh/sdk';
import {
  DEFAULT_SUGGESTION_DAYS,
  applianceHome,
  computeGrantDelta,
  describeGrant,
  latestEntitlement,
  readEntitlementStore,
  requestedGrantsForManifest,
  revokeEntitlementGrant,
  suggestedRevocations,
  type EntitlementOptions,
} from './utils/entitlements.js';

export interface EntitlementGrantPromptDetails {
  appId: string;
  version: string;
  license: string;
  upgrade: boolean;
  grants: EntitlementGrant[];
  requiredGrantIds: string[];
}

export class EntitlementGrantRequiredError extends Error {
  readonly code = 'ENTITLEMENT_GRANT_REQUIRED';

  constructor(readonly details: EntitlementGrantPromptDetails) {
    super(`Grant approval is required for ${details.appId} ${details.version}.`);
    this.name = 'EntitlementGrantRequiredError';
  }

  serialise(): string {
    return `${this.code}:${JSON.stringify(this.details)}`;
  }
}

export function entitlementGrantPrompt(
  manifest: ApplianceV2,
  options: EntitlementOptions = {}
): EntitlementGrantPromptDetails | null {
  const store = readEntitlementStore(options);
  const current = latestEntitlement(store.records, manifest.name);
  const delta = computeGrantDelta(
    requestedGrantsForManifest(manifest, (options.now ?? new Date()).toISOString()),
    current
  );
  if (delta.additions.length === 0) return null;
  return {
    appId: manifest.name,
    version: manifest.version,
    license: manifest.license,
    upgrade: Boolean(current?.state === 'installed'),
    grants: delta.additions,
    requiredGrantIds: delta.additions.filter((grant) => grant.control !== 'mount').map((grant) => grant.id),
  };
}

export async function promptForEntitlementGrants(details: EntitlementGrantPromptDetails): Promise<string[] | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  console.error(chalk.yellow(details.upgrade ? 'UPGRADE DELTA grant' : 'GRANT requested controls'));
  console.error(`${details.appId} ${details.version} · ${details.license}`);
  for (const grant of details.grants) {
    console.error(`  ${grant.control === 'mount' ? 'optional' : 'required'} · ${grant.id} · ${describeGrant(grant)}`);
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `${details.upgrade ? 'Grant these new controls and upgrade' : 'Grant all controls and install'}? [y/N] `
    );
    return /^y(?:es)?$/i.test(answer.trim()) ? details.grants.map((grant) => grant.id) : null;
  } finally {
    prompt.close();
  }
}

export async function runRuntimeEntitlementsCommand(
  args: string[],
  onRevoked?: (appId: string, grantId: string) => void | Promise<void>
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: appliance runtime entitlements [list|show <app>|revoke <app> <grant-id>|--suggest-revoke]');
    console.log(`Suggestions default to ${DEFAULT_SUGGESTION_DAYS} unused days; override with --days <whole-days>.`);
    return;
  }
  const json = args.includes('--json');
  const home = optionValue(args, '--home') ?? applianceHome();
  const store = readEntitlementStore({ home });
  const verb = firstPositional(args, ['--days', '--home']) ?? 'list';
  if (args.includes('--suggest-revoke') || verb === 'suggest-revoke') {
    const daysValue = optionValue(args, '--days');
    if (args.includes('--days') && daysValue === undefined) {
      throw new Error('--days requires a whole number (minimum 1).');
    }
    const days = wholeDays(daysValue);
    const suggestions = suggestedRevocations(store.records, new Date(), days);
    if (json) console.log(JSON.stringify(suggestions));
    else printSuggestions(suggestions);
    return;
  }
  if (verb === 'revoke') {
    const positionals = positionalArgs(args, ['--days', '--home']);
    const appId = positionals[1];
    const grantId = positionals[2];
    if (!appId || !grantId) throw new Error('Usage: appliance runtime entitlements revoke <app> <grant-id>');
    if (!args.includes('--yes') && !(await confirmRevoke(appId, grantId))) throw new Error('Revocation cancelled.');
    const record = revokeEntitlementGrant(appId, grantId, { home });
    await onRevoked?.(appId, grantId);
    if (json) console.log(JSON.stringify(record));
    else console.log(`${chalk.green('✓')} revoked ${grantId} from ${appId}`);
    return;
  }
  if (verb === 'show') {
    const appId = positionalArgs(args, ['--days', '--home'])[1];
    if (!appId) throw new Error('Usage: appliance runtime entitlements show <app>');
    const records = store.records.filter((record) => record.appId === appId);
    if (records.length === 0) throw new Error(`No entitlement history exists for '${appId}'.`);
    if (json) console.log(JSON.stringify(records));
    else printRecords(records);
    return;
  }
  if (verb !== 'list') throw new Error(`Unknown entitlements action '${verb}'.`);
  const current = latestRecords(store.records);
  if (json) console.log(JSON.stringify(current));
  else printRecords(current);
}

function latestRecords(records: EntitlementRecord[]): EntitlementRecord[] {
  const latest = new Map<string, EntitlementRecord>();
  for (const record of records) latest.set(record.appId, record);
  return [...latest.values()].sort((a, b) => a.appId.localeCompare(b.appId));
}

function printRecords(records: EntitlementRecord[]): void {
  if (records.length === 0) {
    console.log('No entitlement grants.');
    return;
  }
  console.log('APP\tVERSION\tLICENSE\tSTATE\tGRANTED\tGRANTS');
  for (const record of records) {
    console.log(
      `${record.appId}\t${record.version}\t${record.license}\t${record.state}\t${record.grantedAt}\t${record.grants.length}`
    );
    for (const grant of record.grants) {
      console.log(`  ${grant.id}\t${describeGrant(grant)}\tlast used ${record.usage[grant.id]?.lastUsedAt ?? 'never'}`);
    }
  }
}

function printSuggestions(suggestions: ReturnType<typeof suggestedRevocations>): void {
  if (suggestions.length === 0) {
    console.log('No grants are currently suggested for revocation.');
    return;
  }
  console.log('APP\tGRANT\tLAST USED\tREASON\tREVOKE');
  for (const suggestion of suggestions) {
    console.log(
      `${suggestion.appId}\t${suggestion.grant.id}\t${suggestion.lastUsedAt ?? 'never'}\t${suggestion.reason}\t${suggestion.revokeCommand}`
    );
  }
}

async function confirmRevoke(appId: string, grantId: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Revoke ${grantId} from ${appId}? [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function wholeDays(value?: string): number {
  if (!value) return DEFAULT_SUGGESTION_DAYS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('--days must be a whole number (minimum 1).');
  return parsed;
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function firstPositional(args: string[], valueOptions: string[]): string | undefined {
  return positionalArgs(args, valueOptions)[0];
}

function positionalArgs(args: string[], valueOptions: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (valueOptions.includes(args[index]!)) {
      index += 1;
      continue;
    }
    if (!args[index]!.startsWith('-')) result.push(args[index]!);
  }
  return result;
}
