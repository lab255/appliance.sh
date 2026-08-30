// The CLI-owned entry point stays small so Desktop and CLI consume one
// verifier/downloader implementation from the host-capability package.
export {
  resolveReleaseEvidence,
  SELF_UPDATE_DISABLED_AP226,
  type ResolveReleaseEvidenceOptions,
  type ResolvedReleaseEvidence,
} from '@appliance.sh/bootstrap';
