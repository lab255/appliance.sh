import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import archiver from 'archiver';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSourceBundleForDeploy } from './deploy-core.js';
import { writeBundle } from './bundle-write.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('deploy bundle discrimination', () => {
  it('accepts an existing source bundle without changing a byte', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-source-'));
    dirs.push(dir);
    const bundle = path.join(dir, 'source.zip');
    const output = fs.createWriteStream(bundle);
    const archive = archiver('zip');
    const closed = new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
    });
    archive.pipe(output);
    archive.append(JSON.stringify({ manifest: 'v1', type: 'container', name: 'source' }), { name: 'appliance.json' });
    archive.append('FROM scratch', { name: 'Dockerfile' });
    await archive.finalize();
    await closed;
    const before = fs.readFileSync(bundle);
    expect(() => assertSourceBundleForDeploy(bundle)).not.toThrow();
    expect(fs.readFileSync(bundle)).toEqual(before);
  });

  it.each(['container', 'binary', 'compound'] as const)(
    'rejects a v2 %s runnable before the upload path',
    async (type) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-runnable-'));
      dirs.push(dir);
      const bundle = path.join(dir, `${type}.zip`);
      const branch =
        type === 'container'
          ? { payload: { images: { 'linux/amd64': { path: 'payload/image.tar' } } } }
          : type === 'binary'
            ? {
                payload: {
                  targets: {
                    'linux/amd64': { root: 'payload/bin', entrypoint: 'app', args: [] },
                  },
                },
              }
            : {
                services: {
                  worker: {
                    type: 'binary' as const,
                    payload: {
                      targets: {
                        'linux/amd64': { root: 'payload/bin', entrypoint: 'app', args: [] },
                      },
                    },
                  },
                },
              };
      await writeBundle({
        outputPath: bundle,
        manifest: {
          manifest: 'v2',
          kind: 'runnable',
          type,
          name: `test-${type}`,
          version: '1.0.0',
          license: 'MIT',
          publisher: { name: 'Test' },
          ...branch,
        },
        files:
          type === 'container'
            ? [{ path: 'payload/image.tar', data: Buffer.from('tar') }]
            : [{ path: 'payload/bin/app', data: Buffer.from('binary') }],
      });
      expect(() => assertSourceBundleForDeploy(bundle)).toThrow(
        'runnable bundles deploy via the runtime; use appliance runtime run/install'
      );
    }
  );
});
