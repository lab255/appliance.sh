import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { APPLIANCE_CLOUDFORMATION_TEMPLATE, CLOUDFORMATION_TEMPLATE_BODY_LIMIT } from './template.js';

type PolicyStatement = {
  Sid: string;
  Action: string | string[];
  Resource: string | string[];
};

const document = YAML.parseDocument(APPLIANCE_CLOUDFORMATION_TEMPLATE);

function scopedPolicy(role: 'SystemApiServerRole' | 'SystemWorkerRole') {
  const policies = document.getIn(['Resources', role, 'Properties', 'Policies'])?.toJSON() as [
    string,
    { PolicyDocument: { Version: string; Statement: PolicyStatement[] } },
    string,
  ][];
  return policies[0][1].PolicyDocument;
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
  // CloudWatch Logs delivery CRUD/list APIs do not support resource-level permissions.
  LogDeliveryAccountOperations: 'log delivery orchestration is account-scoped',
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
      expect(Buffer.byteLength(JSON.stringify(scopedPolicy(role)), 'utf8')).toBeLessThan(10_240);
    }
  });

  it('defaults to scoped roles and makes AdministratorAccess break-glass only', () => {
    expect(document.getIn(['Parameters', 'SystemRoleMode', 'Default'])).toBe('scoped');
    expect(document.getIn(['Parameters', 'SystemRoleMode', 'AllowedValues'])?.toJSON()).toEqual(['scoped', 'admin']);
    for (const role of ['SystemApiServerRole', 'SystemWorkerRole'] as const) {
      const arns = document.getIn(['Resources', role, 'Properties', 'ManagedPolicyArns'])?.toJSON();
      expect(arns).toEqual([
        'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ['UseAdminSystemRoles', 'arn:${AWS::Partition}:iam::aws:policy/AdministratorAccess', 'AWS::NoValue'],
      ]);
    }
  });

  it('snapshots both scoped execution-role policy documents', () => {
    expect(scopedPolicy('SystemApiServerRole')).toMatchSnapshot('api-server scoped policy');
    expect(scopedPolicy('SystemWorkerRole')).toMatchSnapshot('worker scoped policy');
  });

  it('has no all-action grants and allowlists every unavoidable wildcard resource', () => {
    const wildcardResourceSids: string[] = [];
    for (const role of ['SystemApiServerRole', 'SystemWorkerRole'] as const) {
      for (const statement of scopedPolicy(role).Statement) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        expect(actions).not.toContain('*');
        expect(actions.every((action) => !action.endsWith(':*'))).toBe(true);
        const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        if (resources.includes('*')) wildcardResourceSids.push(statement.Sid);
      }
    }
    expect(wildcardResourceSids.sort()).toEqual(Object.keys(WILDCARD_RESOURCE_JUSTIFICATIONS).sort());
    expect(Object.values(WILDCARD_RESOURCE_JUSTIFICATIONS).every((value) => value.length > 20)).toBe(true);
  });

  it('declares the complete retained and encrypted substrate', () => {
    for (const logicalId of [
      'StateBucket',
      'DataBucket',
      'StateKmsKey',
      'StateKmsAlias',
      'SystemApiServerRole',
      'SystemWorkerRole',
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

    const document = YAML.parseDocument(APPLIANCE_CLOUDFORMATION_TEMPLATE);
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
