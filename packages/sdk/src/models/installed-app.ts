import { z } from 'zod';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const keyIdSchema = z.string().regex(/^ed25519:sha256:[0-9a-f]{64}$/);
const rfc3339Schema = z.iso.datetime({ offset: true });

export const installedAppControlsSummarySchema = z.strictObject({
  egressHosts: z.array(z.string()).default([]),
  mounts: z.array(
    z.strictObject({
      name: z.string(),
      source: z.enum(['volume', 'host']),
      guest: z.string(),
      readOnly: z.boolean(),
    })
  ),
  publishedPorts: z.array(
    z.strictObject({
      name: z.string(),
      guest: z.number().int().min(1).max(65535),
      protocol: z.enum(['tcp', 'udp']),
    })
  ),
  resources: z.strictObject({
    cpus: z.number().int().positive().optional(),
    memoryMib: z.number().int().positive().optional(),
    diskGib: z.number().int().positive().optional(),
  }),
  serviceCount: z.number().int().positive(),
  serviceNames: z.array(z.string()).default([]),
});

export const installedAppSchema = z.strictObject({
  appId: z.string().min(1).max(160),
  version: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  license: z.string().min(1).max(160),
  publisher: z.strictObject({
    name: z.string().min(1).max(160),
    keyId: keyIdSchema.optional(),
    tier: z.enum(['first-party', 'verified-account', 'known-publisher', 'unknown']),
  }),
  digest: digestSchema,
  bundlePath: z.string().min(1),
  installedAt: rfc3339Schema,
  source: z.union([
    z.literal('file'),
    z.url().refine((value) => new URL(value).protocol === 'https:', 'catalogue source must use HTTPS'),
  ]),
  verification: z.strictObject({
    signature: z.enum(['valid', 'unsigned', 'invalid']),
    indexBound: z.strictObject({ generation: z.number().int().nonnegative() }).optional(),
  }),
  controlsSummary: installedAppControlsSummarySchema,
  lastWarnedAt: rfc3339Schema.optional(),
});

export const installedAppsStoreSchema = z.strictObject({
  schema: z.literal('appliance.installed-apps/v1'),
  apps: z.array(installedAppSchema),
});

export type InstalledAppControlsSummary = z.infer<typeof installedAppControlsSummarySchema>;
export type InstalledApp = z.infer<typeof installedAppSchema>;
export type InstalledAppsStore = z.infer<typeof installedAppsStoreSchema>;
