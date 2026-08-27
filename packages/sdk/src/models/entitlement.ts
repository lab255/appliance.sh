import { z } from 'zod';

const rfc3339Schema = z.iso.datetime({ offset: true });
const keyIdSchema = z.string().regex(/^ed25519:sha256:[0-9a-f]{64}$/);

export const entitlementSignatureSchema = z.strictObject({
  alg: z.literal('ed25519'),
  keyId: keyIdSchema,
  role: z.literal('entitlement'),
  sig: z.string().regex(/^[A-Za-z0-9_-]+$/),
});

const grantBase = {
  id: z.string().min(1).max(512),
  approvedAt: rfc3339Schema,
};

export const entitlementGrantSchema = z.discriminatedUnion('control', [
  z.strictObject({
    ...grantBase,
    control: z.literal('egress-host'),
    value: z.strictObject({
      host: z.string().min(1).max(253),
      ports: z.array(z.number().int().min(1).max(65535)).min(1),
    }),
  }),
  z.strictObject({
    ...grantBase,
    control: z.literal('mount'),
    value: z.strictObject({
      name: z.string().min(1).max(160),
      source: z.enum(['volume', 'host']),
      guest: z.string().min(1),
      access: z.enum(['read-only', 'read-write']),
    }),
  }),
  z.strictObject({
    ...grantBase,
    control: z.literal('published-port'),
    value: z.strictObject({
      name: z.string().min(1).max(160),
      guest: z.number().int().min(1).max(65535),
      protocol: z.enum(['tcp', 'udp']),
    }),
  }),
  z.strictObject({
    ...grantBase,
    control: z.literal('resources'),
    value: z.strictObject({
      cpus: z.number().int().positive().optional(),
      memoryMib: z.number().int().positive().optional(),
      diskGib: z.number().int().positive().optional(),
    }),
  }),
]);

export const entitlementUsageSchema = z.strictObject({
  lastUsedAt: rfc3339Schema,
  useCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const entitlementRecordPayloadSchema = z.strictObject({
  appId: z.string().min(1).max(160),
  version: z.string().min(1).max(160),
  license: z.string().min(1).max(160),
  grantedAt: rfc3339Schema,
  installerId: z.string().min(1).max(256),
  state: z.enum(['installed', 'uninstalled']).default('installed'),
  uninstalledAt: rfc3339Schema.optional(),
  grants: z.array(entitlementGrantSchema),
  usage: z.record(z.string(), entitlementUsageSchema),
});

export const entitlementRecordSchema = entitlementRecordPayloadSchema.extend({
  signature: entitlementSignatureSchema,
});

export const entitlementStoreSchema = z.strictObject({
  schema: z.literal('appliance.entitlements/v1'),
  revision: z.number().int().nonnegative(),
  devicePublicKey: z.string().regex(/^ed25519:[A-Za-z0-9_-]+$/),
  records: z.array(entitlementRecordSchema),
});

export type EntitlementGrant = z.infer<typeof entitlementGrantSchema>;
export type EntitlementUsage = z.infer<typeof entitlementUsageSchema>;
export type EntitlementRecordPayload = z.infer<typeof entitlementRecordPayloadSchema>;
export type EntitlementRecord = z.infer<typeof entitlementRecordSchema>;
export type EntitlementStore = z.infer<typeof entitlementStoreSchema>;

export interface EntitlementSuggestion {
  appId: string;
  version: string;
  license: string;
  grant: EntitlementGrant;
  lastUsedAt?: string;
  reason: 'never-used' | 'unused';
  revokeCommand: string;
}
