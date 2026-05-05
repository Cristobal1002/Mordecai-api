import { templateService } from './template.service.js';
import nunjucks from 'nunjucks';
import { Tenant, TenantBranding, TenantMessageAttachment, TenantMessageTemplate } from '../../models/index.js';
import { renderHtmlToPdfBuffer } from '../../utils/pdf-generator.js';
import { stampSignatureOnPdf } from '../../utils/pdf-signer.js';
import { getTenantAttachmentBuffer, uploadTenantAttachmentBuffer } from '../../utils/attachments.storage.js';
import { formatLetterDateEnUS } from '../email/ses/ses.email.template.js';
import {
  prepareLetterHtmlWithOptionalSignature,
  normalizeSignatureMarkersToComment,
} from '../../utils/letter-signature-inject.js';
import { draftLetterHtmlWithClaude } from './letter-ai-draft.service.js';
import { BadRequestError } from '../../errors/http.error.js';

/** Placeholders for PDF preview when the client sends no variables (matches InsertableFields / letter AI). */
function buildLetterPreviewVariableDefaults(tenant) {
  const company = tenant?.name?.trim() || 'Sample Property Management';
  return {
    tenant_name: company,
    debtor_name: 'Jane Resident',
    amount_due: '$1,250.00',
    days_past_due: '14',
    due_date: 'May 1, 2026',
    payment_link: 'https://pay.example.com/preview',
    property_name: 'Riverside Gardens',
    property_address: '123 Main Street, Atlanta, GA 30303',
    debtor_address: '456 Oak Lane, Unit 2B, Atlanta, GA 30303',
    unit_number: '2B',
    lease_number: 'L-10042',
  };
}

async function letterRenderedHtmlToPdf(tenantId, renderedHtml, title) {
  const htmlNorm = normalizeSignatureMarkersToComment(renderedHtml);
  const branding = await TenantBranding.findOne({ where: { tenantId } });
  const signatureKey = branding?.signatureImageKey || null;
  let signatureBuf = null;
  if (signatureKey) {
    try {
      signatureBuf = await getTenantAttachmentBuffer(signatureKey);
    } catch {
      signatureBuf = null;
    }
  }
  const { htmlForPdf, usedAnchor } = prepareLetterHtmlWithOptionalSignature(
    htmlNorm,
    branding,
    signatureBuf
  );
  let pdfBuffer = await renderHtmlToPdfBuffer({ html: htmlForPdf, title });
  if (signatureBuf?.length && !usedAnchor) {
    pdfBuffer = await stampSignatureOnPdf({
      pdfBuffer,
      signaturePngBuffer: signatureBuf,
      signatoryName: branding?.signatoryName ?? undefined,
      signatoryTitle: branding?.signatoryTitle ?? undefined,
    });
  }
  return { pdfBuffer, branding, signatureKey };
}

