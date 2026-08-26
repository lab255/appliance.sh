export const durationEstimates = {
  coreBoot: 'about 15 seconds',
  coreBootFirst: 'first start downloads the VM image — up to a few minutes',
  hostingSetup: 'one-time · usually 2–4 minutes',
  deployRun: 'usually 1–3 minutes',
  cloudCreate: 'usually 15–30 minutes',
  cloudConnect: 'about a minute',
} as const;

export type DurationEstimateKey = keyof typeof durationEstimates;
