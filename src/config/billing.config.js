/**
 * Billing pricing configuration.
 * All price values in cents. NEVER hardcode prices in services — import from here.
 */

/** Minimum monthly fee (cents) */
export const MINIMUM_MONTHLY_CENTS = 30_000; // $300

/** Marginal pricing tiers: [max_units_in_tier, rate_cents_per_unit] */
export const UNIT_TIERS = [
  { maxUnits: 500, rateCents: 150, label: 'First 500 units' },
  { maxUnits: 1000, rateCents: 125, label: 'Units 501–1,500' },
  { maxUnits: 3500, rateCents: 100, label: 'Units 1,501–5,000' },
  { maxUnits: Infinity, rateCents: 90, label: 'Units 5,000+' },
];

/** AI Calls plan add-on (cents/month) */
export const CALLS_PLAN_CENTS = {
  none: 0,
  starter: 14_900,   // $149
  growth: 29_900,    // $299
  pro: 59_900,       // $599
};

/** White-label add-on (cents/month) */
export const WHITE_LABEL_CENTS = 14_900; // $149

/** Extra seat add-on (cents/month per seat) */
export const EXTRA_SEAT_CENTS = 3_500; // $35

/** Base included seats */
export const INCLUDED_SEATS = 2;

/** Free trial: max activated debt cases without Stripe subscription. */
export const TRIAL_MAX_ACTIVE_CASES = Number(process.env.TRIAL_MAX_ACTIVE_CASES) || 10;

/** Free trial duration in days from subscription created_at (or tenant signup). */
export const TRIAL_DURATION_DAYS = Number(process.env.TRIAL_DURATION_DAYS) || 30;

/**
 * Billing estimate for Settings → Billing: `stripe` matches Checkout (platform min fee + metered overage).
 * `tiers` uses historical UNIT_TIERS marginal pricing only (no Stripe).
 */
export const BILLING_ESTIMATE_MODE =
  (process.env.BILLING_ESTIMATE_MODE || 'tiers').toLowerCase() === 'stripe' ? 'stripe' : 'tiers';

/** Must match worker `STRIPE_INCLUDED_UNITS` and Stripe metered semantics. */
export const STRIPE_METERED_INCLUDED_UNITS = Number(process.env.STRIPE_INCLUDED_UNITS) || 200;

/**
 * Cents per PMS unit on metered overage — align with Stripe Price for `pms_units_metered`.
 */
export const STRIPE_METERED_RATE_CENTS = Number(process.env.STRIPE_METERED_RATE_CENTS) || 150;
