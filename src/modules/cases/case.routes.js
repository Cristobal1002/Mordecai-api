import { Router } from 'express';
import { caseController } from './case.controller.js';
import { requireAuth } from '../../middlewares/index.js';
import {
  getCaseValidator,
  getTimelineValidator,
  pauseCaseValidator,
  resumeCaseValidator,
  triggerCallValidator,
  updateDebtorForCaseValidator,
  patchCaseInternalNotesValidator,
} from './case.validator.js';
import { validateRequest } from '../../middlewares/validate-request.middleware.js';

const router = Router();

// GET /api/v1/tenants/:tenantId/cases/:caseId
router.get('/:tenantId/cases/:caseId', getCaseValidator, validateRequest, caseController.getDetail);

// GET /api/v1/tenants/:tenantId/cases/:caseId/timeline
router.get(
  '/:tenantId/cases/:caseId/timeline',
  getTimelineValidator,
  validateRequest,
  caseController.getTimeline
);

// POST /api/v1/tenants/:tenantId/cases/:caseId/pause
router.post(
  '/:tenantId/cases/:caseId/pause',
  pauseCaseValidator,
  validateRequest,
  caseController.pause
);

// POST /api/v1/tenants/:tenantId/cases/:caseId/resume
router.post(
  '/:tenantId/cases/:caseId/resume',
  resumeCaseValidator,
  validateRequest,
  caseController.resume
);

// POST /api/v1/tenants/:tenantId/cases/:caseId/trigger-call
router.post(
  '/:tenantId/cases/:caseId/trigger-call',
  requireAuth(),
  triggerCallValidator,
  validateRequest,
  caseController.triggerCall
);

// PATCH /api/v1/tenants/:tenantId/cases/:caseId/debtor — correct name / email / phone after PMS mistakes
router.patch(
  '/:tenantId/cases/:caseId/debtor',
  requireAuth(),
  updateDebtorForCaseValidator,
  validateRequest,
  caseController.updateDebtorForCase
);

// PATCH /api/v1/tenants/:tenantId/cases/:caseId/internal-notes — staff notes (not from PMS)
router.patch(
  '/:tenantId/cases/:caseId/internal-notes',
  requireAuth(),
  patchCaseInternalNotesValidator,
  validateRequest,
  caseController.patchInternalNotes
);

export default router;
