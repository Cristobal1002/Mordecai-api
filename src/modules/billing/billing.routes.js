import { Router } from 'express';
import { requireAuth } from '../../middlewares/index.js';
import { validateRequest } from '../../middlewares/validate-request.middleware.js';
import { billingController } from './billing.controller.js';
import {
  getUsageValidator,
  updateSubscriptionValidator,
  createCheckoutValidator,
  createSubscribeIntentValidator,
  createPortalValidator,
} from './billing.validator.js';

const router = Router();

router.get(
  '/:tenantId/billing/usage',
  requireAuth(),
  getUsageValidator,
  validateRequest,
  billingController.getUsage
);

router.patch(
  '/:tenantId/billing/subscription',
  requireAuth(),
  updateSubscriptionValidator,
  validateRequest,
  billingController.updateSubscription
);

router.post(
  '/:tenantId/billing/checkout',
  requireAuth(),
  createCheckoutValidator,
  validateRequest,
  billingController.createCheckout
);

router.post(
  '/:tenantId/billing/subscribe-intent',
  requireAuth(),
  createSubscribeIntentValidator,
  validateRequest,
  billingController.createSubscribeIntent
);

router.post(
  '/:tenantId/billing/portal',
  requireAuth(),
  createPortalValidator,
  validateRequest,
  billingController.createPortal
);

export default router;
