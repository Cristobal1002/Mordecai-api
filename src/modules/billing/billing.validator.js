import { param, body } from 'express-validator';

const tenantIdParam = param('tenantId').isUUID().withMessage('Invalid tenant ID format (UUID required)');

export const getUsageValidator = [tenantIdParam];

export const updateSubscriptionValidator = [
  tenantIdParam,
  body('callsPlan')
    .optional()
    .isIn(['none', 'starter', 'growth', 'pro'])
    .withMessage('callsPlan must be one of: none, starter, growth, pro'),
  body('whiteLabelEnabled').optional().isBoolean().withMessage('whiteLabelEnabled must be a boolean'),
  body('extraSeats').optional().isInt({ min: 0 }).withMessage('extraSeats must be a non-negative integer'),
  body('status')
    .optional()
    .isIn(['trialing', 'active', 'suspended'])
    .withMessage('status must be one of: trialing, active, suspended'),
  body('notes').optional().isString().withMessage('notes must be a string'),
];

export const createCheckoutValidator = [tenantIdParam];
export const createSubscribeIntentValidator = [tenantIdParam];
export const createPortalValidator = [tenantIdParam];
