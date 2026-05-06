-- Migration: Stripe billing price catalog (DB-backed price_... IDs per environment)
-- Description: Maps stable billing_key → Stripe Price ID for test vs live. No secrets here.

CREATE TABLE stripe_billing_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    billing_key VARCHAR(64) NOT NULL,
    stripe_mode VARCHAR(8) NOT NULL CHECK (stripe_mode IN ('test', 'live')),
    stripe_price_id VARCHAR(255) NOT NULL,
    label VARCHAR(200),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_stripe_billing_prices_key_mode UNIQUE (billing_key, stripe_mode)
);

CREATE INDEX idx_stripe_billing_prices_mode_active
    ON stripe_billing_prices (stripe_mode, active);

CREATE INDEX idx_stripe_billing_prices_key
    ON stripe_billing_prices (billing_key);

CREATE TRIGGER update_stripe_billing_prices_updated_at
    BEFORE UPDATE ON stripe_billing_prices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE stripe_billing_prices IS
    'Catalog of Stripe Price IDs (price_...) keyed by billing_key; scope test vs live via stripe_mode.';

-- Example seed (replace price_... after creating Prices in Stripe):
-- INSERT INTO stripe_billing_prices (billing_key, stripe_mode, stripe_price_id, label) VALUES
-- ('platform_base', 'test', 'price_...', 'Platform base'),
-- ('pms_units_metered', 'test', 'price_...', 'PMS units metered'),
-- ('calls_none', 'test', 'price_...', 'AI calls none'),
-- ('calls_starter', 'test', 'price_...', 'AI calls starter'),
-- ('calls_growth', 'test', 'price_...', 'AI calls growth'),
-- ('calls_pro', 'test', 'price_...', 'AI calls pro'),
-- ('white_label', 'test', 'price_...', 'White-label'),
-- ('seat_extra', 'test', 'price_...', 'Extra seat');
-- Repeat with stripe_mode = 'live' and live price IDs for production.
