-- Migration: Stripe customer + subscription linkage (per tenant)
-- Description: Store Stripe IDs for customer/subscription and key subscription items.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_stripe_customer_id
  ON tenants(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id <> '';

ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS stripe_platform_item_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS stripe_units_item_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS stripe_calls_item_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS stripe_wl_item_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS stripe_seats_item_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_subscriptions_stripe_subscription_id
  ON tenant_subscriptions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id <> '';

COMMENT ON COLUMN tenants.stripe_customer_id IS 'Stripe customer id (cus_...) for this tenant billing account.';
COMMENT ON COLUMN tenant_subscriptions.stripe_subscription_id IS 'Stripe subscription id (sub_...) for tenant plan.';
COMMENT ON COLUMN tenant_subscriptions.stripe_platform_item_id IS 'Stripe subscription item for platform base fee.';
COMMENT ON COLUMN tenant_subscriptions.stripe_units_item_id IS 'Stripe subscription item for metered PMS units.';
COMMENT ON COLUMN tenant_subscriptions.stripe_calls_item_id IS 'Stripe subscription item for AI calls plan (flat).';
COMMENT ON COLUMN tenant_subscriptions.stripe_wl_item_id IS 'Stripe subscription item for white-label add-on.';
COMMENT ON COLUMN tenant_subscriptions.stripe_seats_item_id IS 'Stripe subscription item for extra seats add-on.';
COMMENT ON COLUMN tenant_subscriptions.current_period_start IS 'Stripe current_period_start (synced from subscription).';
COMMENT ON COLUMN tenant_subscriptions.current_period_end IS 'Stripe current_period_end (synced from subscription).';

