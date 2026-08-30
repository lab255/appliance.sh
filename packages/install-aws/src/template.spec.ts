import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { APPLIANCE_CLOUDFORMATION_TEMPLATE, CLOUDFORMATION_TEMPLATE_BODY_LIMIT } from './template.js';

type PolicyStatement = {
  Sid: string;
  Effect: 'Allow' | 'Deny';
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: unknown;
  NotResource?: unknown;
  Condition?: Record<string, unknown>;
};

const intrinsicTag = (tag: '!GetAtt' | '!Ref' | '!Sub') => ({
  tag,
  resolve: (value: string) => ({ tag, value }),
});
const document = YAML.parseDocument(APPLIANCE_CLOUDFORMATION_TEMPLATE, {
  customTags: [intrinsicTag('!GetAtt'), intrinsicTag('!Ref'), intrinsicTag('!Sub')],
});

const sub = (value: string) => ({ tag: '!Sub', value });
const ref = (value: string) => ({ tag: '!Ref', value });

function toJson(path: (string | number)[]): unknown {
  return (document.getIn(path) as { toJSON(): unknown }).toJSON();
}

function scopedPolicies(role: 'SystemApiServerRole' | 'SystemWorkerRole') {
  const policies = toJson(['Resources', role, 'Properties', 'Policies']) as [
    string,
    { PolicyDocument: { Version: string; Statement: PolicyStatement[] } },
    string,
  ][];
  for (const policy of policies) expect(policy[0]).toBe('UseScopedSystemRoles');
  return policies.map((policy) => policy[1].PolicyDocument);
}

function scopedPolicy(role: 'SystemApiServerRole' | 'SystemWorkerRole') {
  const policies = scopedPolicies(role);
  return {
    Version: policies[0]?.Version ?? '2012-10-17',
    Statement: policies.flatMap((policy) => policy.Statement),
  };
}

function boundaryPolicy() {
  return toJson(['Resources', 'UserAppliancePermissionsBoundary', 'Properties', 'PolicyDocument']) as {
    Version: string;
    Statement: PolicyStatement[];
  };
}

function resolvedPolicyBytes(policy: unknown): number {
  const resolved = JSON.stringify(policy, (_key, value: unknown) => {
    if (value && typeof value === 'object' && 'tag' in value && 'value' in value && Object.keys(value).length === 2) {
      return (value as { value: unknown }).value;
    }
    return value;
  });
  return Buffer.byteLength(resolved, 'utf8');
}

