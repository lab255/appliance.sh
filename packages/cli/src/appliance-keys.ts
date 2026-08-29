import { Command } from 'commander';
import chalk from 'chalk';
import { createApplianceClient } from '@appliance.sh/sdk';
import { loadCredentials, getActiveProfileOverride } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { type Profile, readProfiles, resolveProfile, upsertProfile } from './utils/profile-store.js';

// Persist a freshly-rotated credential. On macOS a desktop-managed
// cluster's secret is canonical in the Keychain, so push the new key
// there and keep the cleartext OUT of profiles.json (metadata-only
// entry). Everywhere else — and if the Keychain write fails so the user
// isn't stranded — the secret is written to profiles.json (0600); a
// failed desktop-managed write leaves a differing keyId, which makes
// resolveProfileSecret prefer this fresher file copy over the stale
// Keychain one.
//
// Returns `keychainWriteFailed: true` only when the Keychain was the
// canonical store for this profile (desktop-managed on macOS) AND the
// write to it failed — e.g. the user declined the ACL prompt. The new
// key is safe in profiles.json either way, but in that case the desktop
// keeps reading its stale Keychain copy, so the caller must warn instead
// of promising automatic pickup.
function persistRotatedCredential(
  profileName: string,
  profile: Profile,
  next: { id: string; secret: string }
): { keychainWriteFailed: boolean } {
  const result = upsertProfile(profileName, { ...profile, keyId: next.id, secret: next.secret }, { makeActive: false });
  return { keychainWriteFailed: result.credentialWriteFailed };
}

// `appliance keys` — lifecycle for the cluster's API credentials.
//
// Today this is `rotate`: re-mint the active profile's API key and
// atomically swap it into ~/.appliance/profiles.json. The old secret
// is revoked server-side the moment the new one is minted, so a leaked
// key is neutralised by a single command.
//
// Desktop hand-off: the desktop never holds the authoritative copy of a
// CLI-managed (microVM) credential. Its `sync_microvm_cluster` step —
// which runs on every status poll — compares the profile's `keyId`
// against the `synced_key_id` it last copied into the Keychain. A
// rotation changes `keyId`, so the next poll detects the mismatch and
// refreshes the Keychain entry (service `sh.appliance.desktop`, account
// `cluster:<id>`) from profiles.json. No desktop action is required;
// the rotated key propagates automatically. See packages/desktop/
// src-tauri/src/lib.rs (sync_microvm_cluster + mirror_to_shared_profiles).

const program = new Command();

attachProfileOption(program);

program.description('manage the cluster API key lifecycle (rotate)');

program
  .command('rotate')
  .description("re-mint the active profile's API key and revoke the old one")
  .action(async () => {
    const file = readProfiles();
    const resolved = resolveProfile(file, { override: getActiveProfileOverride() });
    if (!resolved) {
      console.error(chalk.red('Not logged in. Run `appliance login` to authenticate.'));
      console.error(chalk.dim('  (or pass --profile <name> to select a profile)'));
      process.exit(1);
    }

    const credentials = loadCredentials();
    if (!credentials) {
      console.error(chalk.red('Could not load credentials for the active profile.'));
      process.exit(1);
    }

    const { name: profileName, profile } = resolved;
    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
      product: 'cli',
    });

    console.log(`Rotating the API key for profile ${chalk.bold(profileName)} (${chalk.dim(credentials.apiUrl)}).`);
    // Never print the secret — only the id, which is safe to surface.
    console.log(chalk.dim(`  Current key: ${credentials.keyId}`));

    const result = await client.rotateKey();
    if (!result.success) {
      console.error(chalk.red(`Rotation failed: ${result.error.message}`));
      console.error(
        chalk.dim(
          'The previous key is unchanged and still valid. If the server returned 404, ' +
            'its api-server may predate `POST /api/v1/keys/rotate` — upgrade the api-server and retry.'
        )
      );
      process.exit(1);
    }

    const next = result.data;

    // Verify the freshly minted credential actually authenticates
    // *before* we overwrite the stored one. A failed verification here
    // means we'd be persisting a key we can't use — bail and leave the
    // old (now server-revoked) key in place so the operator can see the
    // problem rather than silently locking themselves out. The old key
    // is already revoked server-side, so re-running rotate is the fix.
    const verifyClient = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: next.id, secret: next.secret },
      product: 'cli',
    });
    const verify = await verifyClient.listProjects();
    if (!verify.success) {
      console.error(chalk.red(`New key minted but failed verification: ${verify.error.message}`));
      console.error(
        chalk.yellow(
          'The new key was NOT saved. Re-run `appliance keys rotate` — the previous key is already revoked, ' +
            'so a fresh rotation against the new key will recover access.'
        )
      );
      // Persist the new key anyway so the operator isn't stranded: the
      // old one is revoked, so the unsaved-but-valid id/secret is the
      // only working credential. Save it, then exit non-zero so the
      // failure is visible.
      persistRotatedCredential(profileName, profile, next);
      console.error(chalk.dim(`  (saved the new key to profile ${profileName} as a fallback)`));
      process.exit(1);
    }

    // Atomic swap: preserve every other field on the profile (apiUrl,
    // managed, stateBackendUrl, lastBootstrapInput, createdAt) and only
    // replace the credential material (Keychain-first on macOS).
    const { keychainWriteFailed } = persistRotatedCredential(profileName, profile, next);

    console.log();
    console.log(`${chalk.green('✓')} Rotated. Profile ${chalk.bold(profileName)} now uses key ${chalk.bold(next.id)}.`);
    console.log(chalk.dim('  The previous key has been revoked server-side.'));
    if (profile.managed !== 'cli') {
      if (keychainWriteFailed) {
        // Desktop-managed on macOS, but the canonical Keychain write failed
        // (the new key is only in profiles.json). The desktop reads the
        // Keychain, so it would keep using the old, server-revoked key with
        // no automatic recovery — say so instead of promising auto-pickup.
        console.log(
          chalk.yellow(
            '  Saved to profiles.json, but couldn’t update the macOS Keychain (access may have been denied). ' +
              'The desktop app may keep using the old key until you re-authenticate the cluster there ' +
              'or re-run `appliance keys rotate`.'
          )
        );
      } else {
        console.log(
          chalk.dim(
            '  The desktop app picks up the rotated key automatically on its next cluster sync ' + '(no action needed).'
          )
        );
      }
    }
  });

program.parse(process.argv);
