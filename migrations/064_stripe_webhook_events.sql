-- Migration: Stripe webhook event idempotency log
CREATE TABLE stripe_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_event_id VARCHAR(128) NOT NULL,
    stripe_mode VARCHAR(8) NOT NULL CHECK (stripe_mode IN ('test', 'live')),
    type VARCHAR(120) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX uq_stripe_webhook_events_event_mode
  ON stripe_webhook_events(stripe_event_id, stripe_mode);

COMMENT ON TABLE stripe_webhook_events IS
  'Processed Stripe event IDs to ensure webhook idempotency (test vs live).';

