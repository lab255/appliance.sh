import { describe, expect, it } from 'vitest';
import { inactiveReasonCopy, selfUpdateStatusJson, selfUpdateStatusLines } from './self-update-status.js';

describe('scheduled cloud self-update status output', () => {
  it.each([
    ['not-checked', 'not-checked'],
    ['off', 'policy-off'],
    ['no-trust', 'no-pinned-release-trust'],
    ['unscoped-role', 'unscoped-role'],
    ['current', 'up-to-date'],
    ['older-generation', 'older-generation'],
    ['notify', 'notify-marked'],
    ['auto-created', 'auto-created'],
    ['auto-reused', 'auto-reused'],
    ['lease-conflict', 'lease-conflict'],
    ['error', 'error'],
  ])('prints the %s decision and its stored reason', (decision, reason) => {
    const lines = selfUpdateStatusLines({
      policy: decision === 'off' ? 'off' : 'auto',
      lastCheck: { at: '2026-08-31T00:00:00.000Z', decision, reason, version: '1.58.0' },
    });

    expect(lines).toContain(`Decision: ${decision}`);
    expect(lines).toContain(`Reason: ${reason}`);
    expect(lines).toContain('Version: 1.58.0');
    expect(lines).toContain('Update available: none');
  });

  it('makes empty release trust explicit and prints notify availability without generation', () => {
    expect(inactiveReasonCopy('no-pinned-release-trust')).toBe(
      'scheduled checks are inactive: this build has no pinned release trust'
    );
    const lines = selfUpdateStatusLines({
      policy: 'notify',
      lastCheck: {
        at: '2026-08-31T00:00:00.000Z',
        decision: 'no-trust',
        reason: 'no-pinned-release-trust',
      },
      available: { version: '1.58.0', generation: 8 },
    });
    expect(lines).toContain('Status: scheduled checks are inactive: this build has no pinned release trust');
    expect(lines).toContain('Update available: v1.58.0');
    expect(lines.join('\n')).not.toContain('generation');
  });

  it('preserves the complete status shape in JSON', () => {
    const status = {
      policy: 'notify' as const,
      lastCheck: {
        at: '2026-08-31T00:00:00.000Z',
        decision: 'notify',
        reason: 'notify-marked',
        version: '1.58.0',
      },
      available: { version: '1.58.0', generation: 8 },
    };
    expect(JSON.parse(selfUpdateStatusJson(status))).toEqual(status);
  });
});
