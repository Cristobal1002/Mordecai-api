import { param, body } from 'express-validator';

const tenantIdParam = param('tenantId').isUUID().withMessage('Invalid tenant ID');

export const getBrandingValidator = [tenantIdParam];

export const logoUploadValidator = [tenantIdParam];

export const upsertBrandingValidator = [
  tenantIdParam,
  body('companyName').optional({ checkFalsy: true }).trim().isLength({ max: 160 }),
  body('logoUrl').optional({ checkFalsy: true }).trim().custom((v) => !v || /^https?:\/\/.+/.test(v) || v.startsWith('tenants/')).withMessage('logoUrl must be a valid URL or S3 key when provided'),
  body('primaryColor').optional({ checkFalsy: true }).trim().matches(/^#[0-9A-Fa-f]{6}$/).withMessage('primaryColor must be hex (e.g. #9C77F5)'),
  body('secondaryColor').optional({ checkFalsy: true }).trim().matches(/^#[0-9A-Fa-f]{6}$/).withMessage('secondaryColor must be hex'),
  body('supportEmail').optional({ checkFalsy: true }).trim().isEmail().withMessage('supportEmail must be valid email'),
  body('supportPhone').optional({ checkFalsy: true }).trim().isLength({ max: 40 }),
  body('footerText').optional({ checkFalsy: true }).trim(),
  body('signatoryName').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('signatoryTitle').optional({ nullable: true }).trim().isLength({ max: 160 }),
];
