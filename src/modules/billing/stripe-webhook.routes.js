import { Router } from 'express';
import { stripeWebhookController } from './stripe-webhook.controller.js';

const router = Router();

// Stripe webhooks must NOT require auth. Signature is validated using STRIPE_WEBHOOK_SECRET.
router.post('/stripe/webhook', stripeWebhookController.handle);

export default router;

