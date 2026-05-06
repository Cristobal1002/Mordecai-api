/**
 * Resolve Stripe Price IDs from DB (stripe_billing_prices) instead of env vars.
 */
import { StripeBillingPrice } from '../../models/index.js';

/** Stable keys — must match rows inserted for each stripe_mode. */
export const BILLING_PRICE_KEYS = Object.freeze({
  PLATFORM_BASE: 'platform_base',
  PMS_UNITS_METERED: 'pms_units_metered',
  CALLS_NONE: 'calls_none',
  CALLS_STARTER: 'calls_starter',
  CALLS_GROWTH: 'calls_growth',
  CALLS_PRO: 'calls_pro',
  WHITE_LABEL: 'white_label',
  SEAT_EXTRA: 'seat_extra',
});

export class StripePriceCatalogError extends Error {
  constructor(message, { billingKey, stripeMode } = {}) {
    super(message);
    this.name = 'StripePriceCatalogError';
    this.billingKey = billingKey;
    this.stripeMode = stripeMode;
  }
}

/**
 * test | live. Override with STRIPE_MODE=test|live; else live in production, test otherwise.
 */
export const resolveStripeMode = () => {
  const explicit = process.env.STRIPE_MODE?.trim().toLowerCase();
  if (explicit === 'live' || explicit === 'test') return explicit;
  return process.env.NODE_ENV === 'production' ? 'live' : 'test';
};

/**
 * @param {string} billingKey - One of BILLING_PRICE_KEYS.*
 * @param {{ stripeMode?: string }} [options]
 * @returns {Promise<string>} stripe price id (price_...)
 */
export const getBillingPriceId = async (billingKey, options = {}) => {
  const stripeMode = options.stripeMode || resolveStripeMode();
  const row = await StripeBillingPrice.findOne({
    where: { billingKey, stripeMode, active: true },
    attributes: ['stripePriceId'],
  });
  if (!row) {
    throw new StripePriceCatalogError(
      `No active Stripe price for billing_key=${billingKey} stripe_mode=${stripeMode}`,
      { billingKey, stripeMode },
    );
  }
  return row.stripePriceId;
};

/**
 * @param {{ stripeMode?: string }} [options]
 * @returns {Promise<Record<string, string>>} billingKey → stripePriceId
 */
export const getBillingPriceMap = async (options = {}) => {
  const stripeMode = options.stripeMode || resolveStripeMode();
  const rows = await StripeBillingPrice.findAll({
    where: { stripeMode, active: true },
    attributes: ['billingKey', 'stripePriceId'],
  });
  return Object.fromEntries(rows.map((r) => [r.billingKey, r.stripePriceId]));
};

/**
 * @param {string} callsPlan - tenant_subscriptions.calls_plan: none | starter | growth | pro
 * @param {{ stripeMode?: string }} [options]
 */
export const getCallsPlanBillingKey = (callsPlan) => {
  const p = String(callsPlan || 'none').toLowerCase();
  if (p === 'starter') return BILLING_PRICE_KEYS.CALLS_STARTER;
  if (p === 'growth') return BILLING_PRICE_KEYS.CALLS_GROWTH;
  if (p === 'pro') return BILLING_PRICE_KEYS.CALLS_PRO;
  return BILLING_PRICE_KEYS.CALLS_NONE;
};
