import { param, body, query } from 'express-validator';

const tenantIdParam = param('tenantId').isUUID().withMessage('Invalid tenant ID');
const templateIdParam = param('templateId').isUUID().withMessage('Invalid template ID');
const attachmentIdParam = param('attachmentId').isUUID().withMessage('Invalid attachment ID');

export const letterAiDraftValidator = [
  tenantIdParam,
  body('prompt').optional().trim().isLength({ max: 12000 }).withMessage('prompt is too long'),
];

export const listTemplatesValidator = [
  tenantIdParam,
  query('channel')
    .optional()
    .isIn(['sms', 'email', 'letter'])
    .withMessage('channel must be sms, email or letter'),
];

export const getTemplateValidator = [tenantIdParam, templateIdParam];

export const createTemplateValidator = [
  tenantIdParam,
  body('channel').isIn(['sms', 'email', 'letter']).withMessage('channel must be sms, email or letter'),
  body('name').trim().notEmpty().withMessage('name is required').isLength({ max: 120 }),
  body('subject').optional().trim().isLength({ max: 500 }),
  body('bodyText').trim().notEmpty().withMessage('bodyText is required'),
  body('bodyHtml').optional().trim(),
  body('isActive').optional().isBoolean(),
];

export const updateTemplateValidator = [
  tenantIdParam,
  templateIdParam,
  body('name').optional().trim().notEmpty().isLength({ max: 120 }),
  body('subject').optional().trim().isLength({ max: 500 }),
  body('bodyText').optional().trim().notEmpty(),
  body('bodyHtml').optional().trim(),
  body('isActive').optional().isBoolean(),
];

export const deleteTemplateValidator = [tenantIdParam, templateIdParam];

export const listAttachmentsValidator = [tenantIdParam];

export const getAttachmentValidator = [tenantIdParam, attachmentIdParam];

export const createAttachmentValidator = [
  tenantIdParam,
  body('name').trim().notEmpty().withMessage('name is required').isLength({ max: 120 }),
  body('type').optional().trim().isLength({ max: 40 }),
  body('fileKey').trim().notEmpty().withMessage('fileKey is required').isLength({ max: 512 }),
  body('minDaysPastDue').optional({ nullable: true }).isInt({ min: 0 }),
  body('isActive').optional().isBoolean(),
];

export const updateAttachmentValidator = [
  tenantIdParam,
  attachmentIdParam,
  body('name').optional().trim().notEmpty().isLength({ max: 120 }),
  body('type').optional().trim().isLength({ max: 40 }),
  body('fileKey').optional().trim().notEmpty().isLength({ max: 512 }),
  body('minDaysPastDue').optional({ nullable: true }).isInt({ min: 0 }),
  body('isActive').optional().isBoolean(),
];

export const deleteAttachmentValidator = [tenantIdParam, attachmentIdParam];

export const previewTemplatePdfValidator = [
  tenantIdParam,
  templateIdParam,
  body('variables').optional().isObject().withMessage('variables must be an object'),
];

export const generateLetterAttachmentValidator = [
  tenantIdParam,
  body('letterTemplateId').isUUID().withMessage('letterTemplateId is required'),
  body('name').optional().trim().isLength({ max: 120 }),
  body('debtCaseId').optional({ nullable: true }).isUUID().withMessage('debtCaseId must be uuid'),
  body('variables').optional().isObject().withMessage('variables must be an object'),
];
