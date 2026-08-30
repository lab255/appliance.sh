import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

import { ApplianceBaseType, VERSION, applianceBaseConfig, type ApplianceBaseConfig } from '@appliance.sh/sdk';
import { ApplianceSystemSubstrate } from './ApplianceSystemSubstrate';
import { createEdgeRouterHandler } from './edge-router-handler';

export type ApplianceEdgeBaseArgs = {
  substrate: ApplianceSystemSubstrate;
  domain: {
    domainName: string;
    zone: { mode: 'create' } | { mode: 'attach'; hostedZoneId: string };
  };
};

export interface ApplianceEdgeBaseOpts extends pulumi.ComponentResourceOptions {
  globalProvider?: aws.Provider;
}

/**
 * Pulumi-owned, domain-dependent edge for a CFN-owned Appliance substrate.
 * This component must never create buckets, KMS keys, ECR repositories,
 * system roles, or the api-server/worker functions.
 */
export class ApplianceEdgeBase extends pulumi.ComponentResource {
  readonly zoneId: pulumi.Output<string>;
  readonly zone?: aws.route53.Zone;
  readonly globalCert: aws.acm.Certificate;
  readonly certificateArn: pulumi.Output<string>;
  readonly edgeRouterRole: aws.iam.Role;
  readonly cloudfrontDistribution: aws.cloudfront.Distribution;
  readonly systemApiCname: aws.route53.Record;
  readonly systemApiOrigin: aws.route53.Record;
  readonly apiServerPublicUrl: string;
  readonly config: pulumi.Output<ApplianceBaseConfig>;

  constructor(name: string, args: ApplianceEdgeBaseArgs, opts?: ApplianceEdgeBaseOpts) {
    super('appliance-infra:appliance-edge-base', name, args, opts);

    const { substrate } = args;
    const domainName = args.domain.domainName.trim().replace(/\.$/, '');
    if (!domainName) throw new Error('ApplianceEdgeBase requires a domain name');
    const wildcardDomain = `*.${domainName}`;
    this.apiServerPublicUrl = `https://api.${domainName}`;
    const providerOpts = { parent: this, provider: opts?.globalProvider };
    const boundaryArn = pulumi.interpolate`arn:${
      aws.getPartitionOutput({}, providerOpts).partition
    }:iam::${aws.getCallerIdentityOutput({}, providerOpts).accountId}:policy/appliance/${
      substrate.installationName
    }-user-appliance-boundary`;

    if (args.domain.zone.mode === 'create') {
      this.zone = new aws.route53.Zone(`${name}-zone`, { name: domainName }, providerOpts);
      this.zoneId = this.zone.zoneId;
    } else {
      this.zoneId = pulumi.output(args.domain.zone.hostedZoneId);
    }

    this.globalCert = new aws.acm.Certificate(
      `${name}-global-certificate`,
      {
        domainName: wildcardDomain,
        subjectAlternativeNames: [wildcardDomain],
        validationMethod: 'DNS',
        region: 'us-east-1',
      },
      providerOpts
    );

    const validationRecords = this.globalCert.domainValidationOptions.apply((options) =>
      options.map(
        (option, index) =>
          new aws.route53.Record(
            `${name}-global-cert-val-${index}`,
            {
              zoneId: this.zoneId,
              name: option.resourceRecordName,
              type: option.resourceRecordType,
              records: [option.resourceRecordValue],
              ttl: 60,
            },
            providerOpts
          )
      )
    );

    const certificateValidation = new aws.acm.CertificateValidation(
      `${name}-global-cert-validation`,
      {
        region: 'us-east-1',
        validationRecordFqdns: validationRecords.apply((records) => records.map((record) => record.fqdn)),
        certificateArn: this.globalCert.arn,
      },
      providerOpts
    );
    this.certificateArn = certificateValidation.certificateArn;

    const lambdaOac = new aws.cloudfront.OriginAccessControl(
      `${name}-origin-access-control`,
      {
        name: `${name.replaceAll('.', '-')}-lambda-oac`,
        originAccessControlOriginType: 'lambda',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
      providerOpts
    );

    this.edgeRouterRole = new aws.iam.Role(
      `${name}-edge-router-role`,
      {
        path: `/appliance/${name}/`,
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
          Service: ['lambda.amazonaws.com', 'edgelambda.amazonaws.com'],
        }),
        permissionsBoundary: boundaryArn,
        tags: {
          'appliance:managed': 'true',
          'appliance:stack-name': name,
        },
      },
      providerOpts
    );

