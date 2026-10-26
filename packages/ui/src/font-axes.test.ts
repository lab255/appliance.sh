import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { openSync } = require('fontkit');
const cssPath = require.resolve('@fontsource-variable/inter/standard.css');
const css = readFileSync(cssPath, 'utf8');
const fonts = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((match) => match[1]);

describe('offline Inter full-axis font files', () => {
  it('imports the full-axis variant into the shared stylesheet', () => {
    const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(styles).toContain("@import '@fontsource-variable/inter/standard.css'");
    expect(fonts).toHaveLength(7);
    expect(css).toContain('font-weight: 100 900');
  });

  it.each(fonts)('%s exposes optical size and the full weight range', (file) => {
    const axes = openSync(resolve(dirname(cssPath), file)).variationAxes;
    console.log(`${file}: fvar ${JSON.stringify(axes)}`);
    expect(axes.wght).toMatchObject({ min: 100, default: 400, max: 900 });
    expect(axes.opsz).toMatchObject({ min: 14, default: 14, max: 32 });
  });
});
