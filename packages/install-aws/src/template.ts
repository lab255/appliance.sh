import templateBody from '../template/appliance-cloudformation.yaml' with { type: 'text' };

/** Raw TemplateBody embedded by Bun into the standalone appliance CLI. */
export const APPLIANCE_CLOUDFORMATION_TEMPLATE = templateBody;

export const CLOUDFORMATION_TEMPLATE_BODY_LIMIT = 51_200;

/** The template names IAM roles and managed policies, so IAM is insufficient. */
export const APPLIANCE_CLOUDFORMATION_CAPABILITIES = ['CAPABILITY_NAMED_IAM'] as const;

/** Operator baseline updates may intentionally change protected resources. */
export const APPLIANCE_STACK_POLICY_DURING_OPERATOR_UPDATE = JSON.stringify({
  Statement: [{ Effect: 'Allow', Principal: '*', Action: 'Update:*', Resource: '*' }],
});

/**
 * Post-CU1 stack policy. The signed self-update path can change Lambda code
 * through ImageUri, but can never modify or replace stack-owned IAM, S3, or
 * KMS resources even if it attempted to submit a different template.
 */
export const APPLIANCE_STACK_POLICY = JSON.stringify({
  Statement: [
    {
      Effect: 'Deny',
      Principal: '*',
      Action: 'Update:*',
      Resource: [
        'LogicalResourceId/StateBucket',
        'LogicalResourceId/DataBucket',
        'LogicalResourceId/StateKmsKey',
        'LogicalResourceId/StateKmsAlias',
        'LogicalResourceId/UserAppliancePermissionsBoundary',
        'LogicalResourceId/SystemApiServerRole',
        'LogicalResourceId/SystemWorkerRole',
        'LogicalResourceId/SystemWorkerProvisioningPolicy',
        'LogicalResourceId/SystemWorkerEdgeProvisioningPolicy',
        'LogicalResourceId/SelfUpdateRole',
        'LogicalResourceId/SelfUpdateCloudFormationRole',
        'LogicalResourceId/SelfUpdateSchedulerRole',
        'LogicalResourceId/SelfUpdateSchedule',
      ],
    },
    { Effect: 'Allow', Principal: '*', Action: 'Update:*', Resource: '*' },
  ],
});
