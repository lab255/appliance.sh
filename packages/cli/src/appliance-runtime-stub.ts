// Temporary shared implementation for Appliance Runtime verbs. Keeping the
// placeholder isolated makes each verb straightforward to replace as the real
// runtime lands without disturbing the umbrella dispatcher.

export function runRuntimeStub(
  verb: string,
  help = process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')
): never {
  const message = `appliance runtime ${verb}: coming in a later release`;
  if (help) {
    console.log(message);
    process.exit(0);
  }
  console.error(message);
  process.exit(2);
}
