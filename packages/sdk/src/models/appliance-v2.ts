import { z } from 'zod';
import spdxLicenseIds from 'spdx-license-ids';

const dnsLabel = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Must be a lowercase DNS label');

const semver = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    'Must be a valid SemVer version'
  );

const spdxIds = new Set<string>(spdxLicenseIds);
const spdxLicenseId = z.string().refine((value) => spdxIds.has(value), 'Must be a current SPDX license ID');
const portNumber = z.number().int().min(1).max(65535);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Must be a POSIX-like environment variable name');
const linuxPlatform = z.string().regex(/^linux\/[a-z0-9][a-z0-9._-]*$/, 'Must be a Linux OCI platform');
const macosPlatform = z.enum(['macos/amd64', 'macos/arm64']);
const keyId = z.string().regex(/^ed25519:sha256:[0-9a-f]{64}$/, 'Must be an Ed25519 SHA-256 key ID');

function isNormalizedRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function relativePathUnder(root: string) {
  return z
    .string()
    .refine(isNormalizedRelativePath, 'Must be a normalized bundle-relative path')
    .refine((value) => value.startsWith(`${root}/`), `Must be under ${root}/`);
}

const entrypointPath = z.string().refine(isNormalizedRelativePath, 'Must be a normalized path relative to target root');

const absoluteUrlPath = z
  .string()
  .startsWith('/')
  .refine(
    (value) => !value.startsWith('//') && !/[?#]/.test(value),
    'Must be an absolute URL path without authority, query, or fragment'
  );

const absoluteLinuxPath = z
  .string()
  .startsWith('/')
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes('\0') &&
      value !== '/' &&
      value
        .split('/')
        .slice(1)
        .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'Must be a normalized absolute Linux path'
  );

export const applianceV2PublisherInput = z
  .object({
    name: z.string().min(1).max(100),
    keyId: keyId.optional(),
  })
  .strict();

export const applianceV2AssetsInput = z
  .object({
    icon: relativePathUnder('assets')
      .refine((value) => /\.(?:png|jpe?g|webp)$/i.test(value), 'Icon must be PNG, JPEG, or WebP')
      .optional(),
    readme: relativePathUnder('assets')
      .refine((value) => /\.md$/i.test(value), 'Readme must be Markdown')
      .optional(),
  })
  .strict();

const applianceV2WebUiInput = z
  .object({
    type: z.literal('web'),
    port: dnsLabel,
    service: dnsLabel.optional(),
    path: absoluteUrlPath.optional().default('/'),
  })
  .strict();

const applianceV2NativeUiInput = z.object({ type: z.literal('native') }).strict();

export const applianceV2UiInput = z.discriminatedUnion('type', [applianceV2WebUiInput, applianceV2NativeUiInput]);

export const applianceV2BinaryTargetInput = z
  .object({
    root: relativePathUnder('payload'),
    entrypoint: entrypointPath,
    args: z.array(z.string()).optional().default([]),
  })
  .strict();

function nonEmptyRecord<T extends z.ZodType>(key: z.ZodType<string>, value: T, message: string) {
  return z.record(key, value).refine((record) => Object.keys(record).length > 0, message);
}

export const applianceV2NativeMacosInput = z
  .object({
    unsandboxed: z.literal(true),
    targets: z
      .partialRecord(macosPlatform, applianceV2BinaryTargetInput)
      .refine((record) => Object.keys(record).length > 0, 'At least one macOS target is required'),
  })
  .strict();

const applianceV2NativeInput = z.object({ macos: applianceV2NativeMacosInput.optional() }).strict();

const applianceV2ContainerImageInput = z.object({ path: relativePathUnder('payload') }).strict();

export const applianceV2ContainerPayloadInput = z
  .object({
    images: nonEmptyRecord(linuxPlatform, applianceV2ContainerImageInput, 'At least one Linux image is required'),
  })
  .strict();

export const applianceV2BinaryPayloadInput = z
  .object({
    targets: nonEmptyRecord(linuxPlatform, applianceV2BinaryTargetInput, 'At least one Linux target is required'),
  })
  .strict();

