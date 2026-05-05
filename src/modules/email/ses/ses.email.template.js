import path from 'path';
import { fileURLToPath } from 'url';
import nunjucks from 'nunjucks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');

const TEMPLATE_KEY = process.env.SES_DEFAULT_TEMPLATE || 'collection-default';
const DEFAULT_CURRENCY = 'USD';

/** Long US date for formal letters, e.g. "February 4, 2026". */
export const formatLetterDateEnUS = (date = new Date()) => {
  try {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return formatLetterDateEnUS(new Date());
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(d);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

let renderer = null;

const getRenderer = () => {
  if (renderer) return renderer;
  renderer = nunjucks.configure(TEMPLATES_DIR, {
    autoescape: true,
    noCache: process.env.NODE_ENV !== 'production',
    trimBlocks: true,
    lstripBlocks: true,
  });
  return renderer;
};

const toCurrency = (amountDueCents, currency = DEFAULT_CURRENCY) => {
  const cents = Number(amountDueCents);
  if (!Number.isFinite(cents)) return null;
  const amount = cents / 100;

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

const normalizeInlineText = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeMultilineText = (value) => {
  const text = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
};

const renderStringText = (template, variables, { multiline = false } = {}) => {
  if (typeof template !== 'string' || !template.trim()) return null;
  const rendered = getRenderer().renderString(template, variables);
  return multiline ? normalizeMultilineText(rendered) : normalizeInlineText(rendered);
};

const renderStringHtml = (template, variables) => {
  if (typeof template !== 'string' || !template.trim()) return null;
  const rendered = getRenderer().renderString(template, variables);
  const normalized = String(rendered || '').trim();
  return normalized || null;
};

const renderFileText = (templatePath, variables) =>
  normalizeMultilineText(getRenderer().render(templatePath, variables));

const renderFileHtml = (templatePath, variables) => {
  const rendered = getRenderer().render(templatePath, variables);
  const normalized = String(rendered || '').trim();
  return normalized || null;
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const linkifyText = (value) =>
  String(value || '').replace(
    /(https?:\/\/[^\s<]+)/g,
    (match) => `<a href="${match}" style="color:#9c77f5;text-decoration:underline;">${match}</a>`
  );

const plainTextToHtml = (value) => {
  const text = normalizeMultilineText(value);
  if (!text) return '';

  return text
    .split('\n\n')
    .map((paragraph) => {
      const lineHtml = paragraph
        .split('\n')
        .map((line) => linkifyText(escapeHtml(line)))
        .join('<br />');
      return `<p style="margin:0 0 12px;color:#d1d5db;">${lineHtml}</p>`;
    })
    .join('\n');
};

const unwrapDocumentHtml = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const unwrapped = raw
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?(html|head|body)[^>]*>/gi, '')
    .trim();

  return unwrapped || null;
};

const looksLikeHtmlTemplate = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  // Basic heuristic: template contains at least one HTML tag.
  return /<[^>]+>/.test(normalized);
};

const resolveTemplateName = (stageRules = {}) => {
  // Stage email template IDs (UUIDs) point to DB rows in tenant_message_templates.
  // They are not Nunjucks file names and must not be used for file rendering.
  const customName =
    stageRules.email_template_key ||
    stageRules.emailTemplateKey ||
    null;

  return String(customName || TEMPLATE_KEY).trim() || 'collection-default';
};

const ELEVEN_TEMPLATE_FALLBACK = {
  agreement: process.env.SES_ELEVEN_AGREEMENT_TEMPLATE || 'eleven-agreement-link',
  dispute: process.env.SES_ELEVEN_DISPUTE_TEMPLATE || 'eleven-dispute-link',
};

const resolveElevenTemplateName = (context = 'agreement') => {
  const normalized = String(context || 'agreement').toLowerCase();
  return ELEVEN_TEMPLATE_FALLBACK[normalized] || ELEVEN_TEMPLATE_FALLBACK.agreement;
};

export const buildCollectionEmailVariables = ({
  debtCase,
  debtor,
  stage,
  tenant,
  custom = {},
}) => {
  const currency = debtCase?.currency || DEFAULT_CURRENCY;
  const amountDue = toCurrency(debtCase?.amountDueCents, currency) || `0.00 ${currency}`;
  const daysPastDue = Number.isFinite(Number(debtCase?.daysPastDue))
    ? String(debtCase.daysPastDue)
    : 'N/A';

  const meta = debtCase?.meta || {};
  const dm = debtor?.metadata && typeof debtor.metadata === 'object' ? debtor.metadata : {};
  const propertyAddress =
    meta.property_address ||
    meta.propertyAddress ||
    '';
  const debtorAddress =
    meta.debtor_address ||
    meta.debtorAddress ||
    (typeof dm.mailing_address_single_line === 'string' ? dm.mailing_address_single_line : '') ||
    '';
  return {
    tenant_name: tenant?.name || '',
    debtor_name: debtor?.fullName || 'there',
    debtor_email: debtor?.email || '',
    amount_due: amountDue,
    amount_due_cents: Number(debtCase?.amountDueCents || 0),
    currency,
    days_past_due: daysPastDue,
    due_date: debtCase?.dueDate || '',
    letter_date: formatLetterDateEnUS(new Date()),
    stage_name: stage?.name || 'collection stage',
    payment_link: custom.paymentLink || debtCase?.paymentLinkUrl || '',
    case_id: debtCase?.id || '',
    property_name: meta.property_name || meta.propertyName || 'your account',
    property_address: propertyAddress,
    debtor_address: debtorAddress,
    unit_number: meta.unit_number || meta.unitNumber || '',
    lease_number: meta.lease_number || meta.leaseNumber || meta.lease_id || '',
    ...custom,
  };
};

export const renderElevenLinkEmail = ({
  context = 'agreement',
  tenantName,
  debtorName,
  paymentLinkUrl,
  custom = {},
}) => {
  const templateName = resolveElevenTemplateName(context);
  const variables = {
    tenant_name: tenantName || 'Collections',
    debtor_name: debtorName || 'there',
    payment_link: paymentLinkUrl || '',
    ...custom,
  };

  const subject = renderFileText(`collections/${templateName}.subject.njk`, variables);
  const html = renderFileHtml(`collections/${templateName}.html.njk`, variables);
  const text = renderFileText(`collections/${templateName}.txt.njk`, variables);

  return { subject, html, text, templateName, variables };
};

export const renderCollectionEmail = ({
  debtCase,
  debtor,
  stage,
  tenant,
  messageTemplate = null,
  custom = {},
}) => {
  const stageRules = stage?.rules || {};
  const variables = buildCollectionEmailVariables({ debtCase, debtor, stage, tenant, custom });
  const templateName = resolveTemplateName(stageRules);

  const templateSubject = messageTemplate?.subject || null;
  const templateText = messageTemplate?.bodyText || null;
  const templateHtml = messageTemplate?.bodyHtml || null;

  // Some tenants store plain text in bodyHtml from UI; in that case we should
  // still render inside the branded HTML layout instead of sending bare text.
  const normalizedTemplateHtml = looksLikeHtmlTemplate(templateHtml) ? templateHtml : null;
  const normalizedTemplateText =
    templateText || (!normalizedTemplateHtml ? templateHtml : null);

  const subjectTemplate =
    templateSubject ||
    stageRules.email_subject_template ||
    stageRules.emailSubjectTemplate ||
    null;
  const htmlTemplate =
    normalizedTemplateHtml ||
    stageRules.email_html_template ||
    stageRules.emailHtmlTemplate ||
    null;
  const textTemplate =
    normalizedTemplateText ||
    stageRules.email_text_template ||
    stageRules.emailTextTemplate ||
    null;

  const hasTenantTemplate = Boolean(normalizedTemplateText || normalizedTemplateHtml);
  const renderedTemplateHtml = unwrapDocumentHtml(renderStringHtml(htmlTemplate, variables));
  const renderedTemplateText = renderStringText(normalizedTemplateText, variables, {
    multiline: true,
  });
  const customEmailBodyHtml = renderedTemplateHtml || (renderedTemplateText ? plainTextToHtml(renderedTemplateText) : '');

  const subject = renderStringText(subjectTemplate, variables)
    || (hasTenantTemplate ? `Payment reminder from ${variables.tenant_name || 'your collections team'}` : null)
    || renderFileText(`collections/${templateName}.subject.njk`, variables);

  // Always render through the branded layout template.
  const html = renderFileHtml(`collections/${templateName}.html.njk`, {
    ...variables,
    custom_email_body_html: customEmailBodyHtml,
  });

  const text = renderStringText(textTemplate, variables, { multiline: true })
    || (hasTenantTemplate ? renderedTemplateText : null)
    || renderFileText(`collections/${templateName}.txt.njk`, variables);

  return { subject, html, text, templateName, variables };
};

