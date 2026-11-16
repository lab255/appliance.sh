/** Workbench Package is a human action. Never invoke it from registry/result effects. */
export interface WorkbenchPackageResult {
  outputPath: string;
  digest: string;
  sizeBytes: number;
  name: string;
  version: string;
  signatureStatus: 'signed' | 'unsigned';
  keyId?: string;
}

export interface WorkbenchPackageEvent {
  type: 'log' | 'stage';
  message: string;
}

export interface WorkbenchPackageHost {
  package(directory: string, onEvent: (event: WorkbenchPackageEvent) => void): Promise<WorkbenchPackageResult>;
}

export const UNSIGNED_PACKAGE_LABEL = 'Unsigned — publisher prompts will warn';
