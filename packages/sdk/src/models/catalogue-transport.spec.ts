import { expect, it, vi } from 'vitest';
import { fetchCataloguePair } from './catalogue-transport';
import { catalogueCutoverFloor, CatalogueTrustError, CATALOGUE_INDEX_MAX_BYTES } from './catalogue-trust';

const snapshot = 'a'.repeat(64);
const latest = () => new Response('{}\n', { headers: { 'X-Appliance-Catalogue-Snapshot': snapshot } });

it.each(['missing', 'mismatch'])('retries a complete latest pair exactly once on %s', async (failure) => {
  const fetcher = vi.fn(async () => latest());
  if (failure === 'missing')
    fetcher.mockResolvedValueOnce(latest()).mockResolvedValueOnce(new Response('', { status: 404 }));
  const verify = vi.fn(async () => 'verified');
  if (failure === 'mismatch') verify.mockRejectedValueOnce(new CatalogueTrustError('bad-signature', 'race'));
  await expect(
    fetchCataloguePair({ origin: 'https://example.test', role: 'index', fetch: fetcher, verify })
  ).resolves.toMatchObject({ verified: 'verified' });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[2]);
});

it('rejects untrusted snapshot links and malformed IDs without fetching them', async () => {
  for (const headers of [
    { 'X-Appliance-Catalogue-Snapshot': '../evil' },
    { 'X-Appliance-Catalogue-Snapshot': snapshot, Link: '<https://evil.test/signature>' },
  ]) {
    const fetcher = vi.fn(async () => new Response('{}', { headers }));
    await expect(
      fetchCataloguePair({ origin: 'https://example.test', role: 'index', fetch: fetcher, verify: async () => true })
    ).rejects.toThrow('Invalid catalogue');
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it('bounds streamed bytes before calling the verifier', async () => {
  const verify = vi.fn();
  const fetcher = vi.fn(
    async () =>
      new Response(new Uint8Array(CATALOGUE_INDEX_MAX_BYTES + 1), {
        headers: { 'X-Appliance-Catalogue-Snapshot': snapshot },
      })
  );
  await expect(
    fetchCataloguePair({ origin: 'https://example.test', role: 'index', fetch: fetcher, verify })
  ).rejects.toMatchObject({ code: 'oversize' });
  expect(verify).not.toHaveBeenCalled();
});

it('computes cutover above the reviewed legacy maximum and refuses unsafe inventory', () => {
  expect(catalogueCutoverFloor(1)).toBe(2);
  expect(catalogueCutoverFloor(202610030001)).toBe(202610030002);
  for (const value of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER]) expect(() => catalogueCutoverFloor(value)).toThrow();
});
