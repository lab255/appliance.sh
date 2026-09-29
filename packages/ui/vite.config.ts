import assert from 'node:assert/strict';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import preserveDirectives from 'rollup-plugin-preserve-directives';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)];

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    preserveDirectives(),
    {
      name: 'ui-css-assets',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const theme = readFileSync(new URL('./src/theme.css', import.meta.url), 'utf8');
        // This substitution is intentionally limited to one flat, self-contained
        // theme block. Imports or additional blocks need a real CSS transform.
        assert(
          /^\s*@theme static\s*\{[^{}@]*\}\s*$/.test(theme.replace(/\/\*[\s\S]*?\*\//g, '')),
          'tokens.css requires exactly one flat @theme static block without imports'
        );
        this.emitFile({ type: 'asset', fileName: 'theme.css', source: theme });
        this.emitFile({
          type: 'asset',
          fileName: 'tokens.css',
          source: theme.replace('@theme static', ':root'),
        });
        // Vite library mode inlines assets. Restore self-hosted font files so
        // consumers can cache them independently and enforce local font URLs.
        for (const asset of Object.values(bundle)) {
          if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) continue;
          asset.source = String(asset.source).replace(
            /data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g,
            (_url, data: string) => {
              const source = Buffer.from(data, 'base64');
              const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
              const fileName = `assets/${hash}.woff2`;
              this.emitFile({ type: 'asset', fileName, source });
              return `./${fileName}`;
            }
          );
        }
      },
    },
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: 'styles',
    },
    rollupOptions: {
      external: (id) => external.some((name) => id === name || id.startsWith(`${name}/`)),
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
        warn(warning);
      },
    },
    emptyOutDir: true,
  },
});
