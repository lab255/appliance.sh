import { Command } from 'commander';
import { ableAccount, ableAccountStatusJson } from '@appliance.sh/helper';

const program = new Command().description(
  'optional able identity shared with Appliance Desktop; no login is required to run apps'
);
for (const action of ['sign-in', 'status', 'refresh', 'sign-out'] as const) {
  const name = action === 'sign-in' ? 'login' : action === 'sign-out' ? 'logout' : action;
  const command = program.command(name).description(
    {
      'sign-in': 'sign in with able in the system browser on this host',
      status: 'show the current account without exposing credentials',
      refresh: 'refresh an expiring able session',
      'sign-out': 'sign out CLI and desktop on this host',
    }[action]
  );
  if (name !== action) command.alias(action);
  if (action === 'sign-in') command.option('--switch-account', 'confirm replacing the current able account');
  if (action === 'status') command.option('--json', 'print the native helper status JSON verbatim');
  command.action(async (options: { switchAccount?: boolean; json?: boolean }) => {
    try {
      if (action === 'status' && options.json) {
        process.stdout.write(await ableAccountStatusJson());
        return;
      }
      if (action === 'sign-in')
        console.log(
          'Opening your browser. Sign-in expires after five minutes. You can keep using Appliance without an account.'
        );
      const status = await ableAccount(action, options.switchAccount);
      console.log(
        status.signedIn
          ? `Signed in with able as ${status.email}.`
          : 'Signed out. Local apps and grants remain available.'
      );
      if (status.revocationFailed)
        console.log('Credentials erased from this host. able could not confirm upstream revocation.');
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Account operation failed.');
      process.exitCode = 1;
    }
  });
}
program.parse();
