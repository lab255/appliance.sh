import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginReact from 'eslint-plugin-react';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'react/react-in-jsx-scope': 'off',
    },
  },
  tseslint.configs.recommended,
  pluginReact.configs.flat['jsx-runtime'],
  globalIgnores([
    // Build outputs. The double-glob form catches nested `dist/` dirs
    // too (e.g. packages/desktop/sidecar/dist/), which the previous
    // `packages/*/dist/**/*` glob missed by being one level too shallow.
    '**/dist/**',
    '**/examples/**',
    // Rust build artifacts under src-tauri/target/ include generated
    // .js shims (e.g. __global-api-script.js) that eslint can't parse.
    '**/target/**',
    // Staged docker build context (gitignored): carries a prebuilt
    // console bundle that would drown `eslint .` in generated-code
    // errors on any machine that has run the docker prep.
    '**/.docker-deps/**',
    '.nx/cache/**/*', // ignore all files cached by the Nx build system
  ]),
]);
