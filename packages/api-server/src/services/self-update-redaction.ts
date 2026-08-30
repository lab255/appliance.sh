/** Named CU1 redaction set. Error text is scrubbed before logs or job status. */
export function redactSelfUpdateError(error: unknown, exactSecrets: readonly string[] = []): Error {
  const raw = error instanceof Error ? error.message : String(error);
  let redacted = raw;
  for (const secret of exactSecrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED_ECR_TOKEN]');
  }
  redacted = redacted
    .replace(/arn:[a-z0-9-]*:[^\s"']+/gi, '[REDACTED_ARN]')
    .replace(/(?:Basic|Bearer)\s+[A-Za-z0-9+/=_-]+/gi, '[REDACTED_ECR_TOKEN]')
    .replace(/\b\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\b/gi, '[REDACTED_ECR_REGISTRY]')
    .replace(/arn:[^\s,]+:iam::\d{12}:role\/[^\s,]+/gi, '[REDACTED_ROLE_ARN]')
    .replace(/\bself-update-[A-Za-z0-9_-]+\b/g, '[REDACTED_ROLE_SESSION]')
    .replace(/(signature|signature-input|authorization|content-digest|x-api-key)\s*[:=]\s*[^\s,}]+/gi, '$1=[REDACTED]')
    .replace(/("?(?:envelope|sig)"?\s*:\s*)"[^"]+"/gi, '$1"[REDACTED]"')
    .replace(/\b\d{12}\b/g, '[REDACTED_ACCOUNT]');
  return new Error(redacted);
}
