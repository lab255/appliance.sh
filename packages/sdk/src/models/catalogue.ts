import { z } from 'zod';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const keyId = z.string().regex(/^ed25519:sha256:[0-9a-f]{64}$/);
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const rfc3339 = z.iso.datetime({ offset: true });

export const cataloguePublisherSchema = z
  .strictObject({
    name: z.string().min(1).max(100),
    tier: z.enum(['first-party', 'known', 'unknown']),
    keyId: keyId.optional(),
    publicKey: z
      .string()
      .regex(/^ed25519:[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .refine(
    (publisher) => !publisher.keyId || publisher.publicKey,
    'publisher publicKey is required when keyId is present'
  );

export const catalogueEntrySchema = z.strictObject({
  appId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  license: z.string().min(1).max(100),
  paid: z.boolean(),
  categories: z.array(z.string().min(1).max(50)).max(20).default([]),
  bundle: z.strictObject({
    url: z
      .url()
      .startsWith('https://')
      .refine((value) => {
        try {
          const url = new URL(value);
          return !url.username && !url.password;
        } catch {
          return false;
        }
      }, 'bundle URL must not contain credentials'),
    digest,
  }),
  publisher: cataloguePublisherSchema,
});

function withValidityCap<T extends z.ZodType<{ issuedAt: string; expiresAt: string }>>(schema: T, days: number) {
  return schema.superRefine((value, context) => {
    const span = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
    if (span <= 0 || span > days * 24 * 60 * 60 * 1000) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: `validity must be positive and at most ${days} days`,
      });
    }
  });
}

export const catalogueIndexSchema = withValidityCap(
  z.strictObject({
    schema: z.literal('appliance.catalogue-index/v1'),
    generation: z.int().positive(),
    issuedAt: rfc3339,
    expiresAt: rfc3339,
    entries: z.array(catalogueEntrySchema).max(10_000),
  }),
  14
);

const blacklistEntrySchema = z
  .strictObject({
    digest: digest.optional(),
    appId: z.string().min(1).max(200).optional(),
    publisherKeyId: keyId.optional(),
    version: z.string().min(1).max(100).optional(),
    reason: z.enum(['malware', 'compromised', 'key-compromise', 'withdrawn']),
  })
  .refine((entry) => Boolean(entry.digest || entry.appId || entry.publisherKeyId), 'a blacklist selector is required');

export const catalogueBlacklistSchema = withValidityCap(
  z.strictObject({
    schema: z.literal('appliance.blacklist/v1'),
    generation: z.int().positive(),
    issuedAt: rfc3339,
    expiresAt: rfc3339,
    entries: z.array(blacklistEntrySchema).max(10_000),
  }),
  7
);

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
