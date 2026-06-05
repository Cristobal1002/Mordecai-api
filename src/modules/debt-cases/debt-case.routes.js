
import { Router } from 'express';
import { debtCaseController } from './debt-case.controller.js';
import { validateRequest } from '../../middlewares/validate-request.middleware.js';
import { param, body } from 'express-validator';
import { requireAuth } from '../../middlewares/index.js';

const router = Router();

const validateTenant = [
    param('tenantId').isUUID().withMessage('Invalid Tenant ID')
];

const validateCase = [
    ...validateTenant,
    param('caseId').isUUID().withMessage('Invalid Case ID')
];

const validateMordecaiOperationalBody = [
    body('active').isBoolean().withMessage('active must be a boolean'),
];

const validateCaseId = [
    param('caseId').isUUID().withMessage('Invalid Case ID')
];

// GET /api/v1/debt-cases/payment-instructions/:caseId — tenant inferred from auth
router.get(
    '/payment-instructions/:caseId',
    requireAuth(),
    validateCaseId,
    validateRequest,
    debtCaseController.getPaymentInstructions
);

// GET /api/v1/debt-cases/:tenantId
router.get(
    '/:tenantId',
    requireAuth(),
    validateTenant,
    validateRequest,
    debtCaseController.list
);

// GET /api/v1/debt-cases/:tenantId/:caseId/logs
router.get(
    '/:tenantId/:caseId/logs',
    requireAuth(),
    validateCase,
    validateRequest,
    debtCaseController.getLogs
);

// PATCH /api/v1/debt-cases/:tenantId/:caseId/mordecai-operational-active
router.patch(
    '/:tenantId/:caseId/mordecai-operational-active',
    requireAuth(),
    ...validateCase,
    ...validateMordecaiOperationalBody,
    validateRequest,
    debtCaseController.setMordecaiOperationalActive
);

export default router;
