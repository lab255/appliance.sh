import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.mjs'],
    environment: 'node',
    // The sandbox loads the QuickJS WASM module the first time it runs;
    // the cold start can take a second or two on slower machines.
    testTimeout: 15000,
  },
});
