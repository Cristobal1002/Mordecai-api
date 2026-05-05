import { templateRepository } from './template.repository.js';
import { tenantRepository } from '../tenants/tenant.repository.js';
import { NotFoundError } from '../../errors/index.js';

const VALID_CHANNELS = ['sms', 'email', 'letter'];

export const templateService = {
  listTemplates: async (tenantId, channel = null) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const templates = await templateRepository.findTemplatesByTenant(tenantId);
    if (channel && VALID_CHANNELS.includes(channel)) {
      return templates.filter((t) => t.channel === channel);
    }
    return templates;
  },

  getTemplate: async (tenantId, templateId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const template = await templateRepository.findTemplateById(templateId, tenantId);
    if (!template) throw new NotFoundError('Message template');
    return template;
  },

  createTemplate: async (tenantId, data) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    if (!VALID_CHANNELS.includes(data.channel)) {
      throw new Error('channel must be sms, email or letter');
    }

    return await templateRepository.createTemplate({
      tenantId,
      channel: data.channel,
      name: data.name,
      subject: data.channel === 'email' ? data.subject : data.subject ?? null,
      bodyText: data.bodyText,
      bodyHtml: data.channel === 'sms' ? null : data.bodyHtml ?? null,
      isActive: data.isActive !== false,
    });
  },

  updateTemplate: async (tenantId, templateId, data) => {
    const existing = await templateRepository.findTemplateById(templateId, tenantId);
    if (!existing) throw new NotFoundError('Message template');

    const payload = {};
    if (data.name !== undefined) payload.name = data.name;
    if (data.subject !== undefined) payload.subject = data.subject;
    if (data.bodyText !== undefined) payload.bodyText = data.bodyText;
    if (data.bodyHtml !== undefined) payload.bodyHtml = data.bodyHtml;
    if (data.isActive !== undefined) payload.isActive = data.isActive;

    await templateRepository.updateTemplate(templateId, tenantId, payload);
    return await templateRepository.findTemplateById(templateId, tenantId);
  },

  deleteTemplate: async (tenantId, templateId) => {
    const existing = await templateRepository.findTemplateById(templateId, tenantId);
    if (!existing) throw new NotFoundError('Message template');

    await templateRepository.deleteTemplate(templateId, tenantId);
    return { deleted: true, templateId };
  },

  listAttachments: async (tenantId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    return await templateRepository.findAttachmentsByTenant(tenantId);
  },

  getAttachment: async (tenantId, attachmentId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const attachment = await templateRepository.findAttachmentById(attachmentId, tenantId);
    if (!attachment) throw new NotFoundError('Message attachment');
    return attachment;
  },

  createAttachment: async (tenantId, data) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    return await templateRepository.createAttachment({
      tenantId,
      name: data.name,
      type: data.type ?? 'custom',
      fileKey: data.fileKey,
      minDaysPastDue: data.minDaysPastDue ?? null,
      isActive: data.isActive !== false,
    });
  },

  updateAttachment: async (tenantId, attachmentId, data) => {
    const existing = await templateRepository.findAttachmentById(attachmentId, tenantId);
    if (!existing) throw new NotFoundError('Message attachment');

    const payload = {};
    if (data.name !== undefined) payload.name = data.name;
    if (data.type !== undefined) payload.type = data.type;
    if (data.fileKey !== undefined) payload.fileKey = data.fileKey;
    if (data.minDaysPastDue !== undefined) payload.minDaysPastDue = data.minDaysPastDue;
    if (data.isActive !== undefined) payload.isActive = data.isActive;

    await templateRepository.updateAttachment(attachmentId, tenantId, payload);
    return await templateRepository.findAttachmentById(attachmentId, tenantId);
  },

  deleteAttachment: async (tenantId, attachmentId) => {
    const existing = await templateRepository.findAttachmentById(attachmentId, tenantId);
    if (!existing) throw new NotFoundError('Message attachment');

    await templateRepository.deleteAttachment(attachmentId, tenantId);
    return { deleted: true, attachmentId };
  },
};
