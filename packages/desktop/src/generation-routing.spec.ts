import { describe, expect, it } from 'vitest';
import { resolveInstallGeneration } from '../sidecar/src/generation';

describe('desktop lifecycle generation dispatch', () => {
  it('keeps unmarked profiles on the frozen legacy path', () => {
    expect(resolveInstallGeneration(undefined)).toBe('legacy-pulumi');
  });

  it('routes the explicit marker to CloudFormation and rejects unknown generations', () => {
    expect(resolveInstallGeneration('cloudformation-v1')).toBe('cloudformation-v1');
    expect(() => resolveInstallGeneration('future-v2')).toThrow(/Unsupported install generation/);
  });
});
