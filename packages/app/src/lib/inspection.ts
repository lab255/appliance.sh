/** Host snapshots are independent of writable workspace Git/agent metadata. */
export interface InspectionEntry {
  path: string;
  size: number;
  state: 'added' | 'modified' | 'deleted' | 'unchanged' | 'unavailable';
  generated: boolean;
  issue: string | null;
}
export interface Inspection {
  snapshotId: string;
  directory: string;
  capturedAt: string | null;
  refreshedAt: string;
  comparisonError: string | null;
  initialGitStatus: string | null;
  entries: InspectionEntry[];
}
export interface InspectionPreview {
  path: string;
  text: string | null;
  diff: string | null;
  notice: string | null;
  size: number;
  needsLoad: boolean;
}
export interface InspectionHost {
  inspectionRefresh?(directory: string): Promise<Inspection>;
  inspectionRead?(directory: string, path: string, large: boolean, snapshotId: string): Promise<InspectionPreview>;
}
