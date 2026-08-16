/**
 * Build the Lambda@Edge origin-request callback. Kept outside the Pulumi
 * component so its dynamic TXT routing and SigV4 behavior can be exercised
 * directly in unit tests. The returned closure contains only serializable
 * values and Node built-ins, as required by aws.lambda.CallbackFunction.
 */
export function createEdgeRouterHandler(fallbackFunctionUrl: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (event: any) => {
    const request = event.Records[0].cf.request;
    const headers = request.headers;
    const host = headers.host[0].value;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dns = require('dns').promises;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto');

    let originUrl: URL;
    let signatureRequired = false;
    try {
      const txtRecords = await dns.resolveTxt(`origin.${host}`);
      const functionUrl = txtRecords[0][0];
      originUrl = new URL(functionUrl);
      signatureRequired = true;
    } catch (e) {
      console.error(`Failed to resolve TXT record for origin.${host}`, e);
      originUrl = new URL(fallbackFunctionUrl);
    }

    if (signatureRequired) {
      const hostnameParts = originUrl.hostname.split('.');
      const regionIndex = hostnameParts.indexOf('lambda-url');
      const targetRegion =
        regionIndex >= 0 && hostnameParts[regionIndex + 1] ? hostnameParts[regionIndex + 1] : 'us-east-1';

      const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest();
      const hmacSha256 = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data).digest();
      const toHex = (buffer: Buffer) => buffer.toString('hex');

      const getSignatureKey = (secretKey: string, dateStamp: string, regionName: string, serviceName: string) => {
        const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
        const kRegion = hmacSha256(kDate, regionName);
        const kService = hmacSha256(kRegion, serviceName);
        return hmacSha256(kService, 'aws4_request');
      };

      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      const sessionToken = process.env.AWS_SESSION_TOKEN;

      if (accessKeyId && secretAccessKey) {
        const method = request.method;
        const service = 'lambda';
        const canonicalUri = request.uri || '/';
        const encodeRfc3986 = (s) =>
          encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
        const rawQuery = request.querystring || '';
        const canonicalQuerystring = rawQuery
          ? rawQuery
              .split('&')
              .map((kv) => {
                const eq = kv.indexOf('=');
                const k = eq === -1 ? kv : kv.slice(0, eq);
                const v = eq === -1 ? '' : kv.slice(eq + 1);
                return [encodeRfc3986(decodeURIComponent(k)), encodeRfc3986(decodeURIComponent(v))];
              })
              .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
              .map(([k, v]) => k + '=' + v)
              .join('&')
          : '';

        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
        const dateStamp = amzDate.substring(0, 8);
        const payloadHash = toHex(
          sha256(request.body?.data ? Buffer.from(request.body.data, request.body.encoding || 'base64') : '')
        );
        const canonicalHeaders =
          `host:${originUrl.hostname}\n` +
          `x-amz-content-sha256:${payloadHash}\n` +
          `x-amz-date:${amzDate}\n` +
          (sessionToken ? `x-amz-security-token:${sessionToken}\n` : '');
        const signedHeaders = sessionToken
          ? 'host;x-amz-content-sha256;x-amz-date;x-amz-security-token'
          : 'host;x-amz-content-sha256;x-amz-date';
        const canonicalRequest = [
          method,
          canonicalUri,
          canonicalQuerystring,
          canonicalHeaders,
          signedHeaders,
          payloadHash,
        ].join('\n');
        const algorithm = 'AWS4-HMAC-SHA256';
        const credentialScope = `${dateStamp}/${targetRegion}/${service}/aws4_request`;
        const stringToSign = [algorithm, amzDate, credentialScope, toHex(sha256(canonicalRequest))].join('\n');
        const signingKey = getSignatureKey(secretAccessKey, dateStamp, targetRegion, service);
        const signature = toHex(hmacSha256(signingKey, stringToSign));
        const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

        request.headers.authorization = [{ key: 'Authorization', value: authorizationHeader }];
        request.headers['x-amz-date'] = [{ key: 'X-Amz-Date', value: amzDate }];
        request.headers['x-amz-content-sha256'] = [{ key: 'X-Amz-Content-Sha256', value: payloadHash }];
        if (sessionToken) {
          request.headers['x-amz-security-token'] = [{ key: 'X-Amz-Security-Token', value: sessionToken }];
        }
      }
    }

    request.origin = {
      custom: {
        domainName: originUrl.hostname,
        port: 443,
        protocol: 'https',
        path: request.path,
        sslProtocols: ['TLSv1', 'TLSv1.1', 'TLSv1.2'],
        readTimeout: 30,
        keepaliveTimeout: 5,
        customHeaders: {},
      },
    };
    request.headers.host = [{ key: 'host', value: originUrl.hostname }];
    request.headers['X-Forwarded-Host'] = [{ key: 'X-Forwarded-Host', value: host }];

    return request;
  };
}