    new aws.iam.RolePolicyAttachment(
      `${name}-edge-router-role-logging`,
      {
        role: this.edgeRouterRole.name,
        policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
      },
      providerOpts
    );

    // A signed request to a NONE-auth Function URL is still evaluated
    // against the signer's IAM identity. The edge role therefore needs an
    // identity-policy grant in addition to each function's public NONE
    // resource policy below.
    new aws.iam.RolePolicy(
      `${name}-edge-router-system-invoke`,
      {
        role: this.edgeRouterRole.name,
        policy: pulumi.jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: 'lambda:InvokeFunctionUrl',
              Resource: [substrate.systemFunctions.apiServer.arn, substrate.systemFunctions.worker.arn],
            },
          ],
        }),
      },
      providerOpts
    );

    const edgeFunction = new aws.lambda.CallbackFunction(
      `${name.replaceAll('.', '-')}-edge-router`,
      {
        role: this.edgeRouterRole,
        runtime: 'nodejs22.x',
        timeout: 5,
        publish: true,
        loggingConfig: {
          logGroup: `/appliance/base/${name}/edge-router-logs`,
          logFormat: 'Text',
        },
        callback: createEdgeRouterHandler(substrate.systemFunctions.apiServer.url),
      },
      providerOpts
    );

    new aws.lambda.Permission(
      `${name}-edge-router-invoke-permission`,
      {
        function: edgeFunction.name,
        action: 'lambda:InvokeFunction',
        principal: 'edgelambda.amazonaws.com',
        statementId: 'AllowExecutionFromCloudFront',
      },
      providerOpts
    );

    for (const [kind, fn] of Object.entries(substrate.systemFunctions)) {
      new aws.lambda.Permission(
        `${name}-${kind}-public-function-url`,
        {
          function: fn.name,
          action: 'lambda:InvokeFunctionUrl',
          principal: '*',
          functionUrlAuthType: 'NONE',
          statementId: `AllowPublic${kind === 'apiServer' ? 'ApiServer' : 'Worker'}FunctionUrl`,
        },
        providerOpts
      );
    }

    const distributionLogs = new aws.cloudwatch.LogGroup(
      `${name}-distribution-logs`,
      {
        name: `/appliance/base/${name}/distribution-logs`,
        retentionInDays: 7,
      },
      providerOpts
    );

    const deliveryDestination = new aws.cloudwatch.LogDeliveryDestination(
      `${name.replaceAll('.', '-')}-distribution-delivery-destination`,
      {
        outputFormat: 'json',
        deliveryDestinationType: 'CWL',
        deliveryDestinationConfiguration: { destinationResourceArn: distributionLogs.arn },
      },
      providerOpts
    );

    this.cloudfrontDistribution = new aws.cloudfront.Distribution(
      `${name}-distribution`,
      {
        defaultCacheBehavior: {
          cachePolicyId: aws.cloudfront
            .getCachePolicyOutput({ name: 'Managed-CachingDisabled' }, providerOpts)
            .apply((result) => result.id ?? ''),
          originRequestPolicyId: aws.cloudfront
            .getOriginRequestPolicyOutput({ name: 'Managed-AllViewer' }, providerOpts)
            .apply((result) => result.id ?? ''),
          allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
          cachedMethods: ['GET', 'HEAD'],
          targetOriginId: 'SystemApiServerOrigin',
          viewerProtocolPolicy: 'redirect-to-https',
          lambdaFunctionAssociations: [
            {
              eventType: 'origin-request',
              lambdaArn: edgeFunction.qualifiedArn,
              includeBody: true,
            },
          ],
        },
        origins: [
          {
            originId: 'SystemApiServerOrigin',
            domainName: new URL(substrate.systemFunctions.apiServer.url).hostname,
            originAccessControlId: lambdaOac.id,
            customOriginConfig: {
              httpPort: 80,
              httpsPort: 443,
              originProtocolPolicy: 'https-only',
              originSslProtocols: ['TLSv1', 'TLSv1.1', 'TLSv1.2'],
            },
          },
        ],
        restrictions: { geoRestriction: { restrictionType: 'none' } },
        viewerCertificate: {
          acmCertificateArn: this.certificateArn,
          sslSupportMethod: 'sni-only',
          minimumProtocolVersion: 'TLSv1',
        },
        enabled: true,
        aliases: [wildcardDomain],
      },
      providerOpts
    );

    const deliverySource = new aws.cloudwatch.LogDeliverySource(
      `${name.replaceAll('.', '-')}-distribution-delivery-source`,
      {
        region: 'us-east-1',
        logType: 'ACCESS_LOGS',
        resourceArn: this.cloudfrontDistribution.arn,
      },
      providerOpts
    );

    new aws.cloudwatch.LogDelivery(
      `${name.replaceAll('.', '-')}-distribution-logging`,
      {
        region: 'us-east-1',
        deliverySourceName: deliverySource.name,
        deliveryDestinationArn: deliveryDestination.arn,
      },
      providerOpts
    );

    new aws.route53.Record(
      `${name}-wildcard-cloudfront-record`,
      {
        name: wildcardDomain,
        zoneId: this.zoneId,
        type: 'CNAME',
        records: [this.cloudfrontDistribution.domainName],
        ttl: 60,
      },
      providerOpts
    );

    // System functions are CFN-owned and never pass through ApplianceStack,
    // so the edge component owns their routing records explicitly.
    this.systemApiCname = new aws.route53.Record(
      `${name}-system-api-cname`,
      {
        name: `api.${domainName}`,
        zoneId: this.zoneId,
        type: 'CNAME',
        records: [this.cloudfrontDistribution.domainName],
        ttl: 60,
      },
      providerOpts
    );
    this.systemApiOrigin = new aws.route53.Record(
      `${name}-system-api-origin`,
      {
        name: `origin.api.${domainName}`,
        zoneId: this.zoneId,
        type: 'TXT',
        records: [substrate.systemFunctions.apiServer.url],
        ttl: 60,
      },
      providerOpts
    );

    this.config = pulumi
      .all([
        this.zoneId,
        this.cloudfrontDistribution.id,
        this.cloudfrontDistribution.domainName,
        this.edgeRouterRole.arn,
        this.certificateArn,
      ])
      .apply(([zoneId, distributionId, distributionDomainName, edgeRouterRoleArn, certificateArn]) => {
        const base = substrate.toBaseConfig();
        return applianceBaseConfig.parse({
          ...base,
          type: ApplianceBaseType.ApplianceAwsPublic,
          domainName,
          baselineVersion: VERSION,
          aws: {
            ...base.aws,
            zoneId,
            cloudfrontDistributionId: distributionId,
            cloudfrontDistributionDomainName: distributionDomainName,
            edgeRouterRoleArn,
            certificateArn,
            apiServerPublicUrl: this.apiServerPublicUrl,
          },
        });
      });

    this.registerOutputs({
      config: this.config,
      apiServerPublicUrl: this.apiServerPublicUrl,
      zoneId: this.zoneId,
      certificateArn: this.certificateArn,
      cloudfrontDistributionId: this.cloudfrontDistribution.id,
      cloudfrontDistributionDomainName: this.cloudfrontDistribution.domainName,
      edgeRouterRoleArn: this.edgeRouterRole.arn,
      systemApiCname: this.systemApiCname.fqdn,
      systemApiOrigin: this.systemApiOrigin.fqdn,
    });
  }
}
