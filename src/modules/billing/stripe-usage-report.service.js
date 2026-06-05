import { Op } from 'sequelize';
import { TenantSubscription } from '../../models/index.js';
import { countBillableDebtCases } from './billable-debt-cases.js';
import { logger } from '../../utils/logger.js';
import { getStripeClient } from './stripe.client.js';
import { resolveStripeMode } from './stripe-price-catalog.service.js';

const INCLUDED_UNITS = Number(process.env.STRIPE_INCLUDED_UNITS) || 200;

/**
 * Daily usage report: sets metered usage quantity to current overage units.
 * Simple snapshot model (action='set') — good enough for monthly invoices.
 */
export async function stripeUsageReportDailyMaintenance() {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    logger.info('Stripe usage report skipped (missing STRIPE_SECRET_KEY)');
    return { skipped: true, reason: 'missing_key' };
  }

  const stripe = getStripeClient();
  const stripeMode = resolveStripeMode();

  const subs = await TenantSubscription.findAll({
    where: {
      stripeSubscriptionId: { [Op.ne]: null },
      stripeUnitsItemId: { [Op.ne]: null },
      status: { [Op.in]: ['active', 'trialing'] },
    },
    attributes: ['tenantId', 'stripeUnitsItemId', 'stripeSubscriptionId'],
    limit: 2000,
  });

  let reported = 0;
  let errors = 0;
  for (const row of subs) {
    const tenantId = row.tenantId;
    const unitCount = await countBillableDebtCases(tenantId);
    const overage = Math.max(0, Number(unitCount) - INCLUDED_UNITS);
    try {
      // eslint-disable-next-line no-await-in-loop
      await stripe.subscriptionItems.createUsageRecord(row.stripeUnitsItemId, {
        quantity: overage,
        timestamp: 'now',
        action: 'set',
      });
      reported += 1;
    } catch (err) {
      errors += 1;
      logger.error(
        { tenantId, stripeMode, subscriptionId: row.stripeSubscriptionId, itemId: row.stripeUnitsItemId, err },
        'Stripe usage report failed'
      );
    }
  }

  return { ok: true, stripeMode, reported, errors, includedUnits: INCLUDED_UNITS };
}

