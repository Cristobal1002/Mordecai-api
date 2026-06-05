import { resolveStripeMode } from './stripe-price-catalog.service.js';
import { StripeWebhookEvent, Tenant, TenantSubscription } from '../../models/index.js';
import { getStripeClient } from './stripe.client.js';
import { logger } from '../../utils/logger.js';
import { stripeBillingService } from './stripe-billing.service.js';
import { buildNewSubscriptionDefaults } from './billing-trial.service.js';

const getRawBody = (req) =>
  typeof req.rawBody === 'string'
    ? req.rawBody
    : Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : JSON.stringify(req.body || {});

const getWebhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET;

const upsertStripeStateFromSubscription = async (tenantId, subObj) => {
  const stripeSubId = subObj.id;
  const items = subObj.items?.data || [];
  const byRecurringPrice = (it) => it?.price?.id || it?.plan?.id || null;

  // Keep a simple mapping by matching known stored item ids if already present.
  const itemIds = items.map((it) => ({ id: it.id, priceId: byRecurringPrice(it) }));

  const [row] = await TenantSubscription.findOrCreate({
    where: { tenantId },
    defaults: buildNewSubscriptionDefaults(),
  });

  const status = String(subObj.status || '').toLowerCase();
  const mappedStatus =
    status === 'active' || status === 'trialing'
      ? 'active'
      : status === 'past_due' || status === 'unpaid'
        ? 'suspended'
        : status === 'canceled'
          ? 'suspended'
          : row.status;

  await row.update({
    stripeSubscriptionId: stripeSubId,
    currentPeriodStart: subObj.current_period_start ? new Date(subObj.current_period_start * 1000) : row.currentPeriodStart,
    currentPeriodEnd: subObj.current_period_end ? new Date(subObj.current_period_end * 1000) : row.currentPeriodEnd,
    status: mappedStatus,
  });

  return { row, itemIds };
};

export const stripeWebhookController = {
  handle: async (req, res, next) => {
    try {
      const stripe = getStripeClient();
      const secret = getWebhookSecret();
      if (!secret) {
        res.status(500).json({ success: false, message: 'Missing STRIPE_WEBHOOK_SECRET' });
        return;
      }

      const sig = req.headers['stripe-signature'];
      const rawBody = getRawBody(req);
      const event = stripe.webhooks.constructEvent(rawBody, sig, secret);

      const stripeMode = resolveStripeMode();
      const existing = await StripeWebhookEvent.findOne({
        where: { stripeEventId: event.id, stripeMode },
        attributes: ['id'],
      });
      if (existing) {
        res.json({ received: true, dedup: true });
        return;
      }

      // Store idempotency marker first to avoid duplicate processing on retries.
      await StripeWebhookEvent.create({
        stripeEventId: event.id,
        stripeMode,
        type: event.type,
      });

      const type = event.type;
      const obj = event.data?.object;

      if (type.startsWith('customer.subscription.') && obj?.customer) {
        const customerId = obj.customer;
        const tenant = await Tenant.findOne({
          where: { stripeCustomerId: customerId },
          attributes: ['id', 'stripeCustomerId'],
        });
        if (tenant) {
          await upsertStripeStateFromSubscription(tenant.id, obj);
        } else {
          logger.warn({ customerId, type }, 'Stripe webhook: tenant not found for customer');
        }
      }

      if (type === 'invoice.payment_succeeded' && obj?.customer) {
        const tenant = await Tenant.findOne({
          where: { stripeCustomerId: obj.customer },
          attributes: ['id'],
        });
        if (tenant) {
          const [row] = await TenantSubscription.findOrCreate({
            where: { tenantId: tenant.id },
            defaults: { status: 'active', callsPlan: 'none' },
          });
          await row.update({ status: 'active' });
          try {
            await stripeBillingService.syncSubscriptionItemsFromDb(tenant.id);
          } catch (err) {
            logger.warn({ err, tenantId: tenant.id }, 'Stripe webhook: sync subscription items after payment failed');
          }
        }
      }

      if (type === 'invoice.payment_failed' && obj?.customer) {
        const tenant = await Tenant.findOne({
          where: { stripeCustomerId: obj.customer },
          attributes: ['id'],
        });
        if (tenant) {
          const [row] = await TenantSubscription.findOrCreate({
            where: { tenantId: tenant.id },
            defaults: { status: 'suspended', callsPlan: 'none' },
          });
          await row.update({ status: 'suspended' });
        }
      }

      res.json({ received: true });
    } catch (error) {
      next(error);
    }
  },
};

