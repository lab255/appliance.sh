import { z } from 'zod';

const dnsLabel = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const semver = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const keyId = z.string().regex(/^ed25519:sha256:[0-9a-f]{64}$/);
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const rfc3339 = z.iso.datetime({ offset: true });

export const cataloguePublisherSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  keyId: keyId.optional(),
});

export const catalogueEntrySchema = z.strictObject({
  id: dnsLabel,
  name: z.string().trim().min(1).max(120),
  version: semver,
  description: z.string().trim().min(1).max(500),
  license: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-.+]+$/),
  publisher: cataloguePublisherSchema,
  tier: z.enum(['first-party', 'verified-account', 'known-publisher']),
  url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.port === '' &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.appliance\.zip$/.test(url.hostname)
    );
  }, 'must be an HTTPS appliance.zip host'),
  digest,
  paid: z.boolean().optional(),
  icon: z.url().optional(),
  category: z.enum(['Productivity', 'Media', 'Data', 'Dev tools']).optional(),
});

export const catalogueIndexSchema = z.strictObject({
  schema: z.literal('appliance.catalogue-index/v1'),
  generation: z.number().int().nonnegative(),
  issuedAt: rfc3339,
  expiresAt: rfc3339,
  entries: z.array(catalogueEntrySchema).max(10_000),
});

const blacklistEntrySchema = z
  .strictObject({
    digest: digest.optional(),
    appId: dnsLabel.optional(),
    publisherKeyId: keyId.optional(),
    version: z.string().trim().min(1).optional(),
    reason: z.enum(['malware', 'compromised', 'key-compromise']),
  })
  .refine((entry) => Boolean(entry.digest || entry.appId || entry.publisherKeyId), 'a blacklist selector is required');

export const catalogueBlacklistSchema = z.strictObject({
  schema: z.literal('appliance.blacklist/v1'),
  generation: z.number().int().nonnegative(),
  issuedAt: rfc3339,
  expiresAt: rfc3339,
  entries: z.array(blacklistEntrySchema).max(10_000),
});

export const signatureEnvelopeSchema = z.strictObject({
  alg: z.literal('ed25519'),
  keyId,
  role: z.enum([
    'bundle',
    'index',
    'blacklist',
    'delegation',
    'revocation',
    'entitlement',
    'sync',
    'control-plane-release',
  ]),
  sig: base64url,
});

export type CataloguePublisher = z.infer<typeof cataloguePublisherSchema>;
export type CatalogueEntry = z.infer<typeof catalogueEntrySchema>;
export type CatalogueIndex = z.infer<typeof catalogueIndexSchema>;
export type CatalogueBlacklist = z.infer<typeof catalogueBlacklistSchema>;
export type SignatureEnvelope = z.infer<typeof signatureEnvelopeSchema>;
