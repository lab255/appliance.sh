import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import type { ApplianceBaseConfig } from '@appliance.sh/sdk';
import { createHash } from 'crypto';

// AWS resource name limits (IAM roles, Lambda functions) are 64 chars.
// Pulumi appends an 8-char suffix (-xxxxxxx). The longest resource
// suffix we add is "-handler" (8 chars). Budget: 64 - 8 - 8 = 48.
const MAX_RESOURCE_ID_LENGTH = 48;

// DNS labels (each segment between dots) are limited to 63 chars.
const MAX_DNS_LABEL_LENGTH = 63;

function truncateWithHash(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 7);
  return `${name.slice(0, maxLength - 8)}-${hash}`;
}

/**
 * Derive a short, deterministic resource ID from a stack name.
 * If the name fits within the limit it is returned as-is.
 * Otherwise it is truncated and a 7-char hash suffix is appended
 * to preserve uniqueness.
 */
export function toResourceId(name: string): string {
  return truncateWithHash(name, MAX_RESOURCE_ID_LENGTH);
}

/**
 * Derive a DNS-safe label from a stack name (max 63 chars).
 */
export function toDnsLabel(name: string): string {
  return truncateWithHash(name, MAX_DNS_LABEL_LENGTH);
}

export interface ApplianceStackMetadata {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  deploymentId: string;
  stackName: string;
}

export interface ApplianceStackArgs {
  metadata?: ApplianceStackMetadata;
  config: ApplianceBaseConfig;
  imageUri?: string;
  codeS3Key?: string;
  runtime?: string;
  handler?: string;
  layers?: string[];
  architectures?: string[];
  environment?: Record<string, string>;
  memory?: number;
  timeout?: number;
  // Ephemeral scratch storage in MB — maps to Lambda ephemeralStorage
  // (the /tmp size). Optional; Lambda defaults to 512 MB when omitted.
  storage?: number;
  // When set, the Lambda binds to this pre-existing IAM role instead
  // of one created here. Used by the dogfooded bootstrap to deploy
  // the system api-server + worker appliances against roles
  // pre-created by the base (which carry broader Pulumi/AWS perms
  // than ApplianceStack's per-appliance role grants).
  lambdaRoleArn?: pulumi.Input<string>;
}

export interface ApplianceStackOpts extends pulumi.ComponentResourceOptions {
  globalProvider: aws.Provider;
  provider: aws.Provider;
  nativeProvider: awsNative.Provider;
  nativeGlobalProvider: awsNative.Provider;
}

/** Fail explicitly during the substrate-only epoch, before any workload resources register. */
export function assertAwsEdgeProvisioned(config: ApplianceBaseConfig): asserts config is ApplianceBaseConfig & {
  domainName: string;
  aws: NonNullable<ApplianceBaseConfig['aws']> & {
    zoneId: string;
    cloudfrontDistributionId: string;
    cloudfrontDistributionDomainName: string;
  };
} {
  if (!config.aws?.cloudfrontDistributionId) {
    throw new Error(
      'This cloud installation has only its system substrate. Provision the edge base first (`appliance cloud install` or deploy the typed edge target) before deploying an ordinary appliance.'
    );
  }
  if (!config.aws.zoneId || !config.domainName || !config.aws.cloudfrontDistributionDomainName) {
    throw new Error(
      'The edge base is incomplete (missing Route53/CloudFront config). Provision the edge base first before deploying an ordinary appliance.'
    );
  }
}

export class ApplianceStack extends pulumi.ComponentResource {
  // lambdaRole / lambdaRolePolicy are present only when the stack
  // mints its own role. When `lambdaRoleArn` is supplied via args,
  // both are undefined and the Lambda binds to the supplied ARN.
  lambdaRole?: aws.iam.Role;
  lambdaRolePolicy?: aws.iam.Policy;
  lambdaRoleArn: pulumi.Output<string>;
  lambda: aws.lambda.Function;
  lambdaUrl: aws.lambda.FunctionUrl;
  dnsRecord: pulumi.Output<string>;

