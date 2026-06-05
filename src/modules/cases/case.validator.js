import { body, param, query } from 'express-validator';

const tenantIdParam = param('tenantId').isUUID().withMessage('Invalid tenant ID format (UUID required)');
const caseIdParam = param('caseId').isUUID().withMessage('Invalid case ID format (UUID required)');

const e164PhoneRegex = /^\+[1-9]\d{7,14}$/;
const normalizePhone = (v) =>
  v === null || v === undefined || typeof v !== 'string' ? v : v.replace(/[\s()-]/g, '');

export const getCaseValidator = [tenantIdParam, caseIdParam];

export const getTimelineValidator = [
  tenantIdParam,
  caseIdParam,
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
];

export const pauseCaseValidator = [
  tenantIdParam,
  caseIdParam,
  body('automationId').optional().isUUID().withMessage('automationId must be a valid UUID'),
];

export const resumeCaseValidator = [
  tenantIdParam,
  caseIdParam,
  body('automationId').optional().isUUID().withMessage('automationId must be a valid UUID'),
];

export const triggerCallValidator = [tenantIdParam, caseIdParam];

export const patchCaseInternalNotesValidator = [
  tenantIdParam,
  caseIdParam,
  body('internalNotes')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 20000 })
    .withMessage('internalNotes must be a string at most 20000 characters'),
];

export const updateDebtorForCaseValidator = [
  tenantIdParam,
  caseIdParam,
  body('fullName').optional().trim().notEmpty().isLength({ max: 160 }),
  body('email').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('phone')
    .optional({ nullable: true })
    .customSanitizer((v) => {
      if (v === '' || v === undefined) return null;
      return normalizePhone(v);
    })
    .custom((v) => v == null || v === '' || e164PhoneRegex.test(String(v)))
    .withMessage('phone must be E.164 (e.g. +15551234567) or empty to clear'),
];