// This intentionally small denylist covers the RFC examples and common public
// suffixes; adopting the full Public Suffix List is deferred until it can be
// shipped and updated without adding network-dependent validation.
const publicSuffixes = new Set([
  'com',
  'net',
  'org',
  'edu',
  'gov',
  'mil',
  'io',
  'dev',
  'app',
  'co.uk',
  'org.uk',
  'com.au',
  'co.jp',
]);

const egressHost = z.string().refine((value) => {
  const host = value.startsWith('*.') ? value.slice(2) : value;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) return false;
  if (!host.includes('.') || publicSuffixes.has(host)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return false;
  return host.split('.').every((label) => dnsLabel.safeParse(label).success);
}, 'Must be a lowercase DNS host (optionally *.) and not an IP literal or public suffix');

export const applianceV2EgressRuleInput = z
  .object({
    host: egressHost,
    ports: z
      .array(portNumber)
      .min(1)
      .refine((ports) => new Set(ports).size === ports.length, 'Ports must be unique'),
  })
  .strict();

export const applianceV2NetworkInput = z.object({ egress: z.array(applianceV2EgressRuleInput).optional() }).strict();

const applianceV2VolumeMountInput = z
  .object({
    name: dnsLabel,
    source: z.literal('volume'),
    guest: absoluteLinuxPath,
    readOnly: z.boolean(),
  })
  .strict();

const applianceV2HostMountInput = z
  .object({
    name: dnsLabel,
    source: z.literal('host'),
    guest: absoluteLinuxPath,
    readOnly: z.boolean(),
    suggestedPath: z.string().min(1).optional(),
  })
  .strict();

export const applianceV2MountInput = z.discriminatedUnion('source', [
  applianceV2VolumeMountInput,
  applianceV2HostMountInput,
]);

export const applianceV2PortInput = z
  .object({
    name: dnsLabel,
    guest: portNumber,
    protocol: z.enum(['tcp', 'udp']),
    expose: z.enum(['host', 'internal']),
    primary: z.boolean().optional(),
  })
  .strict();

export const applianceV2ResourcesInput = z
  .object({
    cpus: z.number().int().min(1).max(32).optional(),
    memoryMib: z.number().int().min(512).max(65536).optional(),
    diskGib: z.number().int().min(1).max(1024).optional(),
  })
  .strict();

const healthTimingShape = {
  intervalSeconds: z.number().int().min(1).max(300).optional().default(5),
  timeoutSeconds: z.number().int().min(1).max(60).optional().default(2),
  failureThreshold: z.number().int().min(1).max(20).optional().default(3),
};

export const applianceV2HealthInput = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('http'), port: dnsLabel, path: absoluteUrlPath, ...healthTimingShape }).strict(),
    z.object({ type: z.literal('tcp'), port: dnsLabel, ...healthTimingShape }).strict(),
    z.object({ type: z.literal('exec'), command: z.array(z.string()).min(1), ...healthTimingShape }).strict(),
  ])
  .refine((health) => health.timeoutSeconds <= health.intervalSeconds, {
    message: 'Health timeoutSeconds must not exceed intervalSeconds',
    path: ['timeoutSeconds'],
  });

export const applianceV2RestartInput = z
  .object({
    policy: z.enum(['never', 'on-failure', 'always']).optional().default('on-failure'),
    maxAttempts: z.number().int().min(0).max(100).optional().default(5),
    backoffSeconds: z.number().int().min(1).max(60).optional().default(2),
  })
  .strict();

const commonRuntimeShape = {
  native: applianceV2NativeInput.optional(),
  platforms: z
    .array(z.enum(['ios', 'android']))
    .optional()
    .default([]),
  env: z
    .record(envName, z.string())
    .refine((env) => Object.keys(env).every((name) => !name.startsWith('APPLIANCE_SVC_')), {
      message: 'APPLIANCE_SVC_ environment names are reserved',
    })
    .optional()
    .default({}),
  network: applianceV2NetworkInput.optional(),
  mounts: z.array(applianceV2MountInput).optional(),
  ports: z.array(applianceV2PortInput).optional(),
  resources: applianceV2ResourcesInput.optional(),
};

