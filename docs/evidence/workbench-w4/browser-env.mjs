import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const required = ['PLAYWRIGHT_MODULE', 'CHROMIUM_PATH', 'W4_BASE_URL'];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length)
  throw new Error(
    `Missing required evidence configuration: ${missing.join(', ')}. Set all three variables; no personal paths or server port are assumed.`
  );
const modulePath = process.env.PLAYWRIGHT_MODULE;
export const chromiumPath = process.env.CHROMIUM_PATH;
const base = new URL(process.env.W4_BASE_URL);
if (!['http:', 'https:'].includes(base.protocol)) throw new Error('W4_BASE_URL must be an HTTP(S) fixture-server URL.');
if (!base.pathname.endsWith('/')) base.pathname += '/';
export const fixtureUrl = (query = '') => new URL(`sessions-audit.html${query}`, base).href;
export const { chromium } = await import(isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
