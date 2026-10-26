import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spring } from '../src/lib/springs.ts';

// Kept at the existing build entry point, but no longer generates JS tokens:
// theme.css owns CSS durations/eases; springs.ts owns JS spring/tween shapes.
// Only duration parity crosses the lanes. CSS never receives spring physics.
const theme = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
const milliseconds = (name) => {
  const value = theme.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
  assert(value && /^\d+ms$/.test(value), `Expected milliseconds: ${name}`);
  return Number(value.slice(0, -2));
};
for (const [cssTier, jsTier] of [
  ['fast', 'fast'],
  ['base', 'moderate'],
  ['slow', 'slow'],
]) {
  assert.equal(milliseconds(`duration-${cssTier}`) / 1000, spring[jsTier].duration, `${cssTier} enter drift`);
  assert.equal(milliseconds(`duration-${cssTier}-exit`) / 1000, spring[jsTier].exit.duration, `${cssTier} exit drift`);
}