const serviceBaseShape = {
  version: semver.optional(),
  isolation: z.enum(['shared', 'vm']).optional(),
};

const serviceLifecycleShape = {
  dependsOn: z.array(dnsLabel).optional().default([]),
  health: applianceV2HealthInput.optional(),
  restart: applianceV2RestartInput.optional().default({ policy: 'on-failure', maxAttempts: 5, backoffSeconds: 2 }),
  required: z.boolean().optional().default(true),
};

const applianceV2ContainerServiceInput = z
  .object({
    type: z.literal('container'),
    ...serviceBaseShape,
    ...commonRuntimeShape,
    ...serviceLifecycleShape,
    payload: applianceV2ContainerPayloadInput,
  })
  .strict();

const applianceV2BinaryServiceInput = z
  .object({
    type: z.literal('binary'),
    ...serviceBaseShape,
    ...commonRuntimeShape,
    ...serviceLifecycleShape,
    payload: applianceV2BinaryPayloadInput,
  })
  .strict();

type ContainerService = z.output<typeof applianceV2ContainerServiceInput>;
type BinaryService = z.output<typeof applianceV2BinaryServiceInput>;
type ContainerServiceInput = z.input<typeof applianceV2ContainerServiceInput>;
type BinaryServiceInput = z.input<typeof applianceV2BinaryServiceInput>;
type CompoundService = {
  type: 'compound';
  version?: string;
  isolation?: 'shared' | 'vm';
  services: Record<string, ApplianceV2Service>;
};
type CompoundServiceInput = {
  type: 'compound';
  version?: string;
  isolation?: 'shared' | 'vm';
  services: Record<string, ApplianceV2ServiceSchemaInput>;
};
type ApplianceV2ServiceSchemaInput = ContainerServiceInput | BinaryServiceInput | CompoundServiceInput;

export const applianceV2ServiceInput: z.ZodType<
  ContainerService | BinaryService | CompoundService,
  ApplianceV2ServiceSchemaInput
> = z.lazy(() =>
  z.discriminatedUnion('type', [
    applianceV2ContainerServiceInput,
    applianceV2BinaryServiceInput,
    z
      .object({
        type: z.literal('compound'),
        ...serviceBaseShape,
        services: nonEmptyRecord(dnsLabel, applianceV2ServiceInput, 'A compound service must have services'),
      })
      .strict(),
  ])
);

const rootBaseShape = {
  manifest: z.literal('v2'),
  kind: z.literal('runnable'),
  name: dnsLabel,
  version: semver,
  license: spdxLicenseId,
  description: z.string().max(500).optional(),
  publisher: applianceV2PublisherInput,
  assets: applianceV2AssetsInput.optional(),
  ui: applianceV2UiInput.optional(),
  ...commonRuntimeShape,
};

export const applianceV2ContainerInput = z
  .object({
    ...rootBaseShape,
    type: z.literal('container'),
    payload: applianceV2ContainerPayloadInput,
  })
  .strict();

export const applianceV2BinaryInput = z
  .object({
    ...rootBaseShape,
    type: z.literal('binary'),
    payload: applianceV2BinaryPayloadInput,
  })
  .strict();

export const applianceV2CompoundInput = z
  .object({
    ...rootBaseShape,
    type: z.literal('compound'),
    services: nonEmptyRecord(dnsLabel, applianceV2ServiceInput, 'A compound manifest must have services'),
  })
  .strict();

