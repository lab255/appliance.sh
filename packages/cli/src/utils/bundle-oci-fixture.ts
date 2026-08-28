import { createHash } from 'node:crypto';

/** Tiny valid OCI image-layout tar generated entirely in memory for tests. */
export function tinyOciTar(platform = 'linux/amd64', includeDirectories = false): Buffer {
  const [os, architecture, variant] = platform.split('/');
  const config = Buffer.from(JSON.stringify({ architecture, os, ...(variant ? { variant } : {}), config: {} }));
  const configDigest = sha256(config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: `sha256:${configDigest}`,
        size: config.length,
      },
      layers: [],
    })
  );
  const manifestDigest = sha256(manifest);
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${manifestDigest}`,
          size: manifest.length,
          platform: { architecture, os, ...(variant ? { variant } : {}) },
        },
      ],
    })
  );
  return makeTar([
    ...(includeDirectories
      ? ([
          ['blobs/', Buffer.alloc(0), true],
          ['blobs/sha256/', Buffer.alloc(0), true],
        ] as Array<[string, Buffer, boolean]>)
      : []),
    ['oci-layout', Buffer.from('{"imageLayoutVersion":"1.0.0"}')],
    ['index.json', index],
    [`blobs/sha256/${manifestDigest}`, manifest],
    [`blobs/sha256/${configDigest}`, config],
  ]);
}

function makeTar(entries: Array<[string, Buffer, boolean?]>): Buffer {
  const chunks: Buffer[] = [];
  for (const [entryPath, data, directory = false] of entries) {
    const header = Buffer.alloc(512);
    header.write(entryPath, 0, 100, 'utf8');
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = directory ? 0x35 : 0x30;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, '0');
    header.write(checksumText, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  buffer.write(text, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
