import { readFile } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vitest/config';

const rawYaml = (): Plugin => ({
  name: 'raw-cloudformation-yaml',
  enforce: 'pre',
  async load(id) {
    if (!id.endsWith('.yaml')) return null;
    return `export default ${JSON.stringify(await readFile(id, 'utf8'))};`;
  },
});

export default defineConfig({
  plugins: [rawYaml()],
  test: { environment: 'node' },
});