const protectedMountPaths = ['/app', '/boot', '/dev', '/etc', '/proc', '/run', '/sys'];

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function validateControls(
  value: { mounts?: z.output<typeof applianceV2MountInput>[]; ports?: z.output<typeof applianceV2PortInput>[] },
  path: (string | number)[],
  primaryPort: string | undefined,
  ctx: z.RefinementCtx
) {
  const mounts = value.mounts ?? [];
  const mountNames = new Set<string>();
  for (let index = 0; index < mounts.length; index += 1) {
    const mount = mounts[index];
    if (mountNames.has(mount.name))
      ctx.addIssue({ code: 'custom', path: [...path, 'mounts', index, 'name'], message: 'Mount names must be unique' });
    mountNames.add(mount.name);
    if (protectedMountPaths.some((protectedPath) => pathsOverlap(mount.guest, protectedPath))) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, 'mounts', index, 'guest'],
        message: 'Mount overlaps a protected runtime path',
      });
    }
    for (let other = 0; other < index; other += 1) {
      if (pathsOverlap(mount.guest, mounts[other].guest)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'mounts', index, 'guest'],
          message: 'Guest mount paths must not overlap',
        });
      }
    }
  }

  const ports = value.ports ?? [];
  const names = new Set<string>();
  const pairs = new Set<string>();
  for (let index = 0; index < ports.length; index += 1) {
    const port = ports[index];
    if (names.has(port.name))
      ctx.addIssue({ code: 'custom', path: [...path, 'ports', index, 'name'], message: 'Port names must be unique' });
    names.add(port.name);
    const pair = `${port.guest}/${port.protocol}`;
    if (pairs.has(pair))
      ctx.addIssue({
        code: 'custom',
        path: [...path, 'ports', index, 'guest'],
        message: 'Guest port/protocol pairs must be unique',
      });
    pairs.add(pair);
  }

  const explicitPrimary = ports.filter((port) => port.primary === true);
  const defaultPrimaryCount =
    explicitPrimary.length === 0 ? ports.filter((port) => port.name === primaryPort).length : 0;
  const primaryCount = explicitPrimary.length + defaultPrimaryCount;
  if (ports.length > 0 && primaryCount !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'ports'],
      message: 'A ports array must have exactly one primary port',
    });
  }
}

type V2Root =
  | z.output<typeof applianceV2ContainerInput>
  | z.output<typeof applianceV2BinaryInput>
  | z.output<typeof applianceV2CompoundInput>;

