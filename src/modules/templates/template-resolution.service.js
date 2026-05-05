import { Op } from 'sequelize';
import { TenantMessageTemplate } from '../../models/index.js';

const CHANNEL_KEYS = ['sms', 'email', 'letter'];

const TEMPLATE_ID_KEYS = {
  sms: ['sms_template_id', 'smsTemplateId'],
  email: ['email_template_id', 'emailTemplateId'],
  letter: ['letter_template_id', 'letterTemplateId'],
};

const readStageTemplateId = (stage, channel) => {
  if (!stage || !CHANNEL_KEYS.includes(channel)) return null;
  const rules = stage.rules || {};
  const keys = TEMPLATE_ID_KEYS[channel] || [];
  for (const key of keys) {
    const value = rules[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

const findTemplateById = async ({ tenantId, channel, templateId }) => {
  if (!templateId) return null;
  return TenantMessageTemplate.findOne({
    where: {
      id: templateId,
      tenantId,
      channel: { [Op.in]: [channel, channel.toUpperCase()] },
      isActive: true,
    },
  });
};

const findDefaultTemplate = async ({ tenantId, channel }) =>
  TenantMessageTemplate.findOne({
    where: {
      tenantId,
      channel: { [Op.in]: [channel, channel.toUpperCase()] },
      isActive: true,
    },
    order: [['createdAt', 'ASC']],
  });

export const resolveChannelTemplate = async ({ tenantId, channel, stage = null }) => {
  if (!CHANNEL_KEYS.includes(channel)) {
    return { template: null, source: null, reason: 'unsupported_channel' };
  }

  const stageTemplateId = readStageTemplateId(stage, channel);
  if (stageTemplateId) {
    const stageTemplate = await findTemplateById({
      tenantId,
      channel,
      templateId: stageTemplateId,
    });
    if (stageTemplate) {
      return { template: stageTemplate, source: 'stage_rules', reason: null };
    }
    return { template: null, source: 'stage_rules', reason: 'stage_template_not_found' };
  }

  const defaultTemplate = await findDefaultTemplate({ tenantId, channel });
  if (defaultTemplate) {
    return { template: defaultTemplate, source: 'tenant_default', reason: null };
  }

  return { template: null, source: null, reason: 'missing_active_template' };
};