export const templateController = {
  listTemplates: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      const { channel } = req.query;
      const result = await templateService.listTemplates(tenantId, channel);
      res.ok(result, 'Templates retrieved successfully');
    } catch (error) {
      next(error);
    }
  },

  getTemplate: async (req, res, next) => {
    try {
      const { tenantId, templateId } = req.params;
      const result = await templateService.getTemplate(tenantId, templateId);
      res.ok(result, 'Template retrieved successfully');
    } catch (error) {
      next(error);
    }
  },

  draftLetterWithAi: async (req, res, next) => {
    try {
      const prompt = String(req.body?.prompt || '').trim();
      const file = req.file || null;
      if (!prompt && !file) {
        throw new BadRequestError('Add instructions and/or attach an image or PDF.');
      }
      const { bodyHtml } = await draftLetterHtmlWithClaude({ prompt, file });
      res.ok({ bodyHtml }, 'Draft generated');
    } catch (error) {
      next(error);
    }
  },

  createTemplate: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      const result = await templateService.createTemplate(tenantId, req.body);
      res.created(result, 'Template created successfully');
    } catch (error) {
      next(error);
    }
  },

  updateTemplate: async (req, res, next) => {
    try {
      const { tenantId, templateId } = req.params;
      const result = await templateService.updateTemplate(tenantId, templateId, req.body);
      res.ok(result, 'Template updated successfully');
    } catch (error) {
      next(error);
    }
  },

  deleteTemplate: async (req, res, next) => {
    try {
      const { tenantId, templateId } = req.params;
      const result = await templateService.deleteTemplate(tenantId, templateId);
      res.ok(result, 'Template deleted successfully');
    } catch (error) {
      next(error);
    }
  },

  listAttachments: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      const result = await templateService.listAttachments(tenantId);
      res.ok(result, 'Attachments retrieved successfully');
    } catch (error) {
      next(error);
    }
  },

  getAttachment: async (req, res, next) => {
    try {
      const { tenantId, attachmentId } = req.params;
      const result = await templateService.getAttachment(tenantId, attachmentId);
      res.ok(result, 'Attachment retrieved successfully');
    } catch (error) {
      next(error);
    }
  },

  createAttachment: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      const result = await templateService.createAttachment(tenantId, req.body);
      res.created(result, 'Attachment created successfully');
    } catch (error) {
      next(error);
    }
  },

  updateAttachment: async (req, res, next) => {
    try {
      const { tenantId, attachmentId } = req.params;
      const result = await templateService.updateAttachment(tenantId, attachmentId, req.body);
      res.ok(result, 'Attachment updated successfully');
    } catch (error) {
      next(error);
    }
  },

  deleteAttachment: async (req, res, next) => {
    try {
      const { tenantId, attachmentId } = req.params;
      const result = await templateService.deleteAttachment(tenantId, attachmentId);
      res.ok(result, 'Attachment deleted successfully');
    } catch (error) {
      next(error);
    }
  },

  previewTemplatePdf: async (req, res, next) => {
    try {
      const { tenantId, templateId } = req.params;
      const { variables = {} } = req.body || {};
      const template = await templateService.getTemplate(tenantId, templateId);
      const bodyHtml = template?.bodyHtml || null;
      const bodyText = template?.bodyText || '';

      const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'name'] });
      const previewDefaults = buildLetterPreviewVariableDefaults(tenant);
      const vars = {
        letter_date: formatLetterDateEnUS(),
        ...previewDefaults,
        ...(variables && typeof variables === 'object' ? variables : {}),
      };
      const html = bodyHtml
        ? nunjucks.renderString(bodyHtml, vars)
        : `<pre style="white-space:pre-wrap;margin:0;">${nunjucks.renderString(bodyText, vars)}</pre>`;

      const { pdfBuffer: pdf } = await letterRenderedHtmlToPdf(tenantId, html, template?.name || 'Letter');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${(template?.name || 'letter').replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf"`);
      res.status(200).send(pdf);
    } catch (error) {
      next(error);
    }
  },

  generateLetterAttachment: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      const { letterTemplateId, variables = {}, debtCaseId = null, name } = req.body || {};

      const letterTemplate = await TenantMessageTemplate.findOne({
        where: { id: letterTemplateId, tenantId, channel: 'letter', isActive: true },
      });
      if (!letterTemplate) {
        return res.status(404).json({ success: false, message: 'Letter template not found' });
      }

      const vars = { letter_date: formatLetterDateEnUS(), ...variables };
      const html = letterTemplate.bodyHtml
        ? nunjucks.renderString(letterTemplate.bodyHtml, vars)
        : `<pre style="white-space:pre-wrap;margin:0;">${nunjucks.renderString(letterTemplate.bodyText || '', vars)}</pre>`;

      const { pdfBuffer, branding, signatureKey } = await letterRenderedHtmlToPdf(
        tenantId,
        html,
        letterTemplate.name || 'Letter'
      );

      const filename = `${(name || letterTemplate.name || 'letter').replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      const upload = await uploadTenantAttachmentBuffer({
        tenantId,
        debtCaseId,
        filename,
        contentType: 'application/pdf',
        buffer: pdfBuffer,
      });

      const attachment = await TenantMessageAttachment.create({
        tenantId,
        debtCaseId,
        letterTemplateId,
        name: name || letterTemplate.name || 'Letter',
        type: 'generated_letter',
        fileKey: upload.key,
        mimeType: 'application/pdf',
        sizeBytes: upload.sizeBytes,
        originalFilename: filename,
        sha256: upload.sha256,
        meta: {
          templateId: letterTemplate.id,
          signatoryName: branding?.signatoryName ?? null,
          signatoryTitle: branding?.signatoryTitle ?? null,
          signedAt: signatureKey ? new Date().toISOString() : null,
        },
        isActive: true,
      });

      res.created(attachment, 'Letter attachment generated');
    } catch (error) {
      next(error);
    }
  },
};
