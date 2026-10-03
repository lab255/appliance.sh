import { CATALOGUE_INDEX_MAX_BYTES, CATALOGUE_BLACKLIST_MAX_BYTES, CatalogueTrustError } from './catalogue-trust';

/** Bound actual streamed bytes before JSON parsing, including both trailing newlines. */
async function readBounded(response: Response, remaining: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`catalogue request failed (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > remaining) throw new CatalogueTrustError('oversize', 'catalogue pair exceeds its byte cap');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Link fields may contain quoted commas (and commas inside URI references). */
function splitLinks(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let target = false;
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (!target && character === '"') quoted = !quoted;
    if (!quoted) {
      if (character === '<') target = true;
      else if (character === '>') target = false;
      else if (character === ',' && !target) {
        entries.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  entries.push(value.slice(start).trim());
  return entries;
}

/** Fetch immutable pairs, retrying the entire latest lookup once on 404 or signature mismatch. */
export async function fetchCataloguePair<T>(options: {
  origin: string;
  role: 'index' | 'blacklist';
  fetch?: typeof fetch;
  verify: (payloadBytes: Uint8Array, envelopeBytes: Uint8Array) => Promise<T>;
}): Promise<{ payloadBytes: Uint8Array; envelopeBytes: Uint8Array; verified: T }> {
  const fetcher = options.fetch ?? fetch;
  const payloadUrl = new URL(`/catalogue/${options.role}.json`, options.origin);
  const cap = options.role === 'index' ? CATALOGUE_INDEX_MAX_BYTES : CATALOGUE_BLACKLIST_MAX_BYTES;
  for (let attempt = 0; ; attempt++) {
    try {
      const payload = await fetcher(payloadUrl.href, { headers: { Accept: 'application/json' }, redirect: 'error' });
      if (!payload.ok) throw new Error(`catalogue request failed (${payload.status})`);
      const snapshot = payload.headers.get('X-Appliance-Catalogue-Snapshot');
      if (!snapshot || !/^[0-9a-f]{64}$/.test(snapshot)) throw new Error('Invalid catalogue snapshot identifier');
      const signatureUrl = new URL(`${payloadUrl.pathname}.sig`, payloadUrl);
      signatureUrl.searchParams.set('snapshot', snapshot);
      // Never follow an arbitrary Link target, even if a server supplies one.
      for (const link of splitLinks(payload.headers.get('Link') ?? '')) {
        const target = /^<([^>]+)>/.exec(link)?.[1];
        if (!target) continue;
        let linkedUrl: URL;
        try {
          linkedUrl = new URL(target, payloadUrl);
        } catch {
          continue;
        }
        // Platforms may append unrelated preload/early-hint links. Only the
        // canonical signature path makes a claim about this snapshot's pair.
        if (linkedUrl.pathname !== signatureUrl.pathname) continue;
        if (linkedUrl.href !== signatureUrl.href) throw new Error('Invalid catalogue signature link');
      }
      const payloadBytes = await readBounded(payload, cap);
      const signature = await fetcher(signatureUrl.href, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
      });
      if (signature.status === 404 && attempt === 0) {
        await signature.body?.cancel();
        continue;
      }
      const envelopeBytes = await readBounded(signature, cap - payloadBytes.byteLength);
      const verified = await options.verify(payloadBytes, envelopeBytes);
      return { payloadBytes, envelopeBytes, verified };
    } catch (error) {
      if (attempt === 0 && error instanceof CatalogueTrustError && error.code === 'bad-signature') continue;
      throw error;
    }
  }
}
