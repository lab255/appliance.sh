import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applianceV2Input } from '@appliance.sh/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { packageRunnableAppliance } from './build-package.js';
import { unpackBundle, verifyBundle } from './bundle-read.js';
import { tinyOciTar } from './bundle-oci-fixture.js';

const dirs: string[] = [];

function projectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-package-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runnable payload packaging', () => {
  it('copies prebuilt Linux binary roots without compiling', async () => {
    const dir = projectDir();
    fs.mkdirSync(path.join(dir, 'payload/tool/linux-amd64/bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'payload/tool/linux-amd64/bin/tool'), '#!/bin/sh\necho tool\n');
    const manifest = applianceV2Input.parse({
      manifest: 'v2',
      kind: 'runnable',
      type: 'binary',
      name: 'binary-tool',
      version: '1.0.0',
      license: 'MIT',
      publisher: { name: 'Fixture' },
      payload: {
        targets: {
          'linux/amd64': {
            root: 'payload/tool/linux-amd64',
            entrypoint: 'bin/tool',
          },
        },
      },
    });
    const outputPath = path.join(dir, 'binary.appliance.zip');
    await packageRunnableAppliance({ manifest, projectDir: dir, outputPath });
    expect(verifyBundle(outputPath).manifest.type).toBe('binary');
    const unpacked = path.join(dir, 'unpacked');
    unpackBundle(outputPath, unpacked);
    expect(fs.readFileSync(path.join(unpacked, 'payload/tool/linux-amd64/bin/tool'), 'utf8')).toContain('echo tool');
  });

  it('collects compound container and nested binary leaves into one payload tree', async () => {
    const dir = projectDir();
    const tarPath = path.join(dir, 'web-test.tar');
    fs.writeFileSync(tarPath, tinyOciTar());
    fs.mkdirSync(path.join(dir, 'payload/worker/bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'payload/worker/bin/worker'), 'worker');
    const manifest = applianceV2Input.parse({
      manifest: 'v2',
      kind: 'runnable',
      type: 'compound',
      name: 'compound-test',
      version: '1.0.0',
      license: 'MIT',
      publisher: { name: 'Fixture' },
      services: {
        group: {
          type: 'compound',
          services: {
            web: {
              type: 'container',
              payload: { images: { 'linux/amd64': { path: 'payload/web/web.oci.tar' } } },
            },
            worker: {
              type: 'binary',
              payload: {
                targets: {
                  'linux/amd64': { root: 'payload/worker', entrypoint: 'bin/worker' },
                },
              },
            },
          },
        },
      },
    });
    const outputPath = path.join(dir, 'compound.appliance.zip');
    await packageRunnableAppliance({
      manifest,
      projectDir: dir,
      outputPath,
      images: [`payload/web/web.oci.tar=${tarPath}`],
    });
    const verified = verifyBundle(outputPath);
    expect(verified.manifest.type).toBe('compound');
  });

  it.each(['missing.tar', 'images/missing', 'images\\missing'])(
    'treats a missing path-shaped --image value as a tar error: %s',
    async (image) => {
      const dir = projectDir();
      const manifest = applianceV2Input.parse({
        manifest: 'v2',
        kind: 'runnable',
        type: 'container',
        name: 'missing-image',
        version: '1.0.0',
        license: 'MIT',
        publisher: { name: 'Fixture' },
        payload: { images: { 'linux/amd64': { path: 'payload/image.oci.tar' } } },
      });

      await expect(
        packageRunnableAppliance({
          manifest,
          projectDir: dir,
          outputPath: path.join(dir, 'missing.appliance.zip'),
          images: [image],
        })
      ).rejects.toThrow(`image tar not found: ${image}`);
    }
  );

  it('reports when docker is not installed for an image reference', async () => {
    const dir = projectDir();
    const emptyPath = path.join(dir, 'empty-path');
    fs.mkdirSync(emptyPath);
    const manifest = applianceV2Input.parse({
      manifest: 'v2',
      kind: 'runnable',
      type: 'container',
      name: 'missing-docker',
      version: '1.0.0',
      license: 'MIT',
      publisher: { name: 'Fixture' },
      payload: { images: { 'linux/amd64': { path: 'payload/image.oci.tar' } } },
    });
    const previousPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      await expect(
        packageRunnableAppliance({
          manifest,
          projectDir: dir,
          outputPath: path.join(dir, 'missing-docker.appliance.zip'),
          images: ['fixture:latest'],
        })
      ).rejects.toThrow('docker is not installed or not on PATH');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
