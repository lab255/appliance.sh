import { beforeEach, describe, expect, it, vi } from 'vitest';

const runVmCaptureMock = vi.hoisted(() => vi.fn());
vi.mock('./sandbox.js', () => ({ runVmCapture: runVmCaptureMock }));

import { runtimeEgressCapability } from './runtime-wsl-egress.js';

describe('runtimeEgressCapability', () => {
  beforeEach(() => runVmCaptureMock.mockReset());

  it('does not spawn the VM engine away from Windows', () => {
    expect(runtimeEgressCapability('darwin')).toEqual({});
    expect(runtimeEgressCapability('linux')).toEqual({});
    expect(runVmCaptureMock).not.toHaveBeenCalled();
  });

  it('reads the engine capability on Windows', () => {
    runVmCaptureMock.mockReturnValue({ status: 0, stdout: '{"enforcement":{"backend":"wsl"},"wslMode":"strict"}' });
    expect(runtimeEgressCapability('win32')).toMatchObject({
      enforcement: { backend: 'wsl' },
      wslMode: 'strict',
    });
    expect(runVmCaptureMock).toHaveBeenCalledWith(['egress', 'policy', 'appliance-runtime']);
  });
});
