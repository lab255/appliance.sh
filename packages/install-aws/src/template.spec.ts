import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { APPLIANCE_CLOUDFORMATION_TEMPLATE, CLOUDFORMATION_TEMPLATE_BODY_LIMIT } from './template.js';

describe('appliance CloudFormation template', () => {
  it('is structurally valid YAML with only CloudFormation intrinsic tags unresolved', () => {
    const document = YAML.parseDocument(APPLIANCE_CLOUDFORMATION_TEMPLATE);
    expect(document.errors).toEqual([]);
    expect(document.warnings.every((warning) => warning.message.startsWith('Unresolved tag: !'))).toBe(true);
    expect(document.getIn(['Resources', 'StateBucket', 'Type'])).toBe('AWS::S3::Bucket');
  });
  it('stays below the direct TemplateBody limit', () => {
    expect(Buffer.byteLength(APPLIANCE_CLOUDFORMATION_TEMPLATE, 'utf8')).toBeLessThan(
      CLOUDFORMATION_TEMPLATE_BODY_LIMIT
    );
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
