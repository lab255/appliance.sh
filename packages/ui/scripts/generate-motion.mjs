import { format } from 'prettier';
import { readFileSync, writeFileSync } from 'node:fs';

export function motionTokens(theme) {
  const value = (name) => {
    const match = theme.match(new RegExp(`--${name}:\\s*([^;]+);`));
    if (!match) throw new Error(`Missing motion token: ${name}`);
    return match[1].trim();
  };
  const seconds = (name) => {
    const css = value(name);
    if (!/^\d+ms$/.test(css)) throw new Error(`Expected milliseconds: ${name}`);
    return Number(css.slice(0, -2)) / 1000;
  };
  const bezier = (name) => {
    const match = value(name).match(/^cubic-bezier\(([^)]+)\)$/);
    const values = match?.[1].split(',').map(Number);
    if (!values || values.length !== 4 || values.some((v) => !Number.isFinite(v)))
      throw new Error(`Invalid easing: ${name}`);
    return values;
  };
  return {
    fast: seconds('duration-fast'),
    base: seconds('duration-base'),
    slow: seconds('duration-slow'),
    outQuart: bezier('ease-out-quart'),
    inOut: bezier('ease-in-out'),
  };
}
const theme = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
writeFileSync(
  new URL('../src/motion/tokens.ts', import.meta.url),
  await format(
    `// Generated from theme.css by scripts/generate-motion.mjs.\nexport const motionTokens = ${JSON.stringify(motionTokens(theme), null, 2)} as const;\n`,
    { parser: 'typescript', singleQuote: true }
  )
);