  constructor(name: string, args: ApplianceStackArgs, opts: ApplianceStackOpts) {
    super('appliance:aws:ApplianceStack', name, args, opts);

    // `args.config.aws` was the only base shape that existed when this
    // component was written. The base schema now also accepts
    // `appliance-base-local` (no aws block), so the union allows
    // `aws: undefined`. This component is AWS-only — narrow once and
    // shadow `args.config` below so the `.aws.X` accesses keep working.
    if (!args.config.aws) {
      throw new Error(`ApplianceStack requires an AWS-typed base config; got type '${args.config.type}'`);
    }
    assertAwsEdgeProvisioned(args.config);
    const awsConfig = args.config.aws;

    // CloudFront is the only supported ingress — the Lambda Function URL is
    // always created with AWS_IAM auth and is intended to be invoked either
    // by the CloudFront distribution (via OAC) or by the edge router role.
    // Refuse to build a stack that would expose the function URL publicly.
    const zoneId = awsConfig.zoneId;
    const domainName = args.config.domainName;
    const cloudfrontDistributionDomainName = awsConfig.cloudfrontDistributionDomainName;

    // Short ID for AWS resource names (subject to 64-char limits)
    const rid = toResourceId(name);
    // DNS-safe label (max 63 chars per label)
    const dnsLabel = toDnsLabel(name);

    const defaultOpts = { parent: this, provider: opts.provider };
    const defaultNativeOpts = { parent: this, provider: opts.nativeProvider };
    const boundaryArn = awsConfig.userAppliancePermissionsBoundaryArn;
    if (!boundaryArn) throw new Error('CFN base config is missing aws.userAppliancePermissionsBoundaryArn');
    const defaultTags: Record<string, string> = {
      'appliance:managed': 'true',
      'appliance:stack-name': name,
    };
    if (args.metadata) {
      defaultTags['appliance:project-id'] = args.metadata.projectId;
      defaultTags['appliance:project-name'] = args.metadata.projectName;
      defaultTags['appliance:environment-id'] = args.metadata.environmentId;
      defaultTags['appliance:environment-name'] = args.metadata.environmentName;
      defaultTags['appliance:deployment-id'] = args.metadata.deploymentId;
    }

    if (args.lambdaRoleArn) {
      // Caller supplied a pre-existing role (system api-server / worker
      // appliances bootstrap-deployed against base-pre-created roles).
      // Skip role + policy creation; bind the Lambda to the ARN below.
      this.lambdaRoleArn = pulumi.output(args.lambdaRoleArn);
    } else {
      this.lambdaRole = new aws.iam.Role(`${rid}-role`, {
        path: `/appliance/${name}/`,
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
        permissionsBoundary: boundaryArn,
        tags: defaultTags,
      });

      const policyStatements = [
        { Effect: 'Allow' as const, Action: 'logs:CreateLogGroup', Resource: '*' },
        { Effect: 'Allow' as const, Action: 'logs:CreateLogStream', Resource: '*' },
        { Effect: 'Allow' as const, Action: 'logs:PutLogEvents', Resource: '*' },
      ];

      if (args.imageUri) {
        policyStatements.push(
          {
            Effect: 'Allow' as const,
            Action: 'ecr:GetDownloadUrlForLayer',
            Resource: '*',
          },
          {
            Effect: 'Allow' as const,
            Action: 'ecr:BatchGetImage',
            Resource: '*',
          },
          {
            Effect: 'Allow' as const,
            Action: 'ecr:BatchCheckLayerAvailability',
            Resource: '*',
          },
          {
            Effect: 'Allow' as const,
            Action: 'ecr:GetAuthorizationToken',
            Resource: '*',
          }
        );
      }

      if (args.codeS3Key && awsConfig.dataBucketName) {
        policyStatements.push({
          Effect: 'Allow' as const,
          Action: 's3:GetObject',
          Resource: `arn:aws:s3:::${awsConfig.dataBucketName}/${args.codeS3Key}`,
        });
      }

      this.lambdaRolePolicy = new aws.iam.Policy(`${rid}-policy`, {
        path: `/appliance/${name}/`,
        policy: {
          Version: '2012-10-17',
          Statement: policyStatements,
        },
        tags: defaultTags,
      });

      new aws.iam.RolePolicyAttachment(`${rid}-role-policy-attachment`, {
        role: this.lambdaRole.name,
        policyArn: this.lambdaRolePolicy.arn,
      });

      this.lambdaRoleArn = this.lambdaRole.arn;
    }

    const ephemeralStorage = args.storage ? { size: args.storage } : undefined;

    pulumi.log.info(
      `ApplianceStack ${name}: timeout=${args.timeout ?? 30}s memory=${args.memory ?? 512}MB storage=${args.storage ?? 'default'}`
    );

    if (args.imageUri) {
      this.lambda = new aws.lambda.Function(
        `${rid}-handler`,
        {
          packageType: 'Image',
          imageUri: args.imageUri,
          // Architectures must match one of the image manifest's
          // platforms — Lambda doesn't auto-detect, so an arm64-only
          // image with the default `x86_64` here fails on first
          // invoke with `exec format error`.
          architectures: args.architectures,
          role: this.lambdaRoleArn,
          timeout: args.timeout ?? 30,
          memorySize: args.memory ?? 512,
          ephemeralStorage,
          environment: args.environment ? { variables: args.environment } : undefined,
          tags: defaultTags,
        },
        defaultOpts
      );
    } else if (args.codeS3Key && awsConfig.dataBucketName) {
      this.lambda = new aws.lambda.Function(
        `${rid}-handler`,
        {
          packageType: 'Zip',
          runtime: args.runtime ?? 'nodejs22.x',
          handler: args.handler ?? 'index.handler',
          s3Bucket: awsConfig.dataBucketName,
          s3Key: args.codeS3Key,
          role: this.lambdaRoleArn,
          timeout: args.timeout ?? 30,
          memorySize: args.memory ?? 512,
          ephemeralStorage,
          layers: args.layers,
          architectures: args.architectures,
          environment: args.environment ? { variables: args.environment } : undefined,
          tags: defaultTags,
        },
        defaultOpts
      );
    } else {
      this.lambda = new aws.lambda.CallbackFunction(
        `${rid}-handler`,
        {
          role: this.lambdaRoleArn,
          runtime: 'nodejs22.x',
          callback: async () => {
            return { statusCode: 200, body: JSON.stringify({ message: 'Hello world!' }) };
          },
          tags: defaultTags,
        },
        defaultOpts
      );
    }

    // lambda url — always AWS_IAM. The only supported callers are the
    // CloudFront distribution (via OAC) and the edge-router Lambda@Edge
    // role, both of which are granted invoke permission below.
    this.lambdaUrl = new aws.lambda.FunctionUrl(
      `${rid}-url`,
      {
        functionName: this.lambda.name,
        authorizationType: 'AWS_IAM',
      },
      defaultOpts
    );

    // DNS uses the full stack name, not the truncated resource ID
    this.dnsRecord = pulumi.interpolate`${dnsLabel}.${domainName}`;

    new aws.lambda.Permission(
      `${rid}-cf-invoke-url`,
      {
        function: this.lambda.name,
        action: 'lambda:InvokeFunctionUrl',
        principal: 'cloudfront.amazonaws.com',
        functionUrlAuthType: 'AWS_IAM',
        sourceArn: pulumi.interpolate`arn:aws:cloudfront::${
          aws.getCallerIdentityOutput({}, { provider: opts.provider }).accountId
        }:distribution/${awsConfig.cloudfrontDistributionId}`,
        statementId: 'FunctionURLAllowCloudFrontAccess',
      },
      defaultOpts
    );

    // Grant the edge router role permission to invoke the Lambda Function URL
    // The edge router role is the execution role of the Lambda@Edge function that signs requests
    if (awsConfig.edgeRouterRoleArn) {
      new aws.lambda.Permission(
        `${rid}-edge-invoke-url`,
        {
          function: this.lambda.name,
          action: 'lambda:InvokeFunctionUrl',
          principal: awsConfig.edgeRouterRoleArn,
          functionUrlAuthType: 'AWS_IAM',
          statementId: 'FunctionURLAllowEdgeRouterRoleAccess',
        },
        defaultOpts
      );

      new awsNative.lambda.Permission(
        `${rid}-edge-invoke`,
        {
          action: 'lambda:InvokeFunction',
          principal: awsConfig.edgeRouterRoleArn,
          functionName: this.lambda.name,
          invokedViaFunctionUrl: true,
        },
        defaultNativeOpts
      );
    }

    if (awsConfig.cloudfrontDistributionId && cloudfrontDistributionDomainName) {
      new awsNative.lambda.Permission(
        `${rid}-cf-invoke`,
        {
          action: 'lambda:InvokeFunction',
          principal: 'cloudfront.amazonaws.com',
          sourceArn: pulumi.interpolate`arn:aws:cloudfront::${
            aws.getCallerIdentityOutput({}, { provider: opts.provider }).accountId
          }:distribution/${awsConfig.cloudfrontDistributionId}`,
          functionName: this.lambda.name,
          invokedViaFunctionUrl: true,
        },
        defaultNativeOpts
      );

      new aws.route53.Record(
        `${rid}-cname`,
        {
          zoneId,
          name: pulumi.interpolate`${dnsLabel}.${domainName}`,
          type: 'CNAME',
          ttl: 60,
          records: [cloudfrontDistributionDomainName],
        },
        { parent: this, provider: opts.globalProvider }
      );

      new aws.route53.Record(
        `${rid}-txt`,
        {
          zoneId,
          name: pulumi.interpolate`origin.${dnsLabel}.${domainName}`,
          type: 'TXT',
          ttl: 60,
          records: [this.lambdaUrl.functionUrl],
        },
        { parent: this, provider: opts.globalProvider }
      );
    }

    this.registerOutputs({
      lambda: this.lambda,
      lambdaUrl: this.lambdaUrl,
    });
  }
}
