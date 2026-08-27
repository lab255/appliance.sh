// Temporary shared implementation for Appliance Runtime verbs. Keeping the
// placeholder isolated makes each verb straightforward to replace as the real
// runtime lands without disturbing the umbrella dispatcher.

export function runRuntimeStub(verb: string): never {
  console.error(`appliance runtime ${verb}: coming in a later release`);
  process.exit(2);
}
