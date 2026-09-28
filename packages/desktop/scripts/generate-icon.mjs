#!/usr/bin/env node
// Shared brand sources → lockup, OG template, both shell favicons and Tauri icons.
// From the repo root: node packages/desktop/scripts/generate-icon.mjs
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const brand = resolve(root, 'packages/app/src/assets/brand');
const read = (name) => readFileSync(resolve(brand, name), 'utf8');
const contents = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const mark = contents(read('mark.svg'));
const small = contents(read('mark-small.svg'));
const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${body}</svg>\n`;
const tile = '<rect width="32" height="32" rx="7" fill="#171717"/>';
const favicon = svg(32, `${tile}${small}`);
const raster = (source, size) => new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();

// Keep the outlined Geist wordmark; refresh the mark from the one full-size source.
// Four units above the original placement optically balance the bottom-heavy A
// against Geist's cap band (y11.6–40), with room for the p descender.
const lockup = read('lockup.svg').replace(
  /<!-- brand-mark:start -->[\s\S]*?<!-- brand-mark:end -->/,
  `<!-- brand-mark:start --><g transform="translate(0 0) scale(1.5)">${mark}</g><!-- brand-mark:end -->`
);
writeFileSync(resolve(brand, 'lockup.svg'), lockup);
writeFileSync(
  resolve(brand, 'og-template.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#171717"/><g transform="translate(144 220) scale(3.6)">${contents(lockup)}</g><!-- Add outlined tagline paths inside this group; no font dependency. --><g id="tagline" transform="translate(144 470)" fill="#a3a3a3"/></svg>\n`
);

// Tiny PNG-compressed ICO with exactly the dedicated 16 and 32 pixel frames.
const frames = [16, 32].map((size) => ({ size, png: raster(favicon, size) }));
const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach(({ size, png }, index) => {
  const entry = 6 + index * 16;
  header[entry] = size;
  header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
for (const shell of ['desktop', 'console']) {
  const publicDir = resolve(root, `packages/${shell}/public`);
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(
    resolve(publicDir, 'favicon.svg'),
    svg(
      32,
      `${tile}<style>.full{display:none}@media(min-width:24px){.small{display:none}.full{display:inline}}</style><g class="small">${small}</g><g class="full">${mark}</g>`
    )
  );
  writeFileSync(resolve(publicDir, 'favicon.ico'), Buffer.concat([header, ...frames.map(({ png }) => png)]));
}
const desktop = resolve(root, 'packages/desktop');
const icons = resolve(desktop, 'src-tauri/icons');
const appIcon = svg(
  1024,
  `<rect x="2" y="2" width="28" height="28" rx="6.25" fill="#171717"/><g transform="translate(6 5) scale(.625)">${mark}</g>`
);
writeFileSync(resolve(icons, 'source.png'), raster(appIcon, 1024));
// Tauri also emits mobile assets; keep only this desktop package's platform set.
const output = mkdtempSync(resolve(tmpdir(), 'appliance-icons-'));
try {
  execFileSync('pnpm', ['exec', 'tauri', 'icon', 'src-tauri/icons/source.png', '--output', output], {
    cwd: desktop,
    stdio: 'inherit',
  });
  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (entry.isFile()) cpSync(resolve(output, entry.name), resolve(icons, entry.name));
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