function actionsOf(statement: PolicyStatement): string[] {
  if (!statement.Action) return [];
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

const WILDCARD_RESOURCE_JUSTIFICATIONS = {
  // ECR does not support repository scoping for registry authorization tokens.
  EcrAuthorization: 'ECR authorization is account-scoped',
  // STS GetCallerIdentity has no resource-level authorization model.
  AccountIdentity: 'STS identity discovery is account-scoped',
  // Cloud Control has no resource types in the service authorization reference.
  AwsNativeCloudControl: 'aws-native uses account-scoped Cloud Control operations',
  // CloudFront creation/list APIs cannot name a resource that does not exist yet.
  CloudFrontAccountOperations: 'CloudFront create/list operations are account-scoped',
  // Route 53 cannot scope CreateHostedZone to the ARN of the not-yet-created zone.
  Route53CreateHostedZone: 'hosted-zone creation is account-scoped',
  // ACM cannot scope RequestCertificate to the ARN returned by that request.
  AcmRequestCertificate: 'certificate creation is account-scoped',
  // CloudWatch Logs describe APIs enumerate account state and do not support resource-level permissions.
  LogsAccountDiscovery: 'CloudWatch Logs discovery is account-scoped',
} as const;

const EXPECTED_IAM_LAMBDA_RESOURCES = {
  ApplianceIamRoleRead: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/appliance/*'),
  ApplianceIamRoleBoundaryMutations: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/appliance/*'),
  ApplianceIamRolePolicyAttachments: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/appliance/*'),
  ApplianceIamRoleMetadataMutations: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/appliance/*'),
  ApplianceIamRoleTagging: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/appliance/*'),
  ApplianceIamPassRole: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/appliance/*'),
  AllowPermissionsBoundaryAdoption: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/appliance/*'),
  DenyPermissionsBoundaryRemoval: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/appliance/*'),
  DenyBoundaryPolicyMutation: ref('UserAppliancePermissionsBoundary'),
  ApplianceIamPolicyRead: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/appliance/*'),
  ApplianceIamPolicyCreate: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/appliance/*'),
  ApplianceIamPolicyMutations: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/appliance/*'),
  ApplianceIamPolicyTagging: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/appliance/*'),
  LambdaEdgeServiceLinkedRoles: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/aws-service-role/*'),
  ApplianceFunctions: sub('arn:${AWS::Partition}:lambda:*:${AWS::AccountId}:function:*'),
  ApplianceLayers: sub('arn:${AWS::Partition}:lambda:*:${AWS::AccountId}:layer:*:*'),
  DenySystemFunctionMutation: [
    sub('arn:${AWS::Partition}:lambda:*:${AWS::AccountId}:function:${InstallationName}-api-server'),
    sub('arn:${AWS::Partition}:lambda:*:${AWS::AccountId}:function:${InstallationName}-api-server:*'),
    sub('arn:${AWS::Partition}:lambda:*:${AWS::AccountId}:function:${InstallationName}-worker'),
    sub('arn:${AWS::Partition}:lambda:*:${AWS::AccountId}:function:${InstallationName}-worker:*'),
  ],
  LambdaEdgeReplication: sub('arn:${AWS::Partition}:lambda:us-east-1:${AWS::AccountId}:function:*:*'),
} as const;

describe('appliance CloudFormation template', () => {
  it('is structurally valid YAML with only CloudFormation intrinsic tags unresolved', () => {
    expect(document.errors).toEqual([]);
    expect(document.warnings.every((warning) => warning.message.startsWith('Unresolved tag: !'))).toBe(true);
    expect(document.getIn(['Resources', 'StateBucket', 'Type'])).toBe('AWS::S3::Bucket');
  });
  it('stays below the direct TemplateBody limit', () => {
    const templateBytes = Buffer.byteLength(APPLIANCE_CLOUDFORMATION_TEMPLATE, 'utf8');
    expect(templateBytes).toBeLessThan(CLOUDFORMATION_TEMPLATE_BODY_LIMIT);
    for (const role of ['SystemApiServerRole', 'SystemWorkerRole'] as const) {
      for (const policy of scopedPolicies(role)) expect(resolvedPolicyBytes(policy)).toBeLessThan(9_000);
    }
    expect(resolvedPolicyBytes(boundaryPolicy())).toBeLessThan(6_144);
  });

  it('defaults to scoped roles and makes AdministratorAccess break-glass only', () => {
    expect(document.getIn(['Parameters', 'SystemRoleMode', 'Default'])).toBe('scoped');
    expect(toJson(['Parameters', 'SystemRoleMode', 'AllowedValues'])).toEqual(['scoped', 'admin']);
    for (const role of ['SystemApiServerRole', 'SystemWorkerRole'] as const) {
      const arns = toJson(['Resources', role, 'Properties', 'ManagedPolicyArns']);
      expect(arns).toEqual([
        sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'),
        ['UseAdminSystemRoles', sub('arn:${AWS::Partition}:iam::aws:policy/AdministratorAccess'), ref('AWS::NoValue')],
      ]);
    }
  });

  it('snapshots every scoped execution-role policy document', () => {
    expect(scopedPolicy('SystemApiServerRole')).toMatchSnapshot('api-server scoped policy');
    const workerPolicies = scopedPolicies('SystemWorkerRole');
    expect(workerPolicies).toHaveLength(2);
    expect(workerPolicies[0]).toMatchSnapshot('worker runtime scoped policy');
    expect(workerPolicies[1]).toMatchSnapshot('worker provisioning scoped policy');
  });

  it('has no all-action grants and allowlists every unavoidable wildcard resource', () => {
    const wildcardResourceSids: string[] = [];
    for (const role of ['SystemApiServerRole', 'SystemWorkerRole'] as const) {
      for (const statement of scopedPolicy(role).Statement) {
        const actions = actionsOf(statement);
        expect(actions).not.toContain('*');
        expect(actions.filter((action) => action.includes('*'))).toEqual(
          actions.filter((action) => ['lambda:DisableReplication*', 'lambda:EnableReplication*'].includes(action))
        );
        const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        if (resources.includes('*')) wildcardResourceSids.push(statement.Sid);
      }
    }
    expect(wildcardResourceSids.sort()).toEqual(Object.keys(WILDCARD_RESOURCE_JUSTIFICATIONS).sort());
  });

  it('contains IAM and Lambda resources to an explicit, reviewable set', () => {
    const statements = scopedPolicy('SystemWorkerRole').Statement.filter((statement) => {
      const actions = actionsOf(statement);
      return actions.some((action) => action.startsWith('iam:') || action.startsWith('lambda:'));
    });
    expect(Object.fromEntries(statements.map((statement) => [statement.Sid, statement.Resource]))).toEqual(
      EXPECTED_IAM_LAMBDA_RESOURCES
    );
  });

  it('conditions every allowed IAM mutation and keeps boundary/system-function denies explicit', () => {
    const statements = scopedPolicy('SystemWorkerRole').Statement;
    for (const statement of statements) {
      const actions = actionsOf(statement);
      const mutatesIam = actions.some(
        (action) => action.startsWith('iam:') && !action.startsWith('iam:Get') && !action.startsWith('iam:List')
      );
      if (statement.Effect === 'Allow' && mutatesIam) expect(statement.Condition).toBeDefined();
    }
    expect(statements.flatMap(actionsOf)).not.toContain('iam:UpdateAssumeRolePolicy');

    expect(statements.find((statement) => statement.Sid === 'ApplianceIamRoleBoundaryMutations')?.Condition).toEqual({
      ArnEquals: { 'iam:PermissionsBoundary': ref('UserAppliancePermissionsBoundary') },
    });
    expect(statements.find((statement) => statement.Sid === 'ApplianceIamRolePolicyAttachments')?.Condition).toEqual({
      ArnEquals: {
        'iam:PermissionsBoundary': ref('UserAppliancePermissionsBoundary'),
        'iam:PolicyARN': [
          sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/appliance/*'),
          sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'),
        ],
      },
    });
    expect(statements.find((statement) => statement.Sid === 'ApplianceIamRoleTagging')?.Condition).toEqual({
      StringEquals: { 'aws:RequestTag/appliance:managed': 'true' },
    });
    expect(statements.find((statement) => statement.Sid === 'ApplianceIamPassRole')?.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
    });
    expect(statements.find((statement) => statement.Sid === 'AllowPermissionsBoundaryAdoption')).toMatchObject({
      Effect: 'Allow',
      Action: 'iam:PutRolePermissionsBoundary',
      Resource: EXPECTED_IAM_LAMBDA_RESOURCES.AllowPermissionsBoundaryAdoption,
      Condition: { ArnEquals: { 'iam:PermissionsBoundary': ref('UserAppliancePermissionsBoundary') } },
    });
    expect(statements.find((statement) => statement.Sid === 'ApplianceIamPolicyMutations')?.Condition).toEqual({
      StringEquals: { 'aws:ResourceTag/appliance:managed': 'true' },
    });
    expect(statements.find((statement) => statement.Sid === 'ApplianceIamPolicyTagging')?.Condition).toEqual({
      StringEquals: { 'aws:RequestTag/appliance:managed': 'true' },
    });

    expect(statements.find((statement) => statement.Sid === 'DenyPermissionsBoundaryRemoval')).toMatchObject({
      Effect: 'Deny',
      Action: 'iam:DeleteRolePermissionsBoundary',
      Resource: EXPECTED_IAM_LAMBDA_RESOURCES.DenyPermissionsBoundaryRemoval,
    });
    expect(statements.find((statement) => statement.Sid === 'DenyBoundaryPolicyMutation')).toMatchObject({
      Effect: 'Deny',
      Action: [
        'iam:CreatePolicyVersion',
        'iam:DeletePolicy',
        'iam:DeletePolicyVersion',
        'iam:SetDefaultPolicyVersion',
        'iam:TagPolicy',
        'iam:UntagPolicy',
      ],
      Resource: ref('UserAppliancePermissionsBoundary'),
    });
    expect(statements.find((statement) => statement.Sid === 'DenySystemFunctionMutation')).toMatchObject({
      Effect: 'Deny',
      Resource: EXPECTED_IAM_LAMBDA_RESOURCES.DenySystemFunctionMutation,
    });
    const applianceFunctionActions = actionsOf(statements.find((statement) => statement.Sid === 'ApplianceFunctions')!);
    const deniedSystemFunctionActions = new Set(
      actionsOf(statements.find((statement) => statement.Sid === 'DenySystemFunctionMutation')!)
    );
    expect(applianceFunctionActions.every((action) => deniedSystemFunctionActions.has(action))).toBe(true);
  });

  it('requires a stack-owned boundary that blocks role, own-stack, and system-function escalation', () => {
    expect(document.getIn(['Resources', 'UserAppliancePermissionsBoundary', 'Type'])).toBe('AWS::IAM::ManagedPolicy');
    expect(document.getIn(['Resources', 'UserAppliancePermissionsBoundary', 'Properties', 'Path'])).toBe(
      '/appliance-system/'
    );
    const statements = boundaryPolicy().Statement;
    expect(statements.find((statement) => statement.Sid === 'AllowUserApplianceRuntimePermissions')).toMatchObject({
      Effect: 'Allow',
      Action: '*',
      Resource: '*',
    });
    expect(statements.find((statement) => statement.Sid === 'DenyIamEscalation')).toMatchObject({
      Effect: 'Deny',
      Action: 'iam:*',
      Resource: '*',
    });
    expect(statements.find((statement) => statement.Sid === 'DenyControlPlaneStackMutation')).toMatchObject({
      Effect: 'Deny',
      NotAction: [
        'cloudformation:Describe*',
        'cloudformation:Get*',
        'cloudformation:List*',
        'cloudformation:Detect*',
        'cloudformation:Validate*',
      ],
      Resource: sub('arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/${AWS::StackName}/*'),
    });
    expect(statements.find((statement) => statement.Sid === 'DenyBoundaryPolicyMutation')).toMatchObject({
      Effect: 'Deny',
      Action: [
        'iam:CreatePolicyVersion',
        'iam:DeletePolicy',
        'iam:DeletePolicyVersion',
        'iam:SetDefaultPolicyVersion',
        'iam:TagPolicy',
        'iam:UntagPolicy',
      ],
      Resource: sub(
        'arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/appliance-system/${InstallationName}-user-appliance-boundary'
      ),
    });
    expect(statements.find((statement) => statement.Sid === 'DenyAssumeOutsideApplianceRoles')).toMatchObject({
      Effect: 'Deny',
      Action: 'sts:AssumeRole',
      NotResource: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/appliance/*'),
    });
    expect(statements.find((statement) => statement.Sid === 'DenySystemFunctionMutation')).toMatchObject({
      Effect: 'Deny',
      Resource: EXPECTED_IAM_LAMBDA_RESOURCES.DenySystemFunctionMutation,
    });
  });

  it('declares the complete retained and encrypted substrate', () => {
    for (const logicalId of [
      'StateBucket',
      'DataBucket',
      'StateKmsKey',
      'StateKmsAlias',
      'SystemApiServerRole',
      'SystemWorkerRole',
      'UserAppliancePermissionsBoundary',
      'ImageRepository',
      'BootstrapTokenSecret',
    ]) {
      expect(APPLIANCE_CLOUDFORMATION_TEMPLATE).toMatch(new RegExp(`^  ${logicalId}:`, 'm'));
    }
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE.match(/DeletionPolicy: Retain/g)).toHaveLength(4);
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE.match(/UpdateReplacePolicy: Retain/g)).toHaveLength(4);
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE.match(/Status: Enabled/g)).toHaveLength(2);
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE.match(/ObjectOwnership: BucketOwnerEnforced/g)).toHaveLength(2);
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE.match(/SSEAlgorithm: AES256/g)).toHaveLength(2);
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE).toContain('EnableKeyRotation: true');
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE).toContain('PendingWindowInDays: 7');
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE).toContain('PasswordLength: 43');
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE).toContain('"countNumber":50');
  });

  it('creates both system functions only when ImageUri is set', () => {
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE).toContain("HasImage: !Not [!Equals [!Ref ImageUri, '']]");
    for (const logicalId of [
      'WorkerFunction',
      'WorkerFunctionUrl',
      'WorkerFunctionUrlPermission',
      'WorkerLogGroup',
      'ApiServerFunction',
      'ApiServerFunctionUrl',
      'ApiServerFunctionUrlPermission',
      'ApiServerLogGroup',
    ]) {
      expect(APPLIANCE_CLOUDFORMATION_TEMPLATE).toMatch(
        new RegExp(`  ${logicalId}:\\n(?:    .*\\n){0,2}    Condition: HasImage`)
      );
    }
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE).toContain('WORKER_URL: !GetAtt WorkerFunctionUrl.FunctionUrl');
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE.match(/FunctionUrlAuthType: NONE/g)).toHaveLength(2);

    expect(
      document.getIn(['Resources', 'ApiServerFunction', 'Properties', 'Environment', 'Variables', 'APPLIANCE_MODE'])
    ).toBe('server');
    expect(
      document.getIn(['Resources', 'WorkerFunction', 'Properties', 'Environment', 'Variables', 'APPLIANCE_MODE'])
    ).toBe('worker');
  });

  it('exports ARNs and URLs but never the bootstrap token value', () => {
    const outputs = APPLIANCE_CLOUDFORMATION_TEMPLATE.split('\nOutputs:\n')[1];
    for (const name of [
      'StateBucketName',
      'StateBucketArn',
      'DataBucketName',
      'DataBucketArn',
      'StateKmsKeyArn',
      'StateKmsAliasName',
      'ImageRepositoryUrl',
      'UserAppliancePermissionsBoundaryArn',
      'WorkerFunctionName',
      'WorkerFunctionArn',
      'WorkerFunctionUrl',
      'ApiServerFunctionName',
      'ApiServerFunctionArn',
      'ApiServerFunctionUrl',
      'BootstrapTokenSecretArn',
    ]) {
      expect(outputs).toMatch(new RegExp(`^  ${name}:`, 'm'));
    }
    expect(outputs).not.toContain('SecretString');
    expect(outputs).not.toContain('{{resolve:secretsmanager:');
  });

  it('contains no edge infrastructure', () => {
    expect(APPLIANCE_CLOUDFORMATION_TEMPLATE).not.toMatch(/AWS::(CloudFront|Route53|CertificateManager)/);
  });
});