function validateManifest(root: V2Root, ctx: z.RefinementCtx): void {
  if (root.type !== 'compound' && root.ui?.type === 'web' && root.ui.service !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['ui', 'service'],
      message: 'ui.service is only valid for compound manifests',
    });
  }
  if (root.type === 'compound' && root.ui?.type === 'web' && root.ui.service === undefined) {
    ctx.addIssue({ code: 'custom', path: ['ui', 'service'], message: 'A compound web UI requires ui.service' });
  }

  validateControls(
    root,
    [],
    root.type === 'compound' ? undefined : root.ui?.type === 'web' ? root.ui.port : undefined,
    ctx
  );

  if (root.type !== 'compound') {
    if (root.ui?.type === 'web') validateWebUiPort(root.ui, root.ports, ['ui'], ctx);
    return;
  }

  const leaves = new Map<string, { service: ContainerService | BinaryService; path: (string | number)[] }>();
  const dependencies = new Map<string, string[]>();

  const visit = (services: Record<string, ApplianceV2Service>, depth: number, path: (string | number)[]) => {
    for (const [name, service] of Object.entries(services)) {
      const servicePath = [...path, name];
      if (depth > 1 && service.isolation !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [...servicePath, 'isolation'],
          message: 'isolation is only valid on first-level services',
        });
      }
      if (service.type === 'compound') {
        if (depth >= 2) {
          ctx.addIssue({ code: 'custom', path: servicePath, message: 'Service containment exceeds depth two' });
        }
        visit(service.services, depth + 1, [...servicePath, 'services']);
        continue;
      }
      if (leaves.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: servicePath,
          message: `Runnable service name ${name} must be unique across the compound`,
        });
      } else {
        leaves.set(name, { service, path: servicePath });
      }
      dependencies.set(name, service.dependsOn);
    }
  };
  visit(root.services, 1, ['services']);

  if (leaves.size > 16)
    ctx.addIssue({ code: 'custom', path: ['services'], message: 'A compound may contain at most 16 runnable leaves' });

  for (const [name, { service, path }] of leaves) {
    const uiPrimary = root.ui?.type === 'web' && root.ui.service === name ? root.ui.port : undefined;
    validateControls(service, path, uiPrimary, ctx);
    const health = service.health;
    if (health?.type === 'http' || health?.type === 'tcp') {
      if (!service.ports?.some((port) => port.name === health.port)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'health', 'port'],
          message: 'Health port must name a port on the same service',
        });
      }
    }
    const seenDependencies = new Set<string>();
    for (let index = 0; index < service.dependsOn.length; index += 1) {
      const dependency = service.dependsOn[index];
      if (!leaves.has(dependency) || dependency === name) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'dependsOn', index],
          message: 'Dependency must name another runnable leaf in this app',
        });
      }
      if (seenDependencies.has(dependency)) {
        ctx.addIssue({ code: 'custom', path: [...path, 'dependsOn', index], message: 'Dependencies must be unique' });
      }
      seenDependencies.add(dependency);
    }
  }

  if (root.ui?.type === 'web' && root.ui.service) {
    const target = leaves.get(root.ui.service);
    if (!target) {
      ctx.addIssue({ code: 'custom', path: ['ui', 'service'], message: 'ui.service must name a runnable leaf' });
    } else {
      validateWebUiPort(root.ui, target.service.ports, ['ui'], ctx);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const checkCycle = (name: string, chain: string[]) => {
    if (visiting.has(name)) {
      const start = chain.indexOf(name);
      ctx.addIssue({
        code: 'custom',
        path: ['services'],
        message: `Dependency cycle: ${[...chain.slice(start), name].join(' -> ')}`,
      });
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of dependencies.get(name) ?? [])
      if (leaves.has(dependency)) checkCycle(dependency, [...chain, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of leaves.keys()) checkCycle(name, []);
}

function validateWebUiPort(
  ui: z.output<typeof applianceV2WebUiInput>,
  ports: z.output<typeof applianceV2PortInput>[] | undefined,
  path: (string | number)[],
  ctx: z.RefinementCtx
) {
  const port = ports?.find((candidate) => candidate.name === ui.port);
  if (!port)
    ctx.addIssue({ code: 'custom', path: [...path, 'port'], message: 'Web UI port must name a declared port' });
  else if (port.protocol !== 'tcp' || port.expose !== 'host') {
    ctx.addIssue({ code: 'custom', path: [...path, 'port'], message: 'Web UI port must be TCP and exposed to host' });
  }
}

function applyDefaults(root: V2Root): V2Root {
  const defaultPorts = (ports: z.output<typeof applianceV2PortInput>[] | undefined, primaryName?: string) => {
    const hasExplicitPrimary = ports?.some((port) => port.primary === true) ?? false;
    return ports?.map((port) => ({
      ...port,
      primary: !hasExplicitPrimary && port.name === primaryName ? true : (port.primary ?? false),
    }));
  };

  root.ports = defaultPorts(
    root.ports,
    root.type === 'compound' ? undefined : root.ui?.type === 'web' ? root.ui.port : undefined
  );
  if (root.type !== 'compound') return root;

  const mapServices = (
    services: Record<string, ApplianceV2Service>,
    depth: number
  ): Record<string, ApplianceV2Service> =>
    Object.fromEntries(
      Object.entries(services).map(([name, service]) => {
        if (service.type === 'compound') {
          return [
            name,
            {
              ...service,
              isolation: depth === 1 ? (service.isolation ?? 'shared') : service.isolation,
              services: mapServices(service.services, depth + 1),
            },
          ];
        }
        const primaryName = root.ui?.type === 'web' && root.ui.service === name ? root.ui.port : undefined;
        return [
          name,
          {
            ...service,
            isolation: depth === 1 ? (service.isolation ?? 'shared') : service.isolation,
            ports: defaultPorts(service.ports, primaryName),
          },
        ];
      })
    );
  root.services = mapServices(root.services, 1);
  return root;
}

export const applianceV2Input = z
  .discriminatedUnion('type', [applianceV2ContainerInput, applianceV2BinaryInput, applianceV2CompoundInput])
  .superRefine(validateManifest)
  .transform(applyDefaults);

export type ApplianceV2Input = z.input<typeof applianceV2Input>;
export type ApplianceV2 = z.output<typeof applianceV2Input>;
export type ApplianceV2Service = z.output<typeof applianceV2ServiceInput>;
