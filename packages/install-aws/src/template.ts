import templateBody from '../template/appliance-cloudformation.yaml' with { type: 'text' };

/** Raw TemplateBody embedded by Bun into the standalone appliance CLI. */
export const APPLIANCE_CLOUDFORMATION_TEMPLATE = templateBody;

export const CLOUDFORMATION_TEMPLATE_BODY_LIMIT = 51_200;
