import { CollectionEvent, InteractionLog, Tenant } from '../../../models/index.js';
import { logger } from '../../../utils/logger.js';
import { sendSesEmail, sendSesEmailWithAttachments } from './ses.email.client.js';
import { renderCollectionEmail } from './ses.email.template.js';
import { getOrCreatePaymentLinkUrl } from '../../pay/payment-link-resolver.service.js';
import { resolveChannelTemplate } from '../../templates/template-resolution.service.js';
import nunjucks from 'nunjucks';
import { TenantBranding, TenantMessageAttachment } from '../../../models/index.js';
import { renderHtmlToPdfBuffer } from '../../../utils/pdf-generator.js';
import { stampSignatureOnPdf } from '../../../utils/pdf-signer.js';
import { getTenantAttachmentBuffer, uploadTenantAttachmentBuffer } from '../../../utils/attachments.storage.js';
import {
  prepareLetterHtmlWithOptionalSignature,
  normalizeSignatureMarkersToComment,
} from '../../../utils/letter-signature-inject.js';

const createCollectionEvent = async ({
  automationId,
  debtCaseId,
  eventType,
  payload,
}) => {
  if (!automationId) return null;
  return CollectionEvent.create({
    automationId,
    debtCaseId,
    channel: 'email',
    eventType,
    payload,
  });
};

const createInteractionLog = async ({
  tenantId,
  debtCaseId,
  debtorId,
  status = 'queued',
}) =>
  InteractionLog.create({
    tenantId,
    debtCaseId,
    debtorId,
    type: 'EMAIL',
    status,
    channelProvider: 'ses',
    direction: 'OUTBOUND',
    startedAt: new Date(),
  });

