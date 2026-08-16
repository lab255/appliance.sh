import { promises as dns } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEdgeRouterHandler } from './edge-router-handler';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
});

describe('edge router handler', () => {
  it('resolves origin.<host> and SigV4-signs the selected Lambda URL', async () => {
    vi.spyOn(dns, 'resolveTxt').mockResolvedValue([['https://target.lambda-url.us-west-2.on.aws/']]);
    process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    process.env.AWS_SESSION_TOKEN = 'test-session';
    const handler = createEdgeRouterHandler('https://fallback.lambda-url.us-east-1.on.aws/');
    const request = {
      method: 'GET',
      uri: '/api/v1/projects',
      querystring: 'z=last&a=first',
      headers: { host: [{ key: 'Host', value: 'app.example.com' }] },
    };

    const result = await handler({ Records: [{ cf: { request } }] });

    expect(dns.resolveTxt).toHaveBeenCalledWith('origin.app.example.com');
    expect(result.origin.custom.domainName).toBe('target.lambda-url.us-west-2.on.aws');
    expect(result.headers.authorization[0].value).toContain('AWS4-HMAC-SHA256');
    expect(result.headers.authorization[0].value).toContain('/us-west-2/lambda/aws4_request');
    expect(result.headers['x-amz-security-token'][0].value).toBe('test-session');
    expect(result.headers['X-Forwarded-Host'][0].value).toBe('app.example.com');
  });
});
