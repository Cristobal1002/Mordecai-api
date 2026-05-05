import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

let sesClient = null;

const getSesConfig = () => {
  const region = process.env.AWS_REGION;
  const fromEmail = process.env.SES_FROM_EMAIL;
  const replyToEmail = process.env.SES_REPLY_TO_EMAIL || null;
  const configurationSetName = process.env.SES_CONFIGURATION_SET || null;

  if (!region || !fromEmail) {
    throw new Error('Missing AWS_REGION or SES_FROM_EMAIL for SES email dispatch');
  }

  return { region, fromEmail, replyToEmail, configurationSetName };
};

const getSesClient = (region) => {
  if (sesClient) return sesClient;
  sesClient = new SESv2Client({ region });
  return sesClient;
};

const normalizeTags = (tags) => {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => ({
      Name: String(tag?.name || '').trim(),
      Value: String(tag?.value || '').trim(),
    }))
    .filter((tag) => tag.Name && tag.Value);
};

export const sendSesEmail = async ({ to, subject, html, text, tags = [] }) => {
  const { region, fromEmail, replyToEmail, configurationSetName } = getSesConfig();
  const client = getSesClient(region);

  const recipients = Array.isArray(to) ? to : [to];
  const toAddresses = recipients
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (toAddresses.length === 0) {
    throw new Error('Email recipient is required');
  }

  const htmlBody = String(html || '').trim();
  if (!htmlBody) {
    throw new Error('Email HTML body is required');
  }

  const emailTags = normalizeTags(tags);
  const command = new SendEmailCommand({
    FromEmailAddress: fromEmail,
    ReplyToAddresses: replyToEmail ? [replyToEmail] : undefined,
    ConfigurationSetName: configurationSetName || undefined,
    Destination: {
      ToAddresses: toAddresses,
    },
    Content: {
      Simple: {
        Subject: {
          Data: String(subject || '').trim() || 'Collections notification',
          Charset: 'UTF-8',
        },
        Body: {
          Text: text
            ? {
                Data: String(text),
                Charset: 'UTF-8',
              }
            : undefined,
          Html: htmlBody
            ? {
                Data: htmlBody,
                Charset: 'UTF-8',
              }
            : undefined,
        },
      },
    },
    EmailTags: emailTags.length > 0 ? emailTags : undefined,
  });

  const response = await client.send(command);
  return {
    messageId: response?.MessageId || null,
    status: 'queued',
    to: toAddresses,
  };
};

/**
 * Send email with attachments using SESv2 Raw content.
 * Uses nodemailer only to construct MIME (no SMTP transport).
 *
 * @param {object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.text]
 * @param {Array<{ filename: string; contentType: string; content: Buffer }>} [opts.attachments]
 * @param {Array<{ name: string; value: string }>} [opts.tags]
 */
export const sendSesEmailWithAttachments = async ({
  to,
  subject,
  html,
  text,
  attachments = [],
  tags = [],
}) => {
  const { region, fromEmail, replyToEmail, configurationSetName } = getSesConfig();
  const client = getSesClient(region);

  const recipients = Array.isArray(to) ? to : [to];
  const toAddresses = recipients.map((v) => String(v || '').trim()).filter(Boolean);
  if (toAddresses.length === 0) throw new Error('Email recipient is required');

  const htmlBody = String(html || '').trim();
  if (!htmlBody) throw new Error('Email HTML body is required');

  const emailTags = normalizeTags(tags);

  const message = {
    from: fromEmail,
    to: toAddresses,
    subject: String(subject || '').trim() || 'Collections notification',
    replyTo: replyToEmail || undefined,
    text: text ? String(text) : undefined,
    html: htmlBody,
    attachments: (attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  };

  const raw = await new Promise((resolve, reject) => {
    const composer = new MailComposer(message);
    composer.compile().build((err, messageBuf) => {
      if (err) return reject(err);
      resolve(messageBuf);
    });
  });

  const command = new SendEmailCommand({
    FromEmailAddress: fromEmail,
    ReplyToAddresses: replyToEmail ? [replyToEmail] : undefined,
    ConfigurationSetName: configurationSetName || undefined,
    Destination: { ToAddresses: toAddresses },
    Content: {
      Raw: {
        Data: raw,
      },
    },
    EmailTags: emailTags.length > 0 ? emailTags : undefined,
  });

  const response = await client.send(command);
  return {
    messageId: response?.MessageId || null,
    status: 'queued',
    to: toAddresses,
  };
};