const summarizeText = (text, maxLength = 500) => {
  const clean = String(text || '').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3)}...`;
};

export const sendCollectionEmail = async ({
  tenantId,
  automationId,
  state,
  debtCase,
  debtor,
  stage,
}) => {
  const debtCaseId = debtCase?.id || state?.debtCaseId;
  const debtorId = debtor?.id || debtCase?.debtorId || null;
  const to = String(debtor?.email || '').trim();

  if (!to) {
    await createCollectionEvent({
      automationId,
      debtCaseId,
      eventType: 'email_skipped_invalid_contact',
      payload: {
        reason: 'missing_email',
      },
    });

    return {
      ok: false,
      channel: 'email',
      outcome: 'email_invalid_contact',
      message: 'Debtor email is missing.',
    };
  }

  let interaction = null;

  try {
    const emailTemplate = await resolveChannelTemplate({
      tenantId,
      channel: 'email',
      stage: stage || null,
    });
    if (!emailTemplate.template) {
      await createCollectionEvent({
        automationId,
        debtCaseId,
        eventType: 'email_skipped_missing_template',
        payload: {
          reason:
            emailTemplate.reason === 'stage_template_not_found'
              ? 'Email template configured in stage was not found or is inactive'
              : 'Email template is not configured for this stage',
          templateReason: emailTemplate.reason,
        },
      });
      return {
        ok: false,
        channel: 'email',
        outcome: 'email_missing_template',
        message: 'Email template is missing',
      };
    }

    const tenant = tenantId ? await Tenant.findByPk(tenantId, { attributes: ['name'] }) : null;
    const paymentLink = await getOrCreatePaymentLinkUrl({
      tenantId,
      debtCaseId,
      paymentAgreementId: debtCase?.meta?.last_agreement_id || null,
    });
    const rendered = renderCollectionEmail({
      debtCase,
      debtor,
      stage,
      tenant,
      messageTemplate: emailTemplate.template,
      custom: { paymentLink },
    });
    const htmlBody = String(rendered.html || '').trim();
    if (!htmlBody) {
      throw new Error('Rendered collection email HTML body is empty');
    }

    interaction = await createInteractionLog({
      tenantId,
      debtCaseId,
      debtorId,
      status: 'queued',
    });

    // Optional: attach generated letter if stage has letter_template_id configured.
    let emailAttachments = [];
    const letterTemplate = await resolveChannelTemplate({
      tenantId,
      channel: 'letter',
      stage: stage || null,
    });
    if (letterTemplate?.template) {
      try {
        const letterHtmlRaw = letterTemplate.template.bodyHtml
          ? nunjucks.renderString(letterTemplate.template.bodyHtml, rendered.variables)
          : `<pre style="white-space:pre-wrap;margin:0;">${nunjucks.renderString(
              letterTemplate.template.bodyText || '',
              rendered.variables
            )}</pre>`;
        const letterHtml = normalizeSignatureMarkersToComment(letterHtmlRaw);

        const branding = await TenantBranding.findOne({ where: { tenantId } });
        const signatureKey = branding?.signatureImageKey || null;
        let signatureBuf = null;
        if (signatureKey) {
          try {
            signatureBuf = await getTenantAttachmentBuffer(signatureKey);
          } catch (sigErr) {
            logger.warn({ err: sigErr?.message, tenantId, signatureKey }, 'Could not load signature image for letter');
          }
        }

        const { htmlForPdf, usedAnchor } = prepareLetterHtmlWithOptionalSignature(
          letterHtml,
          branding,
          signatureBuf
        );
        let pdfBuffer = await renderHtmlToPdfBuffer({
          html: htmlForPdf,
          title: letterTemplate.template.name || 'Letter',
        });
        if (signatureBuf?.length && !usedAnchor) {
          pdfBuffer = await stampSignatureOnPdf({
            pdfBuffer,
            signaturePngBuffer: signatureBuf,
            signatoryName: branding?.signatoryName ?? undefined,
            signatoryTitle: branding?.signatoryTitle ?? undefined,
          });
        }

        const filename = `${(letterTemplate.template.name || 'letter')
          .replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
        const upload = await uploadTenantAttachmentBuffer({
          tenantId,
          debtCaseId,
          filename,
          contentType: 'application/pdf',
          buffer: pdfBuffer,
        });

        await TenantMessageAttachment.create({
          tenantId,
          debtCaseId,
          letterTemplateId: letterTemplate.template.id,
          name: letterTemplate.template.name || 'Letter',
          type: 'generated_letter',
          fileKey: upload.key,
          mimeType: 'application/pdf',
          sizeBytes: upload.sizeBytes,
          originalFilename: filename,
          sha256: upload.sha256,
          meta: {
            templateId: letterTemplate.template.id,
            signatoryName: branding?.signatoryName ?? null,
            signatoryTitle: branding?.signatoryTitle ?? null,
            signedAt: signatureKey ? new Date().toISOString() : null,
          },
          isActive: true,
        });

        emailAttachments = [{ filename, contentType: 'application/pdf', content: pdfBuffer }];
      } catch (e) {
        logger.warn(
          { err: e?.message, tenantId, debtCaseId, letterTemplateId: letterTemplate.template.id },
          'Letter attachment generation failed; sending email without letter'
        );
      }
    }

    const providerResult = emailAttachments.length
      ? await sendSesEmailWithAttachments({
          to,
          subject: rendered.subject,
          html: htmlBody,
          text: rendered.text,
          attachments: emailAttachments,
          tags: [
            { name: 'tenant_id', value: String(tenantId) },
            { name: 'debt_case_id', value: String(debtCaseId) },
            { name: 'interaction_id', value: String(interaction.id) },
            { name: 'channel', value: 'email' },
          ],
        })
      : await sendSesEmail({
          to,
          subject: rendered.subject,
          html: htmlBody,
          text: rendered.text,
          tags: [
            { name: 'tenant_id', value: String(tenantId) },
            { name: 'debt_case_id', value: String(debtCaseId) },
            { name: 'interaction_id', value: String(interaction.id) },
            { name: 'channel', value: 'email' },
          ],
        });

    await interaction.update({
      status: 'sent',
      providerRef: providerResult.messageId,
      summary: summarizeText(rendered.text),
      endedAt: new Date(),
      aiData: {
        ...(interaction.aiData || {}),
        email: {
          template: rendered.templateName,
          subject: rendered.subject,
        },
      },
    });

    await createCollectionEvent({
      automationId,
      debtCaseId,
      eventType: 'email_sent',
      payload: {
        interactionLogId: interaction.id,
        messageId: providerResult.messageId,
        to,
        subject: rendered.subject,
        template: rendered.templateName,
      },
    });

    return {
      ok: true,
      channel: 'email',
      outcome: 'email_sent',
      interactionLogId: interaction.id,
      providerRef: providerResult.messageId,
    };
  } catch (error) {
    logger.error(
      { err: error, tenantId, debtCaseId, automationId },
      'Failed to send collection email'
    );

    if (interaction) {
      await interaction.update({
        status: 'failed',
        outcome: 'FAILED',
        endedAt: new Date(),
        error: {
          message: error?.message || 'Email dispatch failed',
        },
      });
    } else if (tenantId && debtCaseId && debtorId) {
      await createInteractionLog({
        tenantId,
        debtCaseId,
        debtorId,
        status: 'failed',
      });
    }

    await createCollectionEvent({
      automationId,
      debtCaseId,
      eventType: 'email_failed',
      payload: {
        interactionLogId: interaction?.id || null,
        reason: error?.message || 'Email dispatch failed',
      },
    });

    return {
      ok: false,
      channel: 'email',
      outcome: 'email_failed',
      message: error?.message || 'Email dispatch failed',
    };
  }
};

